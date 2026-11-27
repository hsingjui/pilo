import {
	type Accessor,
	cleanup,
	computed,
	context,
	Overlay,
	safeArea,
	signal,
	type Signal,
	Text,
	token,
	windowSize,
} from "nsh";

import { resolveToastOverlayLayout } from "@shared/mobile-viewport";

import { Button } from "../ui/button";
import { Toast } from "../ui/toast";
import { type ToastEntry, ToastManager, ToastStack } from "../ui/toast-stack";
import { t } from "./i18n";

export interface AppToast {
	variant?: "default" | "success" | "info" | "warning" | "error";
	title: string;
	description?: string;
	/** Optional countdown formatter; updates the description each second while active. */
	countdown?: (secondsLeft: number) => string;
	action?: { label: string; onPress: () => void };
	/** Triggered when the toast expires or is dismissed without clicking `action`. */
	onDismiss?: () => void;
	/** Milliseconds it shows; Sonner's 4s without it. */
	timeout?: number;
}

// Sonner's defaults, as React's global `Toaster`.
const DEFAULT_TIMEOUT_MS = 4_000;
const VISIBLE_TOASTS = 3;
let sequence = 0;

/**
 * The app's toasts (React's global Sonner): copy results, fork outcomes and
 * settings errors push here; `AppToastStack` shows them.
 */
export class AppToasts {
	private readonly manager = new ToastManager();
	// ToastManager stores JSON, so callbacks must stay on the JS side.
	private readonly actions = new Map<string, () => void>();
	private readonly countdowns = new Map<
		string,
		{
			format: (secondsLeft: number) => string;
			remainingMs: number;
			present: boolean;
			seconds: Signal<number>;
		}
	>();
	private readonly dismissCallbacks = new Map<string, () => void>();
	private readonly current = signal<ToastEntry[]>([]);
	private readonly expanded = signal(false);
	private timer: ReturnType<typeof setInterval> | null = null;
	private lastAdvanceAt = performance.now();
	private disposed = false;

	show({ action, countdown, onDismiss, ...toast }: AppToast): string | null {
		// A settings request can finish after its dialog closes.
		if (this.disposed) return null;
		const id = `toast-${++sequence}`;
		const timeout = toast.timeout ?? DEFAULT_TIMEOUT_MS;
		if (action) this.actions.set(id, action.onPress);
		if (countdown && Number.isFinite(timeout) && timeout > 0) {
			this.countdowns.set(id, {
				format: countdown,
				remainingMs: timeout,
				present: false,
				seconds: signal(Math.ceil(timeout / 1_000)),
			});
		}
		if (onDismiss) this.dismissCallbacks.set(id, onDismiss);
		const value = action ? { ...toast, actionLabel: action.label } : toast;
		// Counted toasts use the same clock for their label and dismissal.
		this.manager.push(id, value, {
			timeout: this.countdowns.has(id) ? null : timeout,
		});
		this.tick();
		return id;
	}

	dismiss(id: string): void {
		this.actions.delete(id);
		const onDismiss = this.dismissCallbacks.get(id);
		this.dismissCallbacks.delete(id);
		const countdown = this.countdowns.get(id);
		if (countdown) countdown.present = false;
		this.manager.dismiss(id);
		this.tick();
		onDismiss?.();
	}

	performAction(id: string): void {
		const action = this.actions.get(id);
		if (!action) return;
		this.dismissCallbacks.delete(id);
		this.dismiss(id);
		action();
	}

	/** The newest toasts and the ones leaving, oldest first. */
	entries(): ToastEntry[] {
		return this.current();
	}

	descriptionFor(id: string, fallback?: string): string | undefined {
		const countdown = this.countdowns.get(id);
		if (!countdown) return fallback;
		return countdown.format(countdown.seconds());
	}

	setExpanded(expanded: boolean): void {
		this.expanded.set(expanded);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
		this.actions.clear();
		this.countdowns.clear();
		this.dismissCallbacks.clear();
		this.manager.dispose();
	}

	private advance(): boolean {
		const now = performance.now();
		const elapsed = now - this.lastAdvanceAt;
		this.lastAdvanceAt = now;
		const paused = this.expanded();
		const { changed, presented, ending, removed } =
			this.manager.advance(paused);
		let expired = false;
		if (!paused) {
			for (const [id, countdown] of this.countdowns) {
				if (!countdown.present) continue;
				countdown.remainingMs -= elapsed;
				if (countdown.remainingMs <= 0) {
					countdown.present = false;
					if (this.manager.dismiss(id)) {
						ending.push(id);
						expired = true;
					}
				} else {
					const seconds = Math.ceil(countdown.remainingMs / 1_000);
					if (seconds !== countdown.seconds()) countdown.seconds.set(seconds);
				}
			}
		}
		for (const id of presented) {
			const countdown = this.countdowns.get(id);
			if (countdown) countdown.present = true;
		}
		for (const id of ending) {
			this.actions.delete(id);
			const onDismiss = this.dismissCallbacks.get(id);
			this.dismissCallbacks.delete(id);
			onDismiss?.();
		}
		for (const entry of removed) {
			this.countdowns.delete(entry.id);
		}
		return changed || expired;
	}

	// The lifecycle advances on a timer only while a toast is mounted.
	private tick(): void {
		this.advance();
		this.current.set(this.manager.visible(VISIBLE_TOASTS));
		if (this.manager.isEmpty()) {
			if (this.timer !== null) clearInterval(this.timer);
			this.timer = null;
		} else if (this.timer === null) {
			this.timer = setInterval(() => {
				if (this.advance()) {
					this.current.set(this.manager.visible(VISIBLE_TOASTS));
				}
				if (this.manager.isEmpty() && this.timer !== null) {
					clearInterval(this.timer);
					this.timer = null;
				}
			}, 16);
		}
	}
}

/** The nearest window or dialog's toasts; without a provider, a warning. */
export const AppToaster = context<AppToasts | null>(null);

/** Shows a toast through the nearest `AppToaster`. */
export function showToast(toasts: AppToasts | null, toast: AppToast): void {
	if (toasts) toasts.show(toast);
	else console.warn("No toaster for", toast.title);
}

export interface AppToastStackProps {
	toasts: AppToasts;
	/** Touch/mobile presentation: safe-area aware, responsive width, visible close button, upward swipe dismiss. */
	touch?: boolean;
	/** Override top safe-area inset (e.g. `MobileViewport().safeAreaTop`). */
	topInset?: Accessor<number> | number;
}

/** The stack at the window's top center, as React's Sonner. */
export function AppToastStack(props: AppToastStackProps) {
	const { toasts } = props;
	const layout = computed(
		() => {
			const size = windowSize();
			const insets = safeArea();
			const topInset =
				typeof props.topInset === "function"
					? props.topInset()
					: (props.topInset ?? insets.top);
			return resolveToastOverlayLayout({
				viewportWidth: size.width,
				safeAreaTop: topInset,
				safeAreaLeft: insets.left,
				safeAreaRight: insets.right,
				touch: Boolean(props.touch),
			});
		},
		{
			equals: (previous, next) =>
				previous.top === next.top &&
				previous.left === next.left &&
				previous.width === next.width,
		},
	);
	cleanup(() => toasts.dispose());
	return (
		<>
			{() =>
				toasts.entries().length > 0 ? (
					<Overlay
						testID="app-toast-overlay"
						style={{
							top: layout().top,
							left: layout().left,
							width: layout().width,
							zIndex: token("z-toast"),
						}}
					>
						<ToastStack
							class="w-full"
							onExpandedChange={({ expanded }) => toasts.setExpanded(expanded)}
							onCancel={() => {
								const newest = toasts.entries().at(-1);
								if (newest) toasts.dismiss(newest.id);
							}}
						>
							<Each of={toasts.entries()} key={(entry) => entry.id}>
								{(entry) => {
									const toast = entry().value as Omit<AppToast, "action"> & {
										actionLabel?: string;
									};
									return (
										<Toast
											testID={`app-toast-${entry().id}`}
											touch={props.touch}
											transitionStatus={entry().status}
											variant={toast.variant}
											description={toasts.descriptionFor(
												entry().id,
												toast.description,
											)}
											action={
												toast.actionLabel && (
													<Button
														testID={`app-toast-action-${entry().id}`}
														class={
															props.touch
																? "shrink-0 min-h-10 rounded-(--pilo-mobile-radius-lg) px-3.5"
																: "shrink-0 h-7 rounded-(--pilo-radius-lg) px-2.5"
														}
														size="sm"
														variant="default"
														disabled={entry().status === "ending"}
														accessibilityLabel={toast.actionLabel}
														onPress={() => toasts.performAction(entry().id)}
													>
														<Text class="font-sans font-medium text-xs text-(length:--pilo-ui-text-xs)">
															{toast.actionLabel}
														</Text>
													</Button>
												)
											}
											accessibilityLabel={toast.title}
											closeLabel={t("common.close")}
											onDismissRequest={() => toasts.dismiss(entry().id)}
										>
											<Text class="font-sans font-medium text-sm text-(length:--pilo-ui-text-sm) leading-snug text-popover-foreground">
												{toast.title}
											</Text>
										</Toast>
									);
								}}
							</Each>
						</ToastStack>
					</Overlay>
				) : null
			}
		</>
	);
}

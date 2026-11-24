import { cleanup, context, Overlay, signal, Text, token } from "nsh";

import { Button } from "../ui/button";
import { Toast } from "../ui/toast";
import { type ToastEntry, ToastManager, ToastStack } from "../ui/toast-stack";
import { t } from "./i18n";

export interface AppToast {
	variant?: "default" | "success" | "info" | "warning" | "error";
	title: string;
	description?: string;
	action?: { label: string; onPress: () => void };
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
	private readonly current = signal<ToastEntry[]>([]);
	private readonly expanded = signal(false);
	private timer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	show({ action, ...toast }: AppToast): void {
		// A settings request can finish after its dialog closes.
		if (this.disposed) return;
		const id = `toast-${++sequence}`;
		if (action) this.actions.set(id, action.onPress);
		const value = action ? { ...toast, actionLabel: action.label } : toast;
		this.manager.push(id, value, {
			timeout: toast.timeout ?? DEFAULT_TIMEOUT_MS,
		});
		this.tick();
	}

	dismiss(id: string): void {
		this.actions.delete(id);
		this.manager.dismiss(id);
		this.tick();
	}

	performAction(id: string): void {
		const action = this.actions.get(id);
		if (!action) return;
		this.dismiss(id);
		action();
	}

	/** The newest toasts and the ones leaving, oldest first. */
	entries(): ToastEntry[] {
		return this.current();
	}

	setExpanded(expanded: boolean): void {
		this.expanded.set(expanded);
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) clearInterval(this.timer);
		this.timer = null;
		this.actions.clear();
		this.manager.dispose();
	}

	private advance(): boolean {
		const { changed, ending } = this.manager.advance(this.expanded());
		for (const id of ending) this.actions.delete(id);
		return changed;
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

/** The stack at the window's top center, as React's Sonner. */
export function AppToastStack(props: { toasts: AppToasts }) {
	const { toasts } = props;
	cleanup(() => toasts.dispose());
	return (
		<>
			{() =>
				toasts.entries().length > 0 ? (
					<Overlay
						class="top-5 left-1/2 -ml-48 w-96"
						style={{ zIndex: token("z-toast") }}
					>
						<ToastStack
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
											transitionStatus={entry().status}
											variant={toast.variant}
											description={toast.description}
											action={
												toast.actionLabel && (
													<Button
														class="mt-1 self-start"
														size="sm"
														variant="secondary"
														disabled={entry().status === "ending"}
														accessibilityLabel={toast.actionLabel}
														onPress={() => toasts.performAction(entry().id)}
													>
														<Text class="font-sans">{toast.actionLabel}</Text>
													</Button>
												)
											}
											accessibilityLabel={toast.title}
											closeLabel={t("common.close")}
											onDismissRequest={() => toasts.dismiss(entry().id)}
										>
											<Text class="font-sans">{toast.title}</Text>
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

import { cleanup, context, Overlay, signal, Text, token } from "nsh";

import { Toast } from "../ui/toast";
import { type ToastEntry, ToastManager, ToastStack } from "../ui/toast-stack";
import { t } from "./i18n";

export interface AppToast {
	variant?: "default" | "success" | "info" | "warning" | "error";
	title: string;
	description?: string;
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
	private readonly current = signal<ToastEntry[]>([]);
	private readonly expanded = signal(false);
	private timer: ReturnType<typeof setInterval> | null = null;
	private disposed = false;

	show(toast: AppToast): void {
		// A settings request can finish after its dialog closes.
		if (this.disposed) return;
		this.manager.push(`toast-${++sequence}`, toast, {
			timeout: toast.timeout ?? DEFAULT_TIMEOUT_MS,
		});
		this.tick();
	}

	dismiss(id: string): void {
		this.manager.dismiss(id);
		this.tick();
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
		this.manager.dispose();
	}

	// The lifecycle advances on a timer only while a toast is mounted.
	private tick(): void {
		this.manager.advance(this.expanded());
		this.current.set(this.manager.visible(VISIBLE_TOASTS));
		if (this.manager.isEmpty()) {
			if (this.timer !== null) clearInterval(this.timer);
			this.timer = null;
		} else if (this.timer === null) {
			this.timer = setInterval(() => {
				if (this.manager.advance(this.expanded()).changed) {
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
									const toast = entry().value as AppToast;
									return (
										<Toast
											testID={`app-toast-${entry().id}`}
											transitionStatus={entry().status}
											variant={toast.variant}
											description={toast.description}
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

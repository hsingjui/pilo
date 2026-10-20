import React from "react";
import { createRoot } from "react-dom/client";

import {
	initializeI18n,
	readStoredLocale,
	resolveInitialLocale,
	resources,
	i18n,
} from "@/i18n";
import { primeRuntimeEventChannel } from "@/lib/api/pi-runtime";
import { tightenTripleClickSelection } from "@/lib/dom-text-selection";
import { PreferencesProvider } from "@/lib/preferences-provider";
import { BootShellRemover } from "@/components/boot-shell-remover";
import { ThemeProvider } from "@/lib/theme-provider";
import { Button, Toaster } from "@/ui";

import "./index.css";

const DESKTOP_RUNTIME =
	typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function formatConsoleMessage(values: readonly unknown[]) {
	return values
		.map((value) => {
			if (value instanceof Error) return value.stack ?? value.message;
			if (typeof value === "string") return value;
			return String(value);
		})
		.join(" ");
}

async function installDesktopLogging() {
	const {
		attachLogger,
		error: logError,
		LogLevel,
		warn: logWarn,
	} = await import("@tauri-apps/plugin-log");
	const originalConsoleDebug = console.debug.bind(console);
	const originalConsoleError = console.error.bind(console);
	const originalConsoleInfo = console.info.bind(console);
	const originalConsoleLog = console.log.bind(console);
	const originalConsoleWarn = console.warn.bind(console);
	void attachLogger(({ level, message }) => {
		switch (level) {
			case LogLevel.Trace:
				originalConsoleLog(message);
				break;
			case LogLevel.Debug:
				originalConsoleDebug(message);
				break;
			case LogLevel.Info:
				originalConsoleInfo(message);
				break;
			case LogLevel.Warn:
				originalConsoleWarn(message);
				break;
			case LogLevel.Error:
				originalConsoleError(message);
				break;
		}
	}).catch(() => undefined);

	console.error = (...values) => {
		originalConsoleError(...values);
		const message = formatConsoleMessage(values);
		if (!message) return;
		void logError(message).catch(() => undefined);
	};
	console.warn = (...values) => {
		originalConsoleWarn(...values);
		const message = formatConsoleMessage(values);
		if (!message) return;
		void logWarn(message).catch(() => undefined);
	};
}

function installGlobalErrorLogging() {
	window.addEventListener("error", (event) => {
		const error: unknown = event.error;
		console.error("Uncaught frontend error", error ?? event.message);
	});
	window.addEventListener("unhandledrejection", (event) => {
		const reason: unknown = event.reason;
		console.error("Unhandled promise rejection", reason);
	});
}

function disableBrowserContextMenu() {
	if (import.meta.env.DEV) return;
	window.addEventListener(
		"contextmenu",
		(event) => {
			const target = event.target;
			const keepNativeMenu =
				target instanceof Element &&
				target.closest("input, textarea, [contenteditable], a[href]");
			if (keepNativeMenu) return;
			if (window.getSelection()?.isCollapsed === false) return;
			event.preventDefault();
		},
		true,
	);
}

/** 全局兜底：渲染期崩溃时给出可恢复的错误页，而不是白屏。 */
class RootErrorBoundary extends React.Component<
	{ children: React.ReactNode },
	{ error: Error | null }
> {
	state = { error: null as Error | null };

	static getDerivedStateFromError(error: unknown) {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	componentDidCatch(error: Error) {
		console.error(error);
	}

	render() {
		const { error } = this.state;
		if (error) {
			return (
				<div className="flex h-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
					<BootShellRemover />
					<p className="text-lg font-medium text-foreground">
						{i18n.t("app.interfaceError")}
					</p>
					<p className="max-w-md text-sm text-muted-foreground">
						{error.message || i18n.t("app.unexpectedError")}
					</p>
					<div className="flex gap-2">
						<button
							type="button"
							className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-accent"
							onClick={() => this.setState({ error: null })}
						>
							{i18n.t("common.retry")}
						</button>
						<button
							type="button"
							className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-accent"
							onClick={() => window.location.reload()}
						>
							{i18n.t("app.reload")}
						</button>
					</div>
				</div>
			);
		}
		return this.props.children;
	}
}

function BootstrapErrorFallback() {
	const locale = resolveInitialLocale(readStoredLocale(), navigator.language);
	// Startup can fail before i18n initializes; bundled copy is always available.
	const { app, common } = resources[locale].translation;
	React.useLayoutEffect(() => {
		// Error recovery must not wait for fonts or the normal app readiness signal.
		document.getElementById("pilo-boot-shell")?.remove();
	}, []);
	return (
		<div
			role="alert"
			className="flex h-dvh flex-col items-center justify-center gap-4 overflow-y-auto bg-background p-8 text-center"
		>
			<p className="text-lg font-medium text-foreground">{common.loadFailed}</p>
			<p className="max-w-md text-sm text-muted-foreground">
				{app.unexpectedError}
			</p>
			<Button
				type="button"
				variant="outline"
				className="min-h-11"
				onClick={() => window.location.reload()}
			>
				{app.reload}
			</Button>
		</div>
	);
}

async function bootstrap() {
	if (!DESKTOP_RUNTIME) {
		document.documentElement.setAttribute("data-remote-webui", "");
	}
	const locale = resolveInitialLocale(
		readStoredLocale(),
		typeof navigator === "undefined" ? undefined : navigator.language,
	);
	await initializeI18n(locale);
	document.addEventListener("mousedown", tightenTripleClickSelection);
	document.addEventListener("mouseup", tightenTripleClickSelection);

	let RootApp: React.ComponentType;
	if (DESKTOP_RUNTIME) {
		disableBrowserContextMenu();
		primeRuntimeEventChannel();
		const [{ default: App }, { installDesktopTrayLabels }] = await Promise.all([
			import("./App"),
			import("@/lib/desktop-integration"),
			installDesktopLogging(),
		]);
		installDesktopTrayLabels();
		RootApp = App;
		if (import.meta.env.DEV) {
			const [
				{ installChatPerformanceDebugApi },
				{ installChatRuntimeTraceDebugApi },
			] = await Promise.all([
				import("@/lib/chat/chat-performance-debug"),
				import("@/lib/chat/chat-runtime-trace-debug"),
			]);
			installChatRuntimeTraceDebugApi();
			installChatPerformanceDebugApi();
		}
	} else {
		RootApp = (await import("@/remote/remote-app")).RemoteApp;
	}

	root.render(
		<React.StrictMode>
			<RootErrorBoundary>
				<ThemeProvider>
					<PreferencesProvider>
						<RootApp />
						<Toaster
							offset={{
								bottom: "calc(24px + env(safe-area-inset-bottom))",
							}}
							mobileOffset={{
								bottom: "calc(16px + env(safe-area-inset-bottom))",
							}}
						/>
					</PreferencesProvider>
				</ThemeProvider>
			</RootErrorBoundary>
		</React.StrictMode>,
	);
}

const root = createRoot(document.getElementById("root") as HTMLElement);

installGlobalErrorLogging();
void bootstrap().catch((error: unknown) => {
	console.error("Failed to bootstrap frontend", error);
	root.render(<BootstrapErrorFallback />);
});

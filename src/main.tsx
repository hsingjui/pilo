import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
	attachLogger,
	error as logError,
	LogLevel,
	warn as logWarn,
} from "@tauri-apps/plugin-log";

import App from "./App";
import {
	initializeI18n,
	readStoredLocale,
	resolveInitialLocale,
	i18n,
} from "@/i18n";
import { installChatPerformanceDebugApi } from "@/lib/chat-performance-debug";
import { installChatRuntimeTraceDebugApi } from "@/lib/chat-runtime-trace-debug";
import { primeRuntimeEventChannel } from "@/lib/pi-runtime";
import { PreferencesProvider } from "@/lib/preferences-provider";
import { ThemeProvider } from "@/lib/theme-provider";
import { Toaster } from "@/ui";

import "./index.css";

function formatConsoleMessage(values: readonly unknown[]) {
	return values
		.map((value) => {
			if (value instanceof Error) return value.stack ?? value.message;
			if (typeof value === "string") return value;
			return String(value);
		})
		.join(" ");
}

function installDesktopLogging() {
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

/**
 * WebView2/WKWebView 的默认右键菜单在桌面壳里只剩「刷新 / 另存为 / 打印 / 更多工具」
 * 这类浏览器遗留项，release 下去掉。输入框、链接和已选中的文本放行，否则复制粘贴也没了。
 * 开发构建保留原菜单，方便调试。
 */
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

installDesktopLogging();
disableBrowserContextMenu();
installChatRuntimeTraceDebugApi();
installChatPerformanceDebugApi();
primeRuntimeEventChannel();

function BootShellRemover() {
	useEffect(() => {
		const frame = window.requestAnimationFrame(() => {
			document.getElementById("pilo-boot-shell")?.remove();
		});
		return () => window.cancelAnimationFrame(frame);
	}, []);
	return null;
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

async function bootstrap() {
	const locale = resolveInitialLocale(
		readStoredLocale(),
		typeof navigator === "undefined" ? undefined : navigator.language,
	);
	await initializeI18n(locale);
	createRoot(document.getElementById("root") as HTMLElement).render(
		<React.StrictMode>
			<RootErrorBoundary>
				<ThemeProvider>
					<PreferencesProvider>
						<App />
						<Toaster />
						<BootShellRemover />
					</PreferencesProvider>
				</ThemeProvider>
			</RootErrorBoundary>
		</React.StrictMode>,
	);
}

void bootstrap();

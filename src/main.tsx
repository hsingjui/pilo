import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { installChatPerformanceDebugApi } from "@/lib/chat-performance-debug";
import { installChatRuntimeTraceDebugApi } from "@/lib/chat-runtime-trace-debug";
import { PreferencesProvider } from "@/lib/preferences-provider";
import { ThemeProvider } from "@/lib/theme-provider";
import { Toaster } from "@/ui";

import "./index.css";

installChatRuntimeTraceDebugApi();
installChatPerformanceDebugApi();

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
					<p className="text-lg font-medium text-foreground">界面遇到了问题</p>
					<p className="max-w-md text-sm text-muted-foreground">
						{error.message || "发生了意外错误。"}
					</p>
					<div className="flex gap-2">
						<button
							type="button"
							className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-accent"
							onClick={() => this.setState({ error: null })}
						>
							重试
						</button>
						<button
							type="button"
							className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-accent"
							onClick={() => window.location.reload()}
						>
							重新加载
						</button>
					</div>
				</div>
			);
		}
		return this.props.children;
	}
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
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

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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<ThemeProvider>
			<PreferencesProvider>
				<App />
				<Toaster />
				<BootShellRemover />
			</PreferencesProvider>
		</ThemeProvider>
	</React.StrictMode>,
);

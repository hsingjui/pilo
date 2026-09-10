import React from "react";
import ReactDOM from "react-dom/client";

import App from "./App";
import { ThemeProvider } from "@/lib/theme-provider";
import { Toaster } from "@/ui";

import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<ThemeProvider>
			<App />
			<Toaster />
		</ThemeProvider>
	</React.StrictMode>,
);

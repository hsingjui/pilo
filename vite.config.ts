// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
	plugins: [react(), tailwindcss()],
	build: {
		rolldownOptions: {
			output: {
				// Split the eagerly-loaded entry bundle so no single chunk exceeds
				// Vite's 500 kB warning threshold. Heavy features (chat markdown,
				// terminal, editors) are already split via dynamic import.
				codeSplitting: {
					groups: [
						{
							name: "react",
							test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
						},
					],
				},
			},
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "./src"),
		},
	},

	// Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
	//
	// 1. prevent Vite from obscuring rust errors
	clearScreen: false,
	// 2. tauri expects a fixed port, fail if that port is not available
	server: {
		port: 1420,
		strictPort: true,
		host: host || false,
		hmr: host
			? {
					protocol: "ws",
					host,

					port: 1421,
				}
			: undefined,
		watch: {
			// 3. tell Vite to ignore watching `src-tauri` and the workspace target dir
			ignored: ["**/src-tauri/**", "**/target/**"],
		},
	},
}));

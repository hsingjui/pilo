// @ts-expect-error type error without @types/node package
import process from "node:process";
// @ts-expect-error type error without @types/node package
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(({ command }) => ({
	plugins: [
		react(),
		tailwindcss(),
		VitePWA({
			strategies: "injectManifest",
			srcDir: "src/remote",
			filename: "sw.js",
			injectRegister: false,
			manifest: false,
			injectManifest: {
				rollupFormat: "iife",
				injectionPoint: "self.PILO_PRECACHE_MANIFEST",
				globPatterns: [
					"index.html",
					"manifest.webmanifest",
					"pilo-*.png",
					"assets/{index,theme-presets}-*.css",
					// Group optional chunks so absent ones don't trigger unmatched-glob warnings.
					"assets/{index,remote-app,react,rolldown-runtime,utils,i18nInstance,core,bundle-mjs,draft-project-picker,use-pi-session-features,folder,wifi,send,trash,pencil,ellipsis,sessions}-*.js",
					"assets/inter-latin-*-normal-*.woff2",
					"assets/jetbrains-mono-latin-*-normal-*.woff2",
				],
				maximumFileSizeToCacheInBytes: 1024 * 1024,
			},
		}),
	],
	build: {
		rolldownOptions: {
			output: {
				// Keep React cached separately and avoid merging C++ grammar data
				// into one oversized optional chunk.
				codeSplitting: {
					groups: [
						{
							name: "react",
							test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
						},
						{
							name: "shiki-cpp-macro",
							test: /node_modules[\\/]@shikijs[\\/]langs[\\/]dist[\\/]cpp-macro\.mjs$/,
							// Shared SQL/GLSL/RegExp grammars must stay independently loadable.
							includeDependenciesRecursively: false,
						},
					],
				},
			},
		},
	},
	resolve: {
		alias: [
			{ find: "@", replacement: path.resolve(import.meta.dirname, "./src") },
			// Replace only the full bundle; preserve shiki/core and engine imports.
			{
				find: /^shiki$/,
				replacement: path.resolve(
					import.meta.dirname,
					"./src/lib/git-diff-shiki.ts",
				),
			},
			// Shiki accepts Vite's WASM initializer; avoid a base64 JS payload.
			...(command === "build"
				? [{ find: "shiki/wasm", replacement: "shiki/onig.wasm?init" }]
				: []),
		],
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

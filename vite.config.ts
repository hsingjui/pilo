// @ts-expect-error type error without @types/node package
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig(() => ({
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
					"assets/{index,remote-app,react,rolldown-runtime,utils,i18nInstance,core,bundle-mjs,draft-project-picker,folder,wifi,send,trash,pencil,ellipsis,sessions}-*.js",
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
		],
	},

	clearScreen: false,
	server: {
		// The browser regression pages are documented at this address.
		port: 1420,
		strictPort: true,
		watch: {
			// Cargo output under the workspace target dir is not a frontend input.
			ignored: ["**/target/**"],
		},
	},
}));

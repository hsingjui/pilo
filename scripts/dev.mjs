#!/usr/bin/env node
// Tauri dev only HMRs the desktop webview (from the Vite dev server).
// The Remote WebUI is served from `dist/` on disk, so we also run a Vite build
// in watch mode to keep `dist/` fresh for the embedded HTTP server.
import { spawn } from "node:child_process";
import process from "node:process";

const commands = [
	["exec", "vite", "build", "--watch"],
	["tauri", "dev", "--features", "webdriver"],
];

const children = commands.map((args) =>
	spawn("pnpm", args, {
		stdio: "inherit",
		shell: process.platform === "win32",
	}),
);

let closing = false;
function shutdown(code) {
	if (closing) return;
	closing = true;
	for (const child of children) child.kill();
	process.exit(code);
}

for (const child of children) {
	child.on("exit", (code) => shutdown(code ?? 0));
	child.on("error", () => shutdown(1));
}
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => shutdown(0));
}

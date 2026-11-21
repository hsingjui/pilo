#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const children = [];
let closing = false;

function isRunning(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH means the process is already gone, EPERM that it exists but is owned by someone else.
		return error.code === "EPERM";
	}
}

function shutdown(code) {
	if (closing) return;
	closing = true;
	for (const child of children) {
		if (!child.pid) continue;
		if (process.platform === "win32") {
			if (child.exitCode !== null || child.signalCode !== null) continue;
			// Stop descendants as well as the Node launcher.
			const result = spawnSync(
				"taskkill.exe",
				["/PID", String(child.pid), "/T", "/F"],
				{
					stdio: "ignore",
					timeout: 5000,
				},
			);
			// Ctrl+C reaches every process on the console, so children are usually already
			// gone and taskkill exits with 128 ("no such process") by the time we get here.
			if (result.error || (result.status !== 0 && isRunning(child.pid))) {
				console.error(
					`Failed to stop dev process tree ${child.pid}`,
					result.error ?? result.status,
				);
			}
		} else {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch (error) {
				if (error.code !== "ESRCH") console.error(error);
			}
		}
	}
	process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => shutdown(0));
}

try {
	// The Host serves the WebUI from dist/; the Vite server hosts the browser tests.
	const vite = "node_modules/vite/bin/vite.js";
	const commands = [
		[process.execPath, root, vite],
		[process.execPath, root, vite, "build", "--watch"],
	];
	if (!process.argv.includes("--frontend")) {
		commands.push([
			"nsh",
			fileURLToPath(new URL("../desktop/", import.meta.url)),
			"dev",
		]);
	}
	for (const [command, cwd, ...args] of commands) {
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit",
			detached: process.platform !== "win32",
		});
		children.push(child);
		child.on("exit", (code) => shutdown(code ?? 1));
		child.on("error", (error) => {
			console.error(error);
			shutdown(1);
		});
	}
} catch (error) {
	console.error("[pilo-dev] Startup failed:", error);
	shutdown(1);
}

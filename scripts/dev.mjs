#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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
			const result = spawnSync(
				"taskkill.exe",
				["/PID", String(child.pid), "/T", "/F"],
				{
					stdio: "ignore",
					timeout: 5000,
				},
			);
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
	const webOnly = process.argv.includes("--web");
	if (!webOnly && !fs.existsSync(path.join(root, "dist", "index.html"))) {
		const built = spawnSync(
			process.execPath,
			[path.join(root, "scripts", "build-nsh-web.mjs")],
			{ cwd: root, stdio: "inherit" },
		);
		if (built.status !== 0) process.exit(built.status ?? 1);
	}

	const args = webOnly ? ["dev", "--target", "web", "web"] : ["dev"];
	const child = spawn("nsh", args, {
		cwd: root,
		stdio: "inherit",
		detached: process.platform !== "win32",
	});
	children.push(child);
	child.on("exit", (code) => shutdown(code ?? 1));
	child.on("error", (error) => {
		console.error(error);
		shutdown(1);
	});
} catch (error) {
	console.error("[pilo-dev] Startup failed:", error);
	shutdown(1);
}

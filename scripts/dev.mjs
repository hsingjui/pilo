#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const children = new Set();
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

function start(command, args, onExit = shutdown, onStdoutLine) {
	const child = spawn(command, args, {
		cwd: root,
		stdio: onStdoutLine ? ["inherit", "pipe", "inherit"] : "inherit",
		detached: process.platform !== "win32",
	});
	children.add(child);
	if (onStdoutLine) {
		createInterface({ input: child.stdout }).on("line", onStdoutLine);
	}
	// Cargo's artifact stream must be drained before using the reported paths.
	child.on(onStdoutLine ? "close" : "exit", (code) => {
		children.delete(child);
		if (!closing) onExit(code ?? 1);
	});
	child.on("error", (error) => {
		console.error(error);
		shutdown(1);
	});
}

function startDesktopWithWeb() {
	let timer;
	let building = false;
	let pending = false;
	let desktopStarted = false;

	const rebuild = () => {
		if (building) {
			pending = true;
			return;
		}
		building = true;
		pending = false;
		start(
			process.execPath,
			[path.join(root, "scripts", "build-nsh-web.mjs"), "--dev"],
			(code) => {
				building = false;
				if (code !== 0) {
					if (!desktopStarted) {
						shutdown(code);
						return;
					}
					console.error(
						"[pilo-dev] WebUI build failed; keeping the last build.",
					);
				} else if (!desktopStarted) {
					desktopStarted = true;
					start("nsh", ["dev"]);
				}
				if (pending) rebuild();
			},
		);
	};

	const ignored = new Set([".nsh", "node_modules", "target"]);
	for (const dir of ["web", "app", "shared", "theme"]) {
		const watcher = fs.watch(
			path.join(root, dir),
			{ recursive: true },
			(_event, filename) => {
				if (filename?.split(/[\\/]/).some((part) => ignored.has(part))) return;
				clearTimeout(timer);
				timer = setTimeout(rebuild, 150);
			},
		);
		watcher.on("error", (error) => {
			console.error("[pilo-dev] WebUI watcher failed:", error);
			shutdown(1);
		});
	}
	rebuild();
}

try {
	if (process.argv.includes("--web")) {
		start("nsh", ["dev", "--target", "web", "web"]);
	} else {
		const cargoArgs = ["build", "--message-format=json-render-diagnostics"];
		const buildServer = !process.env.PILO_SERVER_BINARY;
		const buildCli = !process.env.PILO_CLI_BINARY;
		if (buildServer) cargoArgs.push("-p", "pilo-server");
		if (buildCli) cargoArgs.push("-p", "pilo-cli");
		const artifacts = new Map();
		if (buildServer || buildCli) {
			const code = await new Promise((resolve) => {
				start("cargo", cargoArgs, resolve, (line) => {
					let message;
					try {
						message = JSON.parse(line);
					} catch {
						console.log(line);
						return;
					}
					if (
						message?.reason === "compiler-artifact" &&
						message.executable &&
						message.target.kind.includes("bin")
					) {
						artifacts.set(message.target.name, message.executable);
					}
				});
			});
			if (code !== 0) shutdown(code);
		}
		if (buildServer) {
			const server = artifacts.get("pilo-server");
			if (!server)
				throw new Error("Cargo did not report a pilo-server executable");
			process.env.PILO_SERVER_BINARY = server;
		}
		if (buildCli) {
			let cli = artifacts.get("pilo");
			if (!cli) throw new Error("Cargo did not report a pilo executable");
			if (process.platform === "win32") {
				// The Windows installer adds the CLI's directory to PATH, not a link.
				const binDir = path.join(root, "target", "debug", "pilo-cli-bin");
				const staged = path.join(binDir, "pilo-dev.exe");
				fs.mkdirSync(binDir, { recursive: true });
				fs.copyFileSync(cli, staged);
				cli = staged;
			}
			process.env.PILO_CLI_BINARY = cli;
		}
		startDesktopWithWeb();
	}
} catch (error) {
	console.error("[pilo-dev] Startup failed:", error);
	shutdown(1);
}

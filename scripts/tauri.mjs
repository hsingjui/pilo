#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import tauri from "@tauri-apps/cli";
import process from "node:process";

const args = process.argv.slice(2);

try {
	if (args[0] === "dev" && !args.includes("--help") && !args.includes("-h")) {
		if (
			args.some(
				(arg) =>
					arg === "--release" ||
					arg === "--profile" ||
					arg.startsWith("--profile="),
			)
		) {
			throw new Error(
				"Development runtime isolation requires the default debug profile; use pnpm tauri build for release builds.",
			);
		}
		// The debug GUI embeds the stdio Server, but ctl needs a real console
		// executable on Windows. Build it alongside pilo.exe; no manual install.
		if (process.platform === "win32") {
			const targetIndex = args.indexOf("--target");
			const target =
				targetIndex >= 0
					? args[targetIndex + 1]
					: args
							.find((arg) => arg.startsWith("--target="))
							?.slice("--target=".length);
			const result = spawnSync(
				"cargo",
				[
					"build",
					"-p",
					"pilo-server",
					"--bin",
					"pilo-server",
					...(target ? ["--target", target] : []),
				],
				{
					cwd: fileURLToPath(new URL("../", import.meta.url)),
					stdio: "inherit",
					windowsHide: true,
				},
			);
			if (result.error || result.status !== 0)
				throw new Error("Failed to build Windows Pilo ctl runtime", {
					cause: result.error,
				});
		}
		args.splice(1, 0, "--config", "src-tauri/tauri.dev.conf.json");
	}
	await tauri.run(args, "pnpm tauri");
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}

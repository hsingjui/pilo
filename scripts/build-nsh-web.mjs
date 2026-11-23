#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const webDir = path.join(root, "web");
const outDir = path.join(root, "dist");
const stagingDir = path.join(root, ".nsh", "web-out");

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

const result = spawnSync(
	"nsh",
	["package", "--target", "web", "--out", stagingDir, "."],
	{
		cwd: webDir,
		stdio: "inherit",
	},
);

if (result.error) {
	console.error("[build-web] Failed to run nsh:", result.error);
	process.exit(1);
}
if (result.status !== 0) {
	process.exit(result.status ?? 1);
}

// `nsh package --target web` writes into `<stagingDir>/<appName>/` (e.g. `Pilo/`).
function findSiteRoot(dir) {
	if (fs.existsSync(path.join(dir, "index.html"))) return dir;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = path.join(dir, entry.name);
		if (fs.existsSync(path.join(candidate, "index.html"))) return candidate;
	}
	return null;
}

const sourceDir = findSiteRoot(stagingDir);
if (!sourceDir) {
	console.error(
		`[build-web] Expected index.html under ${stagingDir}, found:`,
		fs.readdirSync(stagingDir),
	);
	process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(outDir), { recursive: true });
fs.cpSync(sourceDir, outDir, { recursive: true });
console.log(`[build-web] Built nsh Web bundle into ${outDir}`);

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function writeGenerated(file, data, command) {
	const output = JSON.stringify(data, null, "\t") + "\n";
	const args = process.argv.slice(2);
	if (args.length === 0) {
		writeFileSync(file, output);
		return;
	}
	if (args.length !== 1 || args[0] !== "--check") {
		throw new Error(`Usage: ${command} [--check]`);
	}
	let current;
	try {
		current = readFileSync(file, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (current !== output) {
		console.error(`${fileURLToPath(file)} is stale; run ${command}`);
		process.exitCode = 1;
	}
}

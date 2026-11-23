// Resolves `@shared/*` and extensionless relative `.ts` imports for Node's native test runner.
import { statSync } from "node:fs";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const SHARED = pathToFileURL(`${process.cwd()}/shared/`);
const CANDIDATES = ["", ".ts", "/index.ts"];

const isFile = (path) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

export async function resolve(specifier, context, nextResolve) {
	let base;
	if (specifier.startsWith("@shared/")) {
		base = new URL(specifier.slice("@shared/".length), SHARED);
	} else if (specifier.startsWith(".")) {
		base = new URL(specifier, context.parentURL);
	} else {
		return nextResolve(specifier, context);
	}
	for (const suffix of CANDIDATES) {
		const candidate = new URL(`${base.href}${suffix}`);
		if (isFile(fileURLToPath(candidate))) {
			return nextResolve(candidate.href, context);
		}
	}
	return nextResolve(specifier, context);
}

if (isMainThread) register(import.meta.url);

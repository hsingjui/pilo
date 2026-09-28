// node --experimental-strip-types 既不认识 JSX，也不认 "@/..." 别名。
// 这个 loader 只补这两件事：把 "@/x" 映射到 src/x，用已装好的 typescript 转译 .tsx。
// 纯 .ts 仍交给 node 自带的类型擦除，本 loader 不碰。
import { statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import ts from "typescript";

const SRC = pathToFileURL(`${process.cwd()}/src/`);
const CANDIDATES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

const isFile = (path) => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

export async function resolve(specifier, context, nextResolve) {
	let base;
	if (specifier.startsWith("@/")) base = new URL(specifier.slice(2), SRC);
	else if (specifier.startsWith("."))
		base = new URL(specifier, context.parentURL);
	else return nextResolve(specifier, context);
	for (const suffix of CANDIDATES) {
		const candidate = new URL(`${base.href}${suffix}`);
		if (isFile(fileURLToPath(candidate))) {
			return nextResolve(candidate.href, context);
		}
	}
	// 非源码资源（css/资源文件等）交回给 node 自己处理
	return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
	if (!url.endsWith(".tsx")) return nextLoad(url, context);
	const source = await readFile(new URL(url), "utf8");
	const { outputText } = ts.transpileModule(source, {
		fileName: url,
		compilerOptions: {
			jsx: ts.JsxEmit.ReactJSX,
			module: ts.ModuleKind.ESNext,
			target: ts.ScriptTarget.ES2022,
		},
	});
	return { format: "module", source: outputText, shortCircuit: true };
}

if (isMainThread) register(import.meta.url);

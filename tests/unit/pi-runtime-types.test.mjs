import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("runtime wire payloads and the conversation adapter type-check without browser or framework types", () => {
	const root = fileURLToPath(new URL("../../", import.meta.url));
	const program = ts.createProgram(
		[
			fileURLToPath(
				new URL("../helpers/pi-runtime-event-fixtures.ts", import.meta.url),
			),
			fileURLToPath(
				new URL(
					"../../shared/chat/conversation-runtime-adapter.ts",
					import.meta.url,
				),
			),
		],
		{
			target: ts.ScriptTarget.ES2022,
			lib: ["lib.es2022.d.ts"],
			module: ts.ModuleKind.ESNext,
			moduleResolution: ts.ModuleResolutionKind.Bundler,
			allowImportingTsExtensions: true,
			noEmit: true,
			strict: true,
			types: [],
			paths: { "@shared/*": [`${root}shared/*`] },
		},
	);

	const diagnostics = ts.getPreEmitDiagnostics(program);
	assert.equal(
		diagnostics.length,
		0,
		ts.formatDiagnostics(diagnostics, {
			getCanonicalFileName: (path) => path,
			getCurrentDirectory: () => root,
			getNewLine: () => "\n",
		}),
	);
	assert.deepEqual(
		program
			.getSourceFiles()
			.filter((source) => program.isSourceFileFromExternalLibrary(source))
			.map((source) => source.fileName),
		[],
	);
});

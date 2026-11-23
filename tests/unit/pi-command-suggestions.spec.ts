import assert from "node:assert/strict";
import test from "node:test";

import type { PiCommand } from "../../shared/api/pi-runtime-types.ts";
import {
	createPiCommandSuggestions,
	createPiExtensionCommandNames,
	mergePiCommands,
	parseSlashCommand,
} from "../../shared/chat/pi-command-suggestions.ts";

function makeCommand(
	name: string,
	source: PiCommand["source"],
	overrides: Partial<PiCommand> = {},
): PiCommand {
	return {
		name,
		source,
		sourceInfo: {
			path: `/pi/${name}`,
			source,
			scope: "project",
			origin: "top-level",
		},
		...overrides,
	};
}

test("createPiCommandSuggestions filters reserved commands and marks skills", () => {
	const suggestions = createPiCommandSuggestions([
		makeCommand("new", "extension"),
		makeCommand("compact", "extension"),
		makeCommand("llama", "extension"),
		makeCommand("pilo_model_catalog", "extension"),
		makeCommand("skill:review", "skill", { description: "Review changes" }),
		makeCommand("plan", "prompt"),
		makeCommand("deploy", "extension", {
			sourceInfo: {
				path: "/ext/deploy.ts",
				source: "extension",
				scope: "user",
				origin: "top-level",
			},
		}),
	]);

	assert.deepEqual(suggestions, [
		{
			kind: "command",
			value: "/skill:review",
			label: "/skill:review",
			detail: "Review changes",
			skill: true,
		},
		{
			kind: "command",
			value: "/plan",
			label: "/plan",
			detail: "prompt · project",
			skill: false,
		},
		{
			kind: "command",
			value: "/deploy",
			label: "/deploy",
			detail: "extension · user",
			skill: false,
		},
	]);
});

test("createPiExtensionCommandNames returns only non-reserved extension names", () => {
	const names = createPiExtensionCommandNames([
		makeCommand("new", "extension"),
		makeCommand("llama", "extension"),
		makeCommand("pilo_model_catalog", "extension"),
		makeCommand("skill:review", "skill"),
		makeCommand("plan", "prompt"),
		makeCommand("deploy", "extension"),
	]);

	assert.deepEqual([...names], ["deploy"]);
});

test("mergePiCommands deduplicates by name with later sources winning", () => {
	const merged = mergePiCommands(
		[
			makeCommand("skill:review", "skill", { description: "Cached" }),
			makeCommand("plan", "prompt"),
		],
		[
			makeCommand("skill:review", "skill", { description: "Live" }),
			makeCommand("deploy", "extension", { description: "Deploy app" }),
		],
	);

	assert.deepEqual(
		merged.map((cmd) => [cmd.name, cmd.description]),
		[
			["skill:review", "Live"],
			["plan", undefined],
			["deploy", "Deploy app"],
		],
	);
});

test("parseSlashCommand parses leading slash commands and ignores non-commands", () => {
	assert.deepEqual(parseSlashCommand("/new"), {
		name: "new",
		args: "",
		raw: "/new",
	});
	assert.deepEqual(parseSlashCommand("/compact focus on tests  "), {
		name: "compact",
		args: "focus on tests",
		raw: "/compact focus on tests",
	});
	assert.deepEqual(parseSlashCommand("/skill:review \ncheck edge cases"), {
		name: "skill:review",
		args: "check edge cases",
		raw: "/skill:review \ncheck edge cases",
	});
	assert.equal(parseSlashCommand("/"), null);
	assert.equal(parseSlashCommand("/   "), null);
	assert.equal(parseSlashCommand("hello /new"), null);
	assert.equal(parseSlashCommand(" /new"), null);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
	getActivePiBranch,
	resolveAssistantForkTarget,
} from "../src/lib/pi-session-fork.ts";
import type { ChatMessage } from "../src/lib/conversation-types.ts";
import type { PiSessionEntries } from "../src/lib/pi-runtime.ts";
import { initializeI18n, i18n } from "../src/i18n/index.ts";

await initializeI18n("zh-CN");

function user(id: string, text: string): ChatMessage {
	return { id, role: "user", text, time: "" };
}

function assistant(id: string, text: string): ChatMessage {
	return {
		id,
		role: "assistant",
		text,
		time: "",
		completion: "complete",
	};
}

const sessionEntries: PiSessionEntries = {
	leafId: "a2",
	entries: [
		{ id: "u1", parentId: null, type: "message", message: { role: "user" } },
		{
			id: "a-abandoned",
			parentId: "u1",
			type: "message",
			message: { role: "assistant" },
		},
		{
			id: "a1",
			parentId: "u1",
			type: "message",
			message: { role: "assistant" },
		},
		{ id: "m1", parentId: "a1", type: "model_change" },
		{ id: "u2", parentId: "m1", type: "message", message: { role: "user" } },
		{
			id: "a2",
			parentId: "u2",
			type: "message",
			message: { role: "assistant" },
		},
	],
};

const messages = [
	user("ui-u1", "one"),
	assistant("ui-a1", "first"),
	user("ui-u2", "two"),
	assistant("ui-a2", "second"),
];

test("active Pi branch follows the leaf parent chain and ignores abandoned entries", () => {
	assert.deepEqual(
		getActivePiBranch(sessionEntries).map((entry) => entry.id),
		["u1", "a1", "m1", "u2", "a2"],
	);
});

test("historical assistant reply forks before the next user message", () => {
	assert.deepEqual(
		resolveAssistantForkTarget(messages, "ui-a1", sessionEntries),
		{ type: "fork", entryId: "u2" },
	);
});

test("latest assistant reply clones the current active branch", () => {
	assert.deepEqual(
		resolveAssistantForkTarget(messages, "ui-a2", sessionEntries),
		{ type: "clone" },
	);
});

test("fork target fails safely when UI history and Pi branch no longer align", () => {
	assert.throws(
		() =>
			resolveAssistantForkTarget(
				[...messages, user("ui-u3", "three"), assistant("ui-a3", "third")],
				"ui-a2",
				sessionEntries,
			),
		(error: unknown) =>
			error instanceof Error &&
			error.message === i18n.t("errors.forkBranchPointNotFound"),
	);
});

test("latest reply refuses to clone when Pi has a newer unseen user message", () => {
	const staleEntries: PiSessionEntries = {
		entries: [
			...sessionEntries.entries,
			{
				id: "u3",
				parentId: "a2",
				type: "message",
				message: { role: "user" },
			},
		],
		leafId: "u3",
	};
	assert.throws(
		() => resolveAssistantForkTarget(messages, "ui-a2", staleEntries),
		(error: unknown) =>
			error instanceof Error &&
			error.message === i18n.t("errors.sessionChanged"),
	);
});

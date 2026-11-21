import { mount, Storage, View } from "nsh";

import type { ConversationEvent } from "@shared/chat/conversation-types";
import { replayConversationEvents } from "@shared/chat/conversation-replay";
import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { ChatMessageList } from "../chat/chat-message-list";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { context, startedAt } from "./chat-conversation-fixture";

/**
 * The message list over a reply that worked before it answered: thinking,
 * a read, a narration, an edit with its diff and a command with how it
 * ended, then the final text. `fixture.scenario` picks the turn:
 *
 * - `settled`: the turn has ended; Host preferences at their defaults.
 * - `expanded`: the same turn with `collapseCompletedActivity` and
 *   `showWorkDuration` turned off.
 * - `running`: the turn is still running its command.
 * - `todos`: a settled turn that wrote a task list.
 * - `waiting`: a turn sent, nothing back yet.
 * - `thinking`: a turn still thinking.
 * - `answered`: a turn that only answered, in 5 seconds.
 * - `untimed`: `answered` with `showWorkDuration` turned off.
 */

const at = (seconds: number) => startedAt + seconds * 1000;

const prompt: ConversationEvent[] = [
	{ type: "user_message_start", text: "Bump x.", timestampMs: at(0) },
	{ type: "assistant_message_start", timestampMs: at(0) },
];

const work: ConversationEvent[] = [
	{ type: "assistant_thinking_start", timestampMs: at(1) },
	{
		type: "assistant_thinking_delta",
		delta: "Look at the file first.\nThen change x.",
		timestampMs: at(2),
	},
	{ type: "assistant_thinking_end", timestampMs: at(4) },
	{
		type: "tool_execution_start",
		toolCallId: "read-1",
		toolName: "read",
		args: { path: "src/main.ts" },
		timestampMs: at(5),
	},
	{
		type: "tool_execution_end",
		toolCallId: "read-1",
		toolName: "read",
		result: { content: [{ type: "text", text: "export const x = 1;" }] },
		isError: false,
		timestampMs: at(6),
	},
	{
		type: "assistant_text_delta",
		delta: "The file sets x to 1.",
		timestampMs: at(7),
	},
	{
		type: "tool_execution_start",
		toolCallId: "edit-1",
		toolName: "edit",
		args: { path: "src/main.ts", oldText: "x = 1", newText: "x = 2" },
		timestampMs: at(8),
	},
	{
		type: "tool_execution_end",
		toolCallId: "edit-1",
		toolName: "edit",
		result: {
			content: [{ type: "text", text: "Edited src/main.ts" }],
			details: { diff: "-export const x = 1;\n+export const x = 2;" },
		},
		isError: false,
		timestampMs: at(9),
	},
	{
		type: "tool_execution_start",
		toolCallId: "bash-1",
		toolName: "bash",
		args: { command: "pnpm test" },
		timestampMs: at(10),
	},
];

const commandEnd: ConversationEvent[] = [
	{
		type: "tool_execution_end",
		toolCallId: "bash-1",
		toolName: "bash",
		result: {
			content: [{ type: "text", text: "all passed" }],
			structuredContent: {
				output: "all passed",
				exit_code: 0,
				wall_time_seconds: 1.5,
			},
		},
		isError: false,
		timestampMs: at(12),
	},
	{
		type: "assistant_text_delta",
		delta: "Final answer: x is now 2.",
		timestampMs: at(74),
	},
	{ type: "assistant_turn_end", stopReason: "stop", timestampMs: at(75) },
];

const todos: ConversationEvent[] = [
	{
		type: "tool_execution_start",
		toolCallId: "todo-1",
		toolName: "todowrite",
		args: {
			todos: [
				{ content: "Read the file", status: "completed" },
				{ content: "Change x", status: "in_progress", priority: "high" },
			],
		},
		timestampMs: at(1),
	},
	{
		type: "tool_execution_end",
		toolCallId: "todo-1",
		toolName: "todowrite",
		result: { content: [{ type: "text", text: "ok" }] },
		isError: false,
		timestampMs: at(2),
	},
	{ type: "assistant_text_delta", delta: "Planned.", timestampMs: at(3) },
	{ type: "assistant_turn_end", stopReason: "stop", timestampMs: at(4) },
];

const answer: ConversationEvent[] = [
	{ type: "assistant_text_delta", delta: "x is 1.", timestampMs: at(3) },
	{ type: "assistant_turn_end", stopReason: "stop", timestampMs: at(5) },
];

const scenarios: Record<string, ConversationEvent[]> = {
	settled: [...prompt, ...work, ...commandEnd],
	expanded: [...prompt, ...work, ...commandEnd],
	running: [...prompt, ...work],
	todos: [...prompt, ...todos],
	waiting: prompt,
	thinking: [...prompt, ...work.slice(0, 2)],
	answered: [...prompt, ...answer],
	untimed: [...prompt, ...answer],
};

async function run() {
	await initializeI18n();
	const scenario = (await Storage.getItem("fixture.scenario")) ?? "settled";
	const state: ChatTranscriptState = {
		sessionKey: "chat-activity-fixture",
		status: "ready",
		conversation: replayConversationEvents(
			scenarios[scenario] ?? scenarios.settled,
			context(),
		),
		historyPrefix: [],
		source: "history",
	};
	const expanded = scenario === "expanded";
	const untimed = expanded || scenario === "untimed";
	mount(() => (
		<View class="flex-1">
			<ChatMessageList
				transcript={() => state}
				messages={() => state.conversation?.messages ?? []}
				preferences={() => ({
					collapseCompletedActivity: !expanded,
					showWorkDuration: !untimed,
				})}
			/>
		</View>
	));
}

void run();

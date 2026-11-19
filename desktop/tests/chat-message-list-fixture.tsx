import { mount, setTheme, signal, Storage, Text, View } from "nsh";

import { replayConversationEvents } from "@/lib/chat/conversation-replay";
import type {
	ConversationEvent,
	ConversationReducerContext,
	ConversationState,
} from "@/lib/chat/conversation-types";
import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { ChatMessageList } from "../chat/chat-message-list";
import claude from "../claude-theme.json";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { setStyleTheme } from "../ui/theme-style";
import { fixtureThemeFamily } from "./fixture-theme";

/**
 * The message list over transcript states the test names with `open`'s
 * `storage`, in the theme it saved: `loading` never answers, `failed` fails
 * until its second retry, `waiting` has a turn that cannot be rebuilt,
 * `empty` has no message, `history` is a settled chat, `streaming` is that
 * chat with a reply still coming and `long` has
 * `fixture.count` messages. `opening` is `long` shown when the test presses
 * `open`, and says how long its last reply took to show. `switching` is
 * `history` until the test opens another chat with `switch` and `load`.
 */
type Scenario =
	| "loading"
	| "failed"
	| "waiting"
	| "empty"
	| "history"
	| "streaming"
	| "long"
	| "opening"
	| "switching";

const sessionKey = "chat-fixture";
const startedAt = Date.UTC(2026, 10, 20, 9, 0);

function context(): ConversationReducerContext {
	let id = 0;
	return {
		createMessageId: (kind) => `${kind}-${++id}`,
		createContentId: (kind) => `${kind}-${++id}`,
		now: () => startedAt,
		formatTime: (timestampMs) =>
			new Date(timestampMs).toISOString().slice(11, 16),
	};
}

/** A settled turn: a prompt and its reply. */
function turn(
	index: number,
	prompt: string,
	reply: string,
	end: Partial<Extract<ConversationEvent, { type: "assistant_turn_end" }>> = {},
): ConversationEvent[] {
	const timestampMs = startedAt + index * 60_000;
	return [
		{ type: "user_message_start", text: prompt, timestampMs },
		{ type: "assistant_message_start", timestampMs },
		{ type: "assistant_text_delta", delta: reply, timestampMs },
		{ type: "assistant_turn_end", stopReason: "stop", timestampMs, ...end },
	];
}

const history: ConversationEvent[] = [
	...turn(
		0,
		"Where does the sidebar read its sessions from?",
		"From the session index of each project.\n\nThe sidebar asks the app store for a project's index when the project is expanded, and the store reads it through the Pilo client. Pi's JSONL files stay the source of truth; the index only lists them.",
	),
	{
		type: "compaction_marker",
		summary: "Sidebar session loading.",
		tokensBefore: 48_210,
		timestampMs: startedAt + 60_000,
	},
	...turn(
		2,
		"Rename the helper and run the checks.",
		"Renamed `sidebarSessions` and started the checks.",
		{ stopReason: "aborted", completion: "interrupted" },
	),
	...turn(3, "Try once more.", "", {
		stopReason: "error",
		errorMessage: "The model returned an empty response.",
	}),
	...turn(
		4,
		"Summarize what changed.",
		"One helper was renamed; nothing else changed.",
	),
];

/**
 * A chat of `count` messages. The reducer copies the messages for every
 * event, so a long chat is built in parts: no single call into JS runs long.
 */
async function long(count: number): Promise<ConversationState> {
	const reducer = context();
	let conversation = replayConversationEvents([], reducer);
	const turns = count / 2;
	for (let first = 0; first < turns; first += 500) {
		const events: ConversationEvent[] = [];
		for (let index = first; index < Math.min(first + 500, turns); index++) {
			events.push(
				...turn(index, `Question ${index + 1}`, `Answer ${index + 1}`),
			);
		}
		conversation = replayConversationEvents(events, reducer, conversation);
		await new Promise((resolve) => setTimeout(resolve));
	}
	return conversation;
}

function ready(conversation: ConversationState): ChatTranscriptState {
	return { sessionKey, status: "ready", conversation, source: "history" };
}

function settled(events: ConversationEvent[]) {
	return ready(replayConversationEvents(events, context()));
}

const loading: ChatTranscriptState = {
	sessionKey,
	status: "loading",
	conversation: null,
	source: null,
};

const failures = [
	"The session file could not be opened.",
	"The session file is locked.",
];

async function run() {
	const scenario = (await Storage.getItem("fixture.scenario")) as Scenario;
	const count = Number(await Storage.getItem("fixture.count"));
	if ((await fixtureThemeFamily()) === "claude") {
		setTheme({ cssVars: claude.cssVars });
		setStyleTheme(claude.styleVars);
	}
	const failed = (attempt: number): ChatTranscriptState => ({
		...loading,
		status: "failed",
		message: failures[attempt],
	});
	const chat = ready(await long(count));
	const states: Record<Scenario, ChatTranscriptState> = {
		loading,
		failed: failed(0),
		waiting: { ...loading, status: "not_loaded" },
		empty: settled([]),
		history: settled(history),
		streaming: settled([
			...history,
			...turn(5, "And the tests?", "Running").slice(0, 3),
		]),
		long: chat,
		opening: loading,
		switching: settled(history),
	};
	const transcript = signal(states[scenario]);
	let retries = 0;
	// A read that follows a failure: the list shows the chat being read again.
	const retry = async () => {
		const attempt = ++retries;
		transcript.set(loading);
		await Promise.resolve();
		transcript.set(failures[attempt] ? failed(attempt) : settled(history));
	};
	// The chat is built before the clock starts: the list's time to show it
	// is what is measured, not the reducer's.
	const last = chat.conversation?.messages.at(-1)?.id;
	const elapsed = signal("");
	let started = 0;
	let measured = false;
	const controls: Partial<Record<Scenario, Record<string, () => void>>> = {
		opening: {
			open() {
				started = performance.now();
				transcript.set(chat);
			},
		},
		// Another chat is opened, read, and has its messages.
		switching: {
			switch: () => transcript.set({ ...loading, sessionKey: "chat-other" }),
			load: () => transcript.set({ ...chat, sessionKey: "chat-other" }),
		},
	};
	mount(() => (
		<View class="flex-1 bg-background">
			{controls[scenario] ? (
				<View class="flex-row items-center gap-3 px-2">
					<Each of={Object.entries(controls[scenario] ?? {})}>
						{(control) => (
							<Button testID={control()[0]} size="sm" onPress={control()[1]}>
								<Text>{control()[0]}</Text>
							</Button>
						)}
					</Each>
					<Text class="font-mono text-xs text-foreground">{elapsed}</Text>
				</View>
			) : null}
			<ChatMessageList
				transcript={transcript}
				onRetry={scenario === "failed" ? retry : undefined}
				empty={() => (
					<Text class="font-sans text-sm text-muted-foreground">
						No messages yet
					</Text>
				)}
				assistantBody={
					scenario === "opening"
						? (message) => (
								<Text
									class="font-sans text-base leading-[1.6] text-foreground"
									onLayout={() => {
										if (message().id !== last || measured) return;
										measured = true;
										// The frame that follows the layout draws the reply.
										requestAnimationFrame(() =>
											elapsed.set(
												`Last reply shown in ${Math.round(performance.now() - started)} ms`,
											),
										);
									}}
								>
									{() => message().text}
								</Text>
							)
						: undefined
				}
			/>
		</View>
	));
}

initializeI18n();
void run();

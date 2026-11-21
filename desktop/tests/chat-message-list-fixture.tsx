import { mount, setTheme, signal, Storage, Text, View } from "nsh";

import { replayConversationEvents } from "@shared/chat/conversation-replay";
import type {
	ConversationEvent,
	ConversationState,
} from "@shared/chat/conversation-types";
import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { ChatMessageList } from "../chat/chat-message-list";
import claude from "../claude-theme.json";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { setStyleTheme } from "../ui/theme-style";
import { context, long, startedAt, turn } from "./chat-conversation-fixture";
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

function ready(conversation: ConversationState): ChatTranscriptState {
	return {
		sessionKey,
		status: "ready",
		conversation,
		historyPrefix: [],
		source: "history",
	};
}

function settled(events: ConversationEvent[]) {
	return ready(replayConversationEvents(events, context()));
}

const loading: ChatTranscriptState = {
	sessionKey,
	status: "loading",
	conversation: null,
	historyPrefix: [],
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
				messages={() => transcript().conversation?.messages ?? []}
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

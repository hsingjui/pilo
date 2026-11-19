import {
	mount,
	setTheme,
	signal,
	Storage,
	Text,
	untracked,
	View,
	type ViewRef,
	windowSize,
} from "nsh";

import { replayConversationEvents } from "@/lib/chat/conversation-replay";
import type {
	ChatMessage,
	ConversationEvent,
} from "@/lib/chat/conversation-types";
import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { ChatMessageList } from "../chat/chat-message-list";
import claude from "../claude-theme.json";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { setStyleTheme } from "../ui/theme-style";
import { context, long, startedAt } from "./chat-conversation-fixture";
import { fixtureThemeFamily } from "./fixture-theme";

/**
 * A settled chat of `fixture.count` messages that the test adds a turn to:
 * `prompt` sends a question, `stream` streams `fixture.lines` lines of the
 * reply, a frame apart, `end` settles the turn and `reread` shows the chat
 * as a new read gives it, the loaded messages starting two further on when
 * `fixture.unloaded` of the first are placeholders. `measure` says where the
 * first prompt in view is, where the end of the list is and how tall the
 * window is, so the test sees whether the list moved.
 */
async function run() {
	const count = Number(await Storage.getItem("fixture.count"));
	const lines = Number(await Storage.getItem("fixture.lines"));
	// How many of the first messages are not loaded: placeholders stand for them.
	let unloaded = Number(await Storage.getItem("fixture.unloaded"));
	if ((await fixtureThemeFamily()) === "claude") {
		setTheme({ cssVars: claude.cssVars });
		setStyleTheme(claude.styleVars);
	}
	const reducer = context();
	let conversation = await long(count, reducer);
	const transcript = signal<ChatTranscriptState>({
		sessionKey: "chat-fixture",
		status: "ready",
		conversation,
		historyPrefix: [],
		source: "snapshot",
	});
	// The chat as the store joins it: placeholders, then the loaded messages.
	const joined = (): ChatMessage[] =>
		conversation.messages.map((message, index) =>
			index < unloaded
				? {
						...message,
						historyPlaceholder: true,
						historyEstimatedChars: message.text.length,
					}
				: message,
		);
	const messages = signal(joined());
	const bodies = signal(0);
	const show = () => {
		transcript.set({ ...transcript(), conversation });
		messages.set(joined());
	};
	const apply = (...events: ConversationEvent[]) => {
		conversation = replayConversationEvents(events, reducer, conversation);
		show();
	};
	const timestampMs = startedAt + count * 60_000;
	const streamed = signal(0);
	const measured = signal("");
	let measures = 0;
	// The prompts on screen, by the cell that shows each.
	const prompts = new Map<ViewRef, () => ChatMessage>();
	let anchor: string | undefined;
	let end: ViewRef | undefined;
	const measure = async () => {
		const shown = await Promise.all(
			[...prompts].map(async ([view, message]) => ({
				text: message().text,
				y: (await view.measure())?.pagePosition.y,
			})),
		);
		// The first prompt under the bar, then that prompt again.
		const prompt =
			shown.find(({ text }) => text === anchor) ??
			shown
				.filter(({ y }) => y !== undefined && y > 60)
				.sort((a, b) => (a.y ?? 0) - (b.y ?? 0))[0];
		anchor = prompt?.text;
		const bottom = (await end?.measure())?.pagePosition.y;
		measured.set(
			`#${++measures}: ${prompt?.text ?? "no prompt"} at ${Math.round(prompt?.y ?? -1)}, end at ${Math.round(bottom ?? -1)} of ${windowSize().height}`,
		);
	};
	const controls: Record<string, () => void> = {
		prompt: () =>
			apply(
				{ type: "user_message_start", text: "One more question", timestampMs },
				{ type: "assistant_message_start", timestampMs },
			),
		stream() {
			const next = () => {
				streamed.set(streamed() + 1);
				apply({
					type: "assistant_text_delta",
					delta: `Reply line ${streamed()}\n`,
					timestampMs,
				});
				if (streamed() % lines !== 0) requestAnimationFrame(next);
			};
			next();
		},
		end: () =>
			apply({ type: "assistant_turn_end", stopReason: "stop", timestampMs }),
		// The chat is read again: the reducer names every reply anew, and the
		// loaded messages start two further on.
		reread() {
			unloaded += unloaded > 0 ? 2 : 0;
			conversation = {
				...conversation,
				messages: conversation.messages.map((message) =>
					message.role === "assistant"
						? { ...message, id: `${message.id}-read-again` }
						: message,
				),
			};
			show();
		},
		measure: () => void measure(),
	};
	mount(() => (
		<View class="flex-1 bg-background">
			<View class="flex-row items-center gap-2 px-2">
				<Each of={Object.entries(controls)}>
					{(control) => (
						<Button testID={control()[0]} size="sm" onPress={control()[1]}>
							<Text>{control()[0]}</Text>
						</Button>
					)}
				</Each>
				<Text class="font-mono text-xs text-foreground">
					{() => `streamed ${streamed()}`}
				</Text>
				<Text class="font-mono text-xs text-foreground">
					{() => `${bodies()} prompt rows made`}
				</Text>
				<Text class="font-mono text-xs text-foreground">{measured}</Text>
			</View>
			<ChatMessageList
				transcript={transcript}
				messages={messages}
				userBody={(message) => {
					// Called once for each row the list makes.
					bodies.set(untracked(bodies) + 1);
					return (
						<Text
							ref={(view) => prompts.set(view, message)}
							class="font-sans text-base leading-[1.6] text-foreground"
						>
							{() => message().text}
						</Text>
					);
				}}
				footer={<View ref={(view) => (end = view)} class="h-px" />}
			/>
		</View>
	));
}

initializeI18n();
void run();

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

import { replayConversationEvents } from "@shared/chat/conversation-replay";
import type {
	ChatMessage,
	ConversationEvent,
	ConversationState,
} from "@shared/chat/conversation-types";
import { initializeI18n } from "../shell/i18n";
import { ChatMessageList } from "../chat/chat-message-list";
import claude from "../../theme/claude-theme.json";
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
 * window is, so the test sees whether the list moved. `other` switches to
 * a second chat and back, so the test sees whether the list comes back
 * where the first was read to.
 */
async function run() {
	const count = Number(await Storage.getItem("fixture.count"));
	const lines = Number(await Storage.getItem("fixture.lines"));
	// How many of the first messages are not loaded: placeholders stand for them.
	let unloaded = Number(await Storage.getItem("fixture.unloaded"));
	// With `fixture.hold` the reported range is recorded but never read:
	// the placeholders it covers stay, for a look at them.
	const hold = (await Storage.getItem("fixture.hold")) === "1";
	if ((await fixtureThemeFamily()) === "claude") {
		setTheme({ cssVars: claude.cssVars });
		setStyleTheme(claude.styleVars);
	}
	const reducer = context();
	// The chats the fixture can show: `a` is the one `count` makes, `b` the
	// one `other` switches to and back.
	const chats: Record<
		string,
		{ conversation: ConversationState; unloaded: number }
	> = {
		a: { conversation: await long(count, reducer), unloaded },
	};
	let current = "a";
	const chat = () => chats[current];
	const transcript = signal<ChatTranscriptState>({
		sessionKey: "chat-a",
		status: "ready",
		conversation: chat().conversation,
		historyPrefix: [],
		source: "snapshot",
	});
	// The chat as the store joins it: placeholders, then the loaded messages.
	const joined = (): ChatMessage[] =>
		chat().conversation.messages.map((message, index) =>
			index < chat().unloaded
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
		transcript.set({ ...transcript(), conversation: chat().conversation });
		messages.set(joined());
	};
	const apply = (...events: ConversationEvent[]) => {
		chat().conversation = replayConversationEvents(
			events,
			reducer,
			chat().conversation,
		);
		show();
	};
	const timestampMs = startedAt + count * 60_000;
	const streamed = signal(0);
	const eventMs = signal(0);
	const measured = signal("");
	const ranges = signal("visible: none");
	// The range the list reports, and the read it starts: the reported
	// messages and the ones below them come in loaded, the ones above stay
	// placeholders, as the store's pages do.
	const reportRange = (start: number, end: number) => {
		ranges.set(`${ranges().replace("none", "")}${start}-${end},`);
		if (start < chat().unloaded && !hold) {
			setTimeout(() => {
				chat().unloaded = Math.min(chat().unloaded, start);
				show();
			}, 0);
		}
	};
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
			shown.find(({ text, y }) => text === anchor && y !== undefined) ??
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
				const t0 = performance.now();
				apply({
					type: "assistant_text_delta",
					delta: `Reply line ${streamed()}\n\n`,
					timestampMs,
				});
				// The event's cost is its apply plus the frame it lays out in.
				requestAnimationFrame(() => {
					eventMs.set(Math.max(eventMs(), Math.round(performance.now() - t0)));
					if (streamed() % lines !== 0) next();
				});
			};
			next();
		},
		end: () =>
			apply({ type: "assistant_turn_end", stopReason: "stop", timestampMs }),
		tool: () =>
			apply(
				{ type: "user_message_start", text: "Run a long command", timestampMs },
				{ type: "assistant_message_start", timestampMs },
				{
					type: "tool_execution_start",
					toolCallId: "bash-long-1",
					toolName: "bash",
					args: { command: "seq 1 40" },
					timestampMs,
				},
				{
					type: "tool_execution_end",
					toolCallId: "bash-long-1",
					toolName: "bash",
					result: {
						content: [
							{
								type: "text",
								text: Array.from(
									{ length: 40 },
									(_, i) => `Command output line ${i + 1}`,
								).join("\n"),
							},
						],
					},
					isError: false,
					timestampMs,
				},
				{ type: "assistant_turn_end", stopReason: "stop", timestampMs },
			),
		// The chat is read again: the reducer names every reply anew, and
		// the loaded window is the one it was: the store keeps the pages of
		// the range the list reported, and a margin around them, loaded, so
		// a read's window can only move outside that.
		reread() {
			chat().conversation = {
				...chat().conversation,
				messages: chat().conversation.messages.map((message) =>
					message.role === "assistant"
						? { ...message, id: `${message.id}-read-again` }
						: message,
				),
			};
			show();
		},
		// The other chat, as opening another session shows it; `other`
		// again is the way back to this one.
		other() {
			void (async () => {
				chats.b ??= {
					conversation: await long(20, reducer),
					unloaded: 0,
				};
				current = current === "a" ? "b" : "a";
				// The other chat's list remakes its rows; the cells the map held
				// went with the last list.
				prompts.clear();
				transcript.set({
					...transcript(),
					sessionKey: `chat-${current}`,
					conversation: chat().conversation,
				});
				messages.set(joined());
			})();
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
				<Text class="font-mono text-xs text-foreground">
					{() => `event at most ${eventMs()} ms`}
				</Text>
				<Text class="font-mono text-xs text-foreground">{measured}</Text>
				<Text class="font-mono text-xs text-foreground">{ranges}</Text>
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
				onVisibleRangeChange={reportRange}
			/>
		</View>
	));
}

initializeI18n();
void run();

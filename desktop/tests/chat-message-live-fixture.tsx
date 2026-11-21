import { host, mount, signal, Text, View } from "nsh";
import { ChatFixture, Pilo } from "app/native";

import type { ConversationReducerContext } from "@shared/chat/conversation-types";
import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { ChatMessageList } from "../chat/chat-message-list";
import { NshPiloClient } from "../client/nsh-pilo-client";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { Button } from "../ui/button";

/**
 * The message list over the transcript store and the runtime: a saved chat
 * of 20 messages, opened through `ChatTranscriptStore`. `prompt` starts Pi
 * for it and sends a question, which the fixture's stand-in for Pi leaves
 * open after "partial reply". With `host.params.realPi` the installed Pi
 * answers on relay/deepseek-flash instead: a smoke run, not a test.
 */
const projectId = "chat-fixture";
const sessionKey = "nsh-message-list-fixture";
const realPi = host.params.realPi === true;
const status = signal("opening the chat");

function context(): ConversationReducerContext {
	let id = 0;
	return {
		createMessageId: (kind) => `${kind}-${++id}`,
		createContentId: (kind) => `${kind}-${++id}`,
		now: () => Date.now(),
		formatTime: (timestampMs) =>
			new Date(timestampMs).toISOString().slice(11, 16),
	};
}

/** Ten settled turns, as Pi saves them. */
function saved() {
	const entries: string[] = [];
	for (let index = 0; index < 20; index++) {
		const turn = Math.floor(index / 2) + 1;
		entries.push(
			JSON.stringify({
				type: "message",
				id: `saved-${index}`,
				parentId: index === 0 ? null : `saved-${index - 1}`,
				timestamp: new Date(Date.UTC(2026, 0, 1, 9, index)).toISOString(),
				message:
					index % 2 === 0
						? { role: "user", content: `Saved question ${turn}` }
						: {
								role: "assistant",
								content: [
									{
										type: "text",
										text: `Saved answer ${turn}\nIt runs over a few lines,\nas a reply usually does.`,
									},
								],
								stopReason: "stop",
							},
			}),
		);
	}
	return `${entries.join("\n")}\n`;
}

const fixture = new ChatFixture(realPi);
const client = new NshPiloClient(new Pilo(fixture.dataDir()));
const chat = new ChatTranscriptStore(client, context());
const app = new AppStore(client, chat);
const sessionPath = fixture.seedTranscript(saved());

async function prompt() {
	await client.startChat({ projectId, sessionKey, sessionPath });
	if (!realPi) {
		await client.sendChatCommand(sessionKey, {
			type: "prompt",
			id: "fixture-transcript-turn",
			message: "new question",
		});
		return;
	}
	await client.sendChatCommand(sessionKey, {
		type: "set_model",
		provider: "relay",
		modelId: "deepseek-flash",
	});
	await client.sendChatCommand(sessionKey, {
		type: "prompt",
		message:
			"Count from 1 to 60. Put each number on its own line, followed by one short sentence about it. No other text.",
	});
}

async function run() {
	await app.start();
	await chat.open({ sessionKey, projectId, sessionPath }, app.connected);
	status.set("chat open");
}

mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-row items-center gap-2 px-2">
			<Button
				testID="prompt"
				size="sm"
				onPress={() =>
					void prompt().catch((error: unknown) => status.set(String(error)))
				}
			>
				<Text>prompt</Text>
			</Button>
			<Text class="font-mono text-xs text-foreground">{status}</Text>
		</View>
		<ChatMessageList
			transcript={() => chat.state()}
			messages={() => chat.messages()}
			onRetry={() => chat.refresh()}
		/>
	</View>
));

initializeI18n();
void run().catch((error: unknown) => status.set(String(error)));

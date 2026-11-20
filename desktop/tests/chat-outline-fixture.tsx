import { mount, setTheme, signal, Storage, Text, View } from "nsh";

import type { ChatMessage } from "@/lib/chat/conversation-types";
import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { ChatMessageList } from "../chat/chat-message-list";
import claude from "../claude-theme.json";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { setStyleTheme } from "../ui/theme-style";
import { context, long } from "./chat-conversation-fixture";
import { fixtureThemeFamily } from "./fixture-theme";

/**
 * El raíl del chat sobre una conversación larga: `fixture.count` mensajes
 * repartidos entre marcadores del historial aún no leídos (`fixture.prefix`)
 * y una ventana cargada al final. El último rango visible pedido queda en
 * `id:requested-range`.
 */
const sessionKey = "chat-outline";

const requested = signal("");

function placeholder(index: number): ChatMessage {
	return {
		id: `placeholder-${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		text: index % 2 === 0 ? `Old question ${index / 2 + 1}` : "…",
		time: "08:00",
		historyPlaceholder: true,
		historyEstimatedChars: 400,
	};
}

async function run() {
	const count = Number(await Storage.getItem("fixture.count")) || 40;
	const prefix = Number(await Storage.getItem("fixture.prefix")) || 0;
	if ((await fixtureThemeFamily()) === "claude") {
		setTheme({ cssVars: claude.cssVars });
		setStyleTheme(claude.styleVars);
	}
	const conversation = await long(count - prefix, context());
	const messages: ChatMessage[] = [
		...Array.from({ length: prefix }, (_, index) => placeholder(index)),
		...conversation.messages,
	];
	const state: ChatTranscriptState = {
		sessionKey,
		status: "ready",
		conversation,
		historyPrefix: [],
		source: "history",
	};
	const transcript = signal(state);
	mount(() => (
		<View class="flex-1 bg-background">
			<View class="flex-row items-center gap-2 px-2">
				<Text testID="requested-range" class="font-mono text-xs">
					{requested}
				</Text>
				<Button
					testID="theme-lody"
					size="sm"
					onPress={() => {
						setTheme(null);
						setStyleTheme(null);
					}}
				>
					<Text>Lody</Text>
				</Button>
				<Button
					testID="theme-claude"
					size="sm"
					onPress={() => {
						setTheme({ cssVars: claude.cssVars });
						setStyleTheme(claude.styleVars);
					}}
				>
					<Text>Claude</Text>
				</Button>
			</View>
			<ChatMessageList
				transcript={transcript}
				messages={() => messages}
				onVisibleRangeChange={(start, end) => requested.set(`${start}-${end}`)}
			/>
		</View>
	));
}

initializeI18n();
void run();

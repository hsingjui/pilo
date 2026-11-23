import { mount, signal, Text, View } from "nsh";
import "../shell/fonts";

import {
	sessionMentionValue,
	type SessionMention,
} from "@shared/chat/session-mentions";
import { initializeI18n } from "../shell/i18n";
import { ChatMediaActions } from "../chat/chat-media-actions";
import type { UserChatMessage } from "../chat/chat-message-types";
import { ChatUserMessage } from "../chat/chat-user-message";

const opened = signal("none");

const session: SessionMention = {
	connectionId: "local",
	projectId: "p1",
	path: "/sessions/earlier.jsonl",
	title: "Earlier chat",
	projectName: "Pilo",
	updatedAt: 1,
};
const sessions = new Map([[sessionMentionValue(session.path), session]]);

const message: UserChatMessage = {
	id: "u1",
	role: "user",
	text: '请帮我对比 @"desktop/chat/chat-user-message-body.tsx" 和 @"notes/raw.unknownext" 以及 @/sessions/earlier.jsonl',
	time: "09:00",
};

mount(() => {
	initializeI18n("en-US");
	return (
		<ChatMediaActions.Provider
			value={{
				sessionMentions: () => sessions,
				canOpenFile: () => true,
				openFile: (path) => opened.set(path),
			}}
		>
			<View class="bg-background p-4" style={{ width: 640, gap: 12 }}>
				<ChatUserMessage message={() => message} />
				<View testID="opened-file">
					<Text>{opened}</Text>
				</View>
			</View>
		</ChatMediaActions.Provider>
	);
});

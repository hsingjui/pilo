import { mount, signal, Text, View } from "nsh";

import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import { ChatPendingQueue } from "../chat/chat-pending-queue";
import { ChatComposer } from "../composer/chat-composer";
import { ComposerStore, type ComposerClient } from "../composer/composer-store";
import { initializeI18n } from "../shell/i18n";
import { createAppState, type AppState } from "../state/app-state";
import { ChatQueueStore } from "../state/chat-queue-store";
import { Button } from "../ui/button";
import { scriptedClient } from "./scripted-app-client";

initializeI18n("en-US");

const lastCommand = signal("idle");
const queues = { steering: [] as string[], followUp: [] as string[] };
let sequence = 1;

const { client: runtime } = scriptedClient({
	onCommand: (sessionKey, command) => {
		const type = String(command.type ?? "");
		lastCommand.set(
			typeof command.message === "string" ? `${type}:${command.message}` : type,
		);
		if (type === "steer" || type === "follow_up") {
			const message = String(command.message ?? "");
			if (type === "steer") queues.steering.push(message);
			else queues.followUp.push(message);
			queue.receive({
				sequence: ++sequence,
				timestampMs: 1000,
				sessionKey,
				generation: 1,
				type: "queue_update",
				steering: [...queues.steering],
				followUp: [...queues.followUp],
			});
			return { success: true, data: { disposition: "queued" } };
		}
		if (type === "clear_queue") {
			const cleared = {
				steering: [...queues.steering],
				followUp: [...queues.followUp],
			};
			queues.steering = [];
			queues.followUp = [];
			queue.receive({
				sequence: ++sequence,
				timestampMs: 1000,
				sessionKey,
				generation: 1,
				type: "queue_update",
				steering: [],
				followUp: [],
			});
			return { success: true, data: cleared };
		}
		if (type === "prompt") {
			return { success: true, data: { disposition: "started" } };
		}
		return { success: true };
	},
});

const client: ComposerClient = {
	startChat: runtime.startChat,
	chatState: async (sessionKey) =>
		({
			sessionKey,
			projectId: "p1",
			prepared: true,
			initialized: true,
			activeTurn: { id: "t1" },
		}) as unknown as ChatSessionRuntimeState,
	sendChatCommand: runtime.sendChatCommand,
	connectEvents: runtime.connectEvents,
	searchProjectFiles: async () => [],
	uploadChatFile: async (_p, name) => `/attachments/a/${name}`,
	removeChatFile: async () => {},
};

const queue = new ChatQueueStore(client);
const app = {
	...createAppState(),
	projects: [{ id: "p1", name: "Project" }],
	chatSessions: [
		{
			sessionKey: "sa",
			projectId: "p1",
			prepared: true,
			initialized: true,
			activeTurn: { id: "t1" },
		} as unknown as ChatSessionRuntimeState,
	],
} as AppState;

const composer = new ComposerStore({
	client,
	app: () => app,
	queue,
});
composer.setTarget({ sessionKey: "sa", projectId: "p1" });

mount(() => (
	<View class="flex-1 justify-end gap-2 bg-background p-4">
		<Text testID="queue-last-command">{lastCommand}</Text>
		<View class="flex-row gap-2">
			<Button
				testID="fixture-mode-follow-up"
				size="sm"
				onPress={() => composer.setSendMode("follow_up")}
			>
				<Text>Mode Follow-Up</Text>
			</Button>
			<Button
				testID="fixture-inject-remote"
				size="sm"
				onPress={() => {
					queues.steering.push("from remote");
					queue.receive({
						sequence: ++sequence,
						timestampMs: 1000,
						sessionKey: "sa",
						generation: 1,
						type: "queue_update",
						steering: [...queues.steering],
						followUp: [...queues.followUp],
					});
				}}
			>
				<Text>Inject Remote</Text>
			</Button>
		</View>
		<ChatPendingQueue
			queue={queue}
			composer={composer}
			sessionKey={() => "sa"}
		/>
		<ChatComposer store={composer} />
	</View>
));

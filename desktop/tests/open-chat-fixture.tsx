import { mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { Project } from "@/lib/api/projects-types";
import type {
	SessionHistoryResult,
	SessionIndexEntry,
} from "@/lib/api/sessions-types";
import { conversationContext, followOpenSession } from "../app/open-chat";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { scriptedClient } from "./scripted-app-client";

/**
 * The app state over a scripted client, with the open session's transcript
 * followed as `launch` does. The project has two saved sessions; the
 * runtime already holds a chat, under its own key, for the second. The
 * screen says which chat is open and what was read for it.
 */
const project = {
	id: "pilo",
	name: "pilo",
	path: "/code/pilo",
	connection: { id: "local", name: "Local", kind: { type: "local" } },
} as Project;

function saved(id: string) {
	return {
		projectId: project.id,
		piSessionId: id,
		sessionPath: `/sessions/${id}.jsonl`,
	} as SessionIndexEntry;
}

const reads = signal<string[]>([]);
const read = (line: string) => reads.set([...reads(), line]);

async function run() {
	const runtime = scriptedClient({
		projects: [project],
		sessions: () => Promise.resolve([saved("s1"), saved("s2")]),
		chatSessions: [
			{
				sessionKey: "held-key",
				projectId: project.id,
				sessionPath: saved("s2").sessionPath,
			} as ChatSessionRuntimeState,
		],
	});
	const chat = new ChatTranscriptStore(
		{
			chatState(sessionKey) {
				read(`state of ${sessionKey}`);
				return Promise.resolve(null);
			},
			chatTranscriptSnapshot: () =>
				Promise.reject(new Error("no Pi is running")),
			loadHistory(projectId, sessionPath) {
				read(`history of ${projectId} ${sessionPath}`);
				return Promise.resolve({
					history: { events: [] },
				} as unknown as SessionHistoryResult);
			},
		},
		conversationContext(),
	);
	const store = new AppStore(runtime.client, chat);
	followOpenSession(store, chat);
	await store.start();
	await store.loadSessions(project.id);
	const open = (id: string) => () =>
		store.selectSession(project.id, `/sessions/${id}.jsonl`);
	mount(() => (
		<View class="gap-2 p-6">
			<Button testID="open-saved" onPress={open("s1")}>
				<Text>Open the saved session</Text>
			</Button>
			<Button testID="open-held" onPress={open("s2")}>
				<Text>Open the session with a chat</Text>
			</Button>
			<Button testID="open-unknown" onPress={open("gone")}>
				<Text>Open a session that is not saved</Text>
			</Button>
			<Button testID="close" onPress={() => store.selectProject(project.id)}>
				<Text>Close the session</Text>
			</Button>
			<Button
				testID="reload"
				onPress={() => void store.loadSessions(project.id)}
			>
				<Text>Read the sessions again</Text>
			</Button>
			<Text>
				{() => {
					const { sessionKey, status, source } = chat.state();
					return `chat: ${sessionKey} ${status} ${source}`;
				}}
			</Text>
			<Text>{() => `reads: ${reads().join("; ")}`}</Text>
		</View>
	));
}

void run();

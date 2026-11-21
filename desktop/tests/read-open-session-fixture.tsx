import { lifecycle, mount, signal, Text, View } from "nsh";
import { Button } from "nsh/base";

import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import type { SessionReadState } from "@shared/session-read-state";
import { followOpenSessionRead } from "../app/read-open-session";
import { isSessionUnread } from "../state/app-state";
import { AppStore } from "../state/app-store";
import { scriptedClient } from "./scripted-app-client";

/**
 * The app state over a scripted client, with the open session's finished
 * turns marked as seen as `launch` does. The project has two saved
 * sessions, both read. The buttons open the first, end a turn in either and
 * hold up or let go the runtime's answers to a mark; the screen names the
 * unread sessions and what was marked read.
 */
const project = {
	id: "pilo",
	name: "pilo",
	path: "/code/pilo",
	connection: { id: "local", name: "Local", kind: { type: "local" } },
} as Project;
const ids = ["s1", "s2"];
const path = (id: string) => `/sessions/${id}.jsonl`;

const readStates: SessionReadState[] = ids.map((id) => ({
	projectId: project.id,
	sessionPath: path(id),
	completedRevision: 1,
	readRevision: 1,
}));

async function run() {
	const runtime = scriptedClient({
		projects: [project],
		sessions: () =>
			Promise.resolve(
				ids.map(
					(id) =>
						({
							projectId: project.id,
							piSessionId: id,
							sessionPath: path(id),
						}) as SessionIndexEntry,
				),
			),
		readStates,
	});
	const marked = signal<string[]>([]);
	/** The marks the runtime has not answered yet, while it is held up. */
	let held: (() => void)[] | null = null;
	const hold = () => {
		held = [];
	};
	const release = () => {
		const waiting = held ?? [];
		held = null;
		for (const answer of waiting) answer();
	};
	const markSessionRead = runtime.client.markSessionRead;
	runtime.client.markSessionRead = (projectId, sessionPath, revision) => {
		const id = ids.find((id) => path(id) === sessionPath);
		marked.set([...marked(), `${id}@${revision}`]);
		const answer = () => markSessionRead(projectId, sessionPath, revision);
		if (!held) return answer();
		const waiting = held;
		return new Promise((resolve, reject) => {
			waiting.push(() => answer().then(resolve, reject));
		});
	};
	const store = new AppStore(runtime.client);
	followOpenSessionRead(store);
	await store.start();
	await store.loadSessions(project.id);
	/** A turn of the session ends, as the runtime reports it. */
	const endTurn = (id: string) => () => {
		const state = readStates[ids.indexOf(id)];
		state.completedRevision += 1;
		runtime.emit({ type: "session_read_state_changed", state: { ...state } });
	};
	mount(() => (
		<View class="gap-2 p-6">
			<Button
				testID="open-s1"
				onPress={() => store.selectSession(project.id, path("s1"))}
			>
				<Text>Open the first session</Text>
			</Button>
			<Button testID="turn-s1" onPress={endTurn("s1")}>
				<Text>End a turn in the first session</Text>
			</Button>
			<Button testID="turn-s2" onPress={endTurn("s2")}>
				<Text>End a turn in the second session</Text>
			</Button>
			<Button testID="hold" onPress={hold}>
				<Text>Hold the runtime's answers up</Text>
			</Button>
			<Button testID="release" onPress={release}>
				<Text>Let the runtime answer</Text>
			</Button>
			<Text>{() => `app: ${lifecycle()}`}</Text>
			<Text>
				{() => `open: ${store.state().navigation.session?.sessionPath ?? ""}`}
			</Text>
			<Text>
				{() => {
					const state = store.state();
					const unread = ids.filter((id) =>
						isSessionUnread(state, project.id, path(id)),
					);
					return `unread: ${unread.join(", ")}`;
				}}
			</Text>
			<Text>{() => `marked: ${marked().join(", ")}`}</Text>
		</View>
	));
}

void run();

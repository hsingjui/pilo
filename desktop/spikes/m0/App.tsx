// M0 spike 1: the existing Pilo runtime in an nsh window. The lists come
// from the desktop app's SQLite index, the conversation from a real
// `pi --mode rpc` process, both through the runtime the Tauri app runs.
import {
	fpsEnabled,
	List,
	mount,
	perfStats,
	Scroll,
	setFpsEnabled,
	signal,
	Text,
	View,
} from "nsh";
import { Button, Input } from "nsh/base";

import {
	burst,
	conversation,
	delivery,
	failure,
	projectId,
	projects,
	reset,
	selectProject,
	send,
	sessions,
	status,
} from "./src/store";

function Action(props: { label: string; onPress: () => void }) {
	return (
		<Button
			onPress={props.onPress}
			class="rounded-(--radius) bg-secondary px-3 py-1 hover:bg-accent active:opacity-80"
		>
			<Text class="text-sm text-secondary-foreground">{props.label}</Text>
		</Button>
	);
}

function Sidebar() {
	return (
		<View class="w-72 border-r border-border bg-card">
			<Text class="px-3 pt-3 pb-1 text-xs font-semibold text-muted-foreground">
				PROJECTS
			</Text>
			<Each of={projects()} key={(project) => project.id}>
				{(project) => (
					<View
						role="button"
						onPress={() => selectProject(project().id)}
						class="mx-2 rounded-(--radius) px-2 py-1 hover:bg-accent"
						classList={{ "bg-accent": projectId() === project().id }}
					>
						<Text class="text-sm text-foreground">{project().name}</Text>
						<Text class="line-clamp-1 text-xs text-muted-foreground">
							{project().path}
						</Text>
					</View>
				)}
			</Each>
			<Text class="px-3 pt-4 pb-1 text-xs font-semibold text-muted-foreground">
				SESSIONS ({sessions().length})
			</Text>
			<Scroll class="flex-1">
				<Each of={sessions()} key={(session) => session.sessionPath}>
					{(session) => (
						<View class="mx-2 rounded-(--radius) px-2 py-1">
							<Text class="line-clamp-1 text-sm text-foreground">
								{session().name ??
									session().firstUserMessagePreview ??
									"Untitled"}
							</Text>
							<Text class="text-xs text-muted-foreground">
								{session().messageCount} messages · {session().updatedAt}
							</Text>
						</View>
					)}
				</Each>
			</Scroll>
		</View>
	);
}

function Stats() {
	const fixed = (value: number) => value.toFixed(2);
	return (
		<View class="gap-1 border-b border-border px-4 py-2">
			<Text class="text-xs text-muted-foreground">status: {status()}</Text>
			<If when={failure()}>
				<Text class="text-xs text-destructive select-text">{failure()}</Text>
			</If>
			<Text class="text-xs text-muted-foreground">
				{delivery()
					? `events ${delivery()!.events} in ${delivery()!.batches} batches · rust→js p50 ${fixed(delivery()!.p50)} ms p95 ${fixed(delivery()!.p95)} ms max ${fixed(delivery()!.max)} ms`
					: "no events yet"}
			</Text>
			<Text class="text-xs text-muted-foreground">
				reduce p95 {delivery() ? fixed(delivery()!.reduceP95) : "-"} ms
			</Text>
			<Text class="text-xs text-muted-foreground">
				{perfStats()
					? `fps ${perfStats()!.fps.toFixed(0)} of ${perfStats()!.refreshRate ?? "?"} Hz · dropped ${(perfStats()!.dropped * 100).toFixed(1)}%`
					: fpsEnabled()
						? "fps: measuring"
						: "fps: off"}
			</Text>
		</View>
	);
}

// A streaming reply grows at its end: in pieces of a fixed length only the
// last piece's text changes, so only that node is laid out again.
const CHUNK = 400;
function chunks(text: string): string[] {
	const pieces: string[] = [];
	for (let start = 0; start < text.length; start += CHUNK)
		pieces.push(text.slice(start, start + CHUNK));
	return pieces;
}

function Messages() {
	return (
		<List
			each={conversation().messages}
			keyExtractor={(message) => message.id}
			estimatedItemSize={64}
			class="flex-1"
		>
			{(message) => (
				<View class="px-4 py-2">
					<Text class="text-xs font-semibold text-muted-foreground">
						{message().role}
					</Text>
					<Each
						of={chunks(
							"text" in message() ? (message() as { text: string }).text : "",
						)}
					>
						{(chunk) => (
							<Text class="text-sm text-foreground select-text">{chunk()}</Text>
						)}
					</Each>
				</View>
			)}
		</List>
	);
}

function Composer() {
	const draft = signal("");
	const submit = () => {
		const text = draft();
		draft.set("");
		void send(text);
	};
	return (
		<View class="gap-2 border-t border-border p-3">
			<View class="flex-row gap-2">
				<Input
					value={draft()}
					onChange={({ value }) => draft.set(value)}
					onSubmit={submit}
					placeholder="Message Pi"
					class="flex-1 rounded-(--radius) border border-input px-3 py-2 text-sm text-foreground"
				/>
				<Action label="Send" onPress={submit} />
			</View>
			<View class="flex-row gap-2">
				<Action
					label="Burst 300 @ 100/s"
					onPress={() => void burst(300, 100)}
				/>
				<Action
					label="Burst 3000 @ 1000/s"
					onPress={() => void burst(3000, 1000)}
				/>
				<Action label="FPS" onPress={() => setFpsEnabled(!fpsEnabled())} />
				<Action label="Reset" onPress={() => void reset()} />
			</View>
		</View>
	);
}

function App() {
	return (
		<View class="flex-1 flex-row bg-background pt-[env(safe-area-inset-top)]">
			<Sidebar />
			<View class="flex-1">
				<Stats />
				<Messages />
				<Composer />
			</View>
		</View>
	);
}

mount(App);

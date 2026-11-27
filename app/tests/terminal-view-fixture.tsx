import { mount, signal, Text, View } from "nsh";

import type { TerminalEvent } from "../client/nsh-pilo-client";
import { TerminalLayer } from "../shell/terminal-view";
import { type TerminalClient, TerminalStore } from "../state/terminal-store";

function toBase64(text: string): string {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function createFixtureStore() {
	let seq = 0;
	const queue: TerminalEvent[][] = [];
	let waiter: ((events: TerminalEvent[]) => void) | null = null;
	const resizes = signal<string[]>([]);

	const push = (...events: TerminalEvent[]) => {
		if (waiter) {
			const next = waiter;
			waiter = null;
			next(events);
			return;
		}
		queue.push(events);
	};

	const client: TerminalClient = {
		openTerminal: async (projectId) => ({
			id: `t-${++seq}`,
			projectId,
			title: projectId,
		}),
		writeTerminal: async () => {},
		resizeTerminal: async (terminalId, cols, rows) => {
			resizes.update((list) => [...list, `${terminalId}:${cols}x${rows}`]);
		},
		closeTerminal: async () => {},
		nextTerminalEvents: async () => {
			const next = queue.shift();
			if (next) return next;
			return new Promise<TerminalEvent[]>((resolve) => {
				waiter = resolve;
			});
		},
	};

	return {
		store: new TerminalStore(client),
		resizes,
		emitOutput: (terminalId: string, text: string) =>
			push({ type: "output", terminalId, data: toBase64(text) }),
	};
}

function App() {
	const { store, resizes, emitOutput } = createFixtureStore();
	const started = signal(false);

	const openInitial = async () => {
		await store.open("p1");
		emitOutput("t-1", "Code\\reverse\\idm via v3.12.14\r\n> ls");
		started.set(true);
	};
	void openInitial();

	return (
		<View class="flex-1 bg-background p-3 gap-2">
			<View class="flex-row items-center gap-2">
				<View
					testID="show-chat"
					class="px-2 py-1 bg-muted rounded"
					onPress={() => store.select(null)}
				>
					<Text>Chat tab</Text>
				</View>
				<View
					testID="show-t1"
					class="px-2 py-1 bg-muted rounded"
					onPress={() => store.select("t-1")}
				>
					<Text>Terminal 1</Text>
				</View>
			</View>
			<Text testID="ready">{started() ? "ready:yes" : "ready:no"}</Text>
			<Text testID="resizes">{`resizes:${resizes().join(",")}`}</Text>
			<View class="relative flex-1 min-h-0 border border-border">
				<View testID="chat-pane" class="flex-1 p-2">
					<Text>Chat view</Text>
				</View>
				<TerminalLayer
					terminals={store}
					shown={() => store.activeTab("p1")?.id ?? null}
					preferences={() => undefined}
				/>
			</View>
		</View>
	);
}

mount(App);

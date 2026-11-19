import { mount, signal, Text, View } from "nsh";
import { BootstrapFixture, Pilo } from "app/native";

import { NshPiloClient } from "../client/nsh-pilo-client";
import { isSessionUnread } from "../state/app-state";
import { AppStore } from "../state/app-store";

/** More events than the native queue's 2,048. */
const OVERFLOWING_SAVES = 2_400;

const fixture = new BootstrapFixture();
const status = signal("keeping the app state current from the native module");

function assert(condition: boolean, message: string) {
	if (!condition) throw new Error(message);
}

/** Waits for a state that only a runtime event can bring. */
async function eventually(done: () => boolean, message: string) {
	const deadline = Date.now() + 10_000;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`timed out: ${message}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

async function run() {
	const client = new NshPiloClient(new Pilo(fixture.dataDir()));
	let bootstraps = 0;
	const bootstrap = client.bootstrap.bind(client);
	client.bootstrap = () => {
		bootstraps += 1;
		return bootstrap();
	};
	const store = new AppStore(client);
	const state = store.state;
	try {
		assert(state().status.type === "starting", "the state did not start empty");
		await store.start();
		const local = state().projects.find(
			(project) => project.connection.id === "local",
		);
		assert(
			state().status.type === "ready" &&
				local !== undefined &&
				state().chatSessions.length === 0 &&
				state().preferences?.revision === 0 &&
				state().themeSettings !== null &&
				Object.keys(state().readStates).length === 0 &&
				Object.keys(state().sessionIndexes).length === 0,
			`unexpected first state: ${JSON.stringify(state())}`,
		);
		if (!local) return;

		const saved = await client.savePreferences({ locale: "zh-CN" });
		await eventually(
			() => state().preferences?.revision === saved.revision,
			"saved preferences did not reach the state",
		);
		assert(
			state().preferences?.values.locale === "zh-CN",
			"the state shows other preferences than the saved ones",
		);
		const dark = await client.saveThemeSettings({ theme: "dark" });
		await eventually(
			() => state().themeSettings?.revision === dark.revision,
			"saved theme settings did not reach the state",
		);
		assert(state().themeSettings?.theme === "dark", "theme was not applied");

		await store.loadSessions(local.id);
		assert(
			state().sessionIndexes[local.id]?.status === "loaded" &&
				state().sessionIndexes[local.id]?.sessions.length === 0,
			"a fresh workspace did not load an empty session list",
		);
		fixture.seedIndexedSession(local.id, local.path);
		const sessionPath = fixture.seedSessionReadState(local.id);
		// Seeding writes behind the runtime's back, so load the snapshot again.
		await store.retry();
		await eventually(
			() => state().sessionIndexes[local.id]?.status === "loaded",
			"the loaded session list was not loaded again with the snapshot",
		);
		assert(
			state().sessionIndexes[local.id]?.sessions[0]?.piSessionId ===
				"saved-session" && isSessionUnread(state(), local.id, sessionPath),
			"the indexed session or its unread turn did not reach the state",
		);
		const completed = Object.values(state().readStates)[0]?.completedRevision;
		await client.markSessionRead(local.id, sessionPath, completed ?? 0);
		await eventually(
			() => !isSessionUnread(state(), local.id, sessionPath),
			"marking the session read did not reach the state",
		);

		store.stop();
		const before = bootstraps;
		for (let save = 0; save < OVERFLOWING_SAVES; save += 1) {
			await client.savePreferences({
				locale: save % 2 === 0 ? "en-US" : "zh-CN",
			});
		}
		await store.start();
		const last = await client.savePreferences({ locale: "en-US" });
		await eventually(
			() => state().preferences?.revision === last.revision,
			"events after the gap did not reach the state",
		);
		assert(
			last.revision === saved.revision + OVERFLOWING_SAVES + 1 &&
				state().status.type === "ready" &&
				bootstraps === before + 2,
			`expected the start and one resync, got ${bootstraps - before} bootstraps`,
		);

		await client.shutdown();
		await eventually(
			() => state().status.type === "closed",
			"the runtime shutdown did not close the state",
		);
		assert(bootstraps === before + 2, "the closed stream was loaded again");
	} finally {
		store.stop();
		await client.shutdown();
	}
	status.set("app state followed the native module through a gap and shutdown");
}

mount(() => (
	<View>
		<Text>{status}</Text>
	</View>
));

void run().catch((error: unknown) => status.set(String(error)));

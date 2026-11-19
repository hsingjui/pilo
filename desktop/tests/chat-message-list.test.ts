import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 720 } as const;

function openList(scenario: string, storage: Record<string, string> = {}) {
	return open("./chat-message-list-fixture.tsx", {
		...desktop,
		storage: { "fixture.scenario": scenario, ...storage },
	});
}

test("a chat being read shows the history skeleton and no message", async () => {
	const app = await openList("loading");
	await app.waitFor("id:chat-history-loading");
	expect(app.shows("id:chat-messages")).toBe(false);
	expect(app.shows("id:chat-load-failed")).toBe(false);
	expect(app.texts()).toEqual([]);
});

test("a chat that could not be read says why and reads again on retry", async () => {
	const app = await openList("failed");
	await app.waitFor("id:chat-load-failed");
	expect(app.shows("id:chat-load-failed >> text:Failed to load session")).toBe(
		true,
	);
	expect(
		app.shows(
			"id:chat-load-failed >> text:The session file could not be opened.",
		),
	).toBe(true);
	expect(app.shows("id:chat-messages")).toBe(false);

	await app.press("id:chat-load-retry");
	await app.waitFor("id:chat-load-failed >> text:The session file is locked.");
	expect(app.shows("text:The session file could not be opened.")).toBe(false);
	expect(app.enabled("id:chat-load-retry")).toBe(true);

	await app.press("id:chat-load-retry");
	await app.waitFor("id:chat-messages");
	expect(app.shows("id:chat-load-failed")).toBe(false);
	expect(app.texts()).toContain("Summarize what changed.");
});

test("a turn that cannot be rebuilt is waited for", async () => {
	const app = await openList("waiting");
	await app.waitFor("id:chat-turn-waiting");
	expect(app.shows("id:chat-turn-waiting >> text:Waiting for response…")).toBe(
		true,
	);
	expect(app.shows("id:chat-messages")).toBe(false);
	expect(app.shows("id:chat-load-retry")).toBe(false);
});

test("a chat without messages shows what its owner gives for it", async () => {
	const app = await openList("empty");
	await app.waitFor("id:chat-empty");
	expect(app.shows("id:chat-empty >> text:No messages yet")).toBe(true);
	expect(app.shows("id:chat-messages")).toBe(false);
});

test("a settled chat shows its prompts, replies and how each turn ended", async () => {
	const app = await openList("history");
	await app.waitFor("id:chat-messages");
	expect(app.texts()).toEqual([
		"Where does the sidebar read its sessions from?",
		"09:00",
		"From the session index of each project.\n\nThe sidebar asks the app store for a project's index when the project is expanded, and the store reads it through the Pilo client. Pi's JSONL files stay the source of truth; the index only lists them.",
		"09:00",
		"Context compacted · 48,210 tokens · 09:01",
		"Rename the helper and run the checks.",
		"09:02",
		"Renamed `sidebarSessions` and started the checks.",
		"Stopped",
		"Try once more.",
		"09:03",
		"The model returned an empty response.",
		"09:03",
		"Summarize what changed.",
		"09:04",
		"One helper was renamed; nothing else changed.",
		"09:04",
	]);
	expect(app.shows("id:chat-history-loading")).toBe(false);
});

test("a reply still coming shows its text so far and that more is on its way", async () => {
	const app = await openList("streaming");
	await app.waitFor("id:chat-messages >> text:Running");
	expect(app.shows("id:chat-reply-streaming")).toBe(true);
	expect(app.texts().slice(-3)).toEqual(["And the tests?", "09:05", "Running"]);
});

test("a settled chat shows no reply as still coming", async () => {
	const app = await openList("history");
	await app.waitFor("id:chat-messages");
	expect(app.shows("id:chat-reply-streaming")).toBe(false);
});

test("a long chat opens on its last messages and renders only rows near them", async () => {
	const app = await openList("long", { "fixture.count": "400" });
	await app.waitFor("id:chat-messages >> text:Answer 200");
	expect(app.shows("text:Question 1")).toBe(false);
	expect(app.texts().length).toBeLessThan(200);
});

test("scrolling back shows a chat's earlier messages in place of its last", async () => {
	const app = await openList("long", { "fixture.count": "40" });
	await app.waitFor("id:chat-messages >> text:Answer 20");
	expect(app.shows("text:Question 1")).toBe(false);

	// The native target drags at the speed of a hand: keep the way short.
	await app.scroll("id:chat-messages", -4000);
	await app.waitFor("id:chat-messages >> text:Question 1");
	expect(app.shows("text:Answer 20")).toBe(false);
});

test("another chat never shows under the rows or the position of the last", async () => {
	const app = await openList("switching", { "fixture.count": "40" });
	await app.waitFor("id:chat-messages >> text:Summarize what changed.");
	await app.scroll("id:chat-messages", -300);

	await app.press("id:switch");
	await app.waitFor("id:chat-history-loading");
	expect(app.shows("id:chat-messages")).toBe(false);
	expect(app.shows("text:Summarize what changed.")).toBe(false);

	await app.press("id:load");
	await app.waitFor("id:chat-messages >> text:Answer 20");
	expect(app.shows("text:Summarize what changed.")).toBe(false);
	expect(app.shows("id:chat-history-loading")).toBe(false);
});

// The store reads 256 messages when no window is given; a list fed a whole
// long chat must open as fast, since only the rows near its end are made.
for (const count of [256, 10_000]) {
	test(`a chat of ${count} messages opens on its last reply within a second`, async () => {
		const app = await openList("opening", { "fixture.count": String(count) });
		await app.waitFor("id:chat-history-loading");
		const started = Date.now();
		await app.press("id:open");
		await app.waitFor(`id:chat-messages >> text:Answer ${count / 2}`);
		const shown = Date.now() - started;
		const inApp = () =>
			app.texts().find((text) => text.startsWith("Last reply shown in "));
		await app.waitUntil(() => inApp() !== undefined);
		console.log(`${count} messages: ${inApp()}; on screen after ${shown} ms`);
		expect(shown).toBeLessThan(1000);
		expect(app.shows("text:Question 1")).toBe(false);
	});
}

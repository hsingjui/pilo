import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 720 } as const;

// A tool row reads as one text: its name, an en space, then its preview.
const EDIT = "text:Edit\u2002main.ts";
const RUN = "text:Run\u2002pnpm test";
const TASKS = "text:Tasks\u20021/2 done";

function openChat(scenario: string) {
	return open("./chat-activity-fixture.tsx", {
		...desktop,
		storage: { "fixture.scenario": scenario },
	});
}

test("a finished turn folds its work behind how long it worked, under the final text", async () => {
	const app = await openChat("settled");
	await app.waitFor("text:Final answer: x is now 2.");
	expect(app.shows("text:Worked for 1m 15s")).toBe(true);
	expect(app.shows("text:The file sets x to 1.")).toBe(false);
	expect(app.shows(RUN)).toBe(false);
});

test("opening the work shows its groups folded behind what each did", async () => {
	const app = await openChat("settled");
	await app.waitFor("text:Worked for 1m 15s");
	await app.press("text:Worked for 1m 15s");
	await app.waitFor("text:The file sets x to 1.");
	expect(app.shows("text:Thought process · Read 1 files")).toBe(true);
	expect(app.shows("text:Edited 1 files · Ran 1 commands")).toBe(true);
	expect(app.shows(RUN)).toBe(false);

	await app.press("text:Edited 1 files · Ran 1 commands");
	await app.waitFor(RUN);
	expect(app.shows(EDIT)).toBe(true);
});

test("an edit opens to its diff, a command to how it ended and its output", async () => {
	const app = await openChat("settled");
	await app.waitFor("text:Worked for 1m 15s");
	await app.press("text:Worked for 1m 15s");
	await app.waitFor("text:Edited 1 files · Ran 1 commands");
	await app.press("text:Edited 1 files · Ran 1 commands");
	await app.waitFor(EDIT);

	await app.press(EDIT);
	await app.waitFor("text:export const x = 2;");
	expect(app.shows("text:export const x = 1;")).toBe(true);

	await app.press(RUN);
	await app.waitFor("text:Exit code 0");
	expect(app.shows("text:1.5 s")).toBe(true);
	expect(app.shows("text:all passed")).toBe(true);
});

test("a thinking row says how long it thought and opens to its whole text", async () => {
	const app = await openChat("settled");
	await app.waitFor("text:Worked for 1m 15s");
	await app.press("text:Worked for 1m 15s");
	await app.waitFor("text:Thought process · Read 1 files");
	await app.press("text:Thought process · Read 1 files");
	await app.waitFor("text:Thought for 3s");
	// Closed, it shows its last line only.
	expect(app.shows("text:Then change x.")).toBe(true);
	expect(app.shows("text:Look at the file first.")).toBe(false);

	// Open, the whole text renders as Markdown: one paragraph.
	await app.press("text:Thought for 3s");
	await app.waitFor("text:Look at the file first. Then change x.");
});

test("with folding and durations off, the work shows open and untimed", async () => {
	const app = await openChat("expanded");
	await app.waitFor("text:Final answer: x is now 2.");
	expect(app.shows("text:Work activity")).toBe(true);
	expect(app.shows("text:Worked for 1m 15s")).toBe(false);
	expect(app.shows("text:The file sets x to 1.")).toBe(true);
	expect(app.shows(RUN)).toBe(true);
	expect(app.shows(EDIT)).toBe(true);
});

test("a running turn keeps its work open and says what it is doing", async () => {
	const app = await openChat("running");
	await app.waitFor("text:Run…");
	expect(app.shows("text:Work activity")).toBe(true);
	expect(app.shows(RUN)).toBe(true);
	// The group a text has followed is finished, so it folds.
	expect(app.shows("text:Thought process · Read 1 files")).toBe(true);
	expect(app.shows("id:chat-reply-streaming >> text:Processing…")).toBe(true);
	expect(app.shows("id:chat-reply-footer")).toBe(false);
});

test("a turn with nothing back yet says it waits for the response", async () => {
	const app = await openChat("waiting");
	await app.waitFor("id:chat-reply-streaming >> text:Waiting for response…");
	expect(app.shows("id:chat-reply-footer")).toBe(false);
});

test("a turn still thinking says so", async () => {
	const app = await openChat("thinking");
	await app.waitFor("id:chat-reply-streaming >> text:Thinking…");
	expect(app.shows("text:Processing…")).toBe(false);
});

test("a turn that only answered says when it ended and how long it worked", async () => {
	const app = await openChat("answered");
	await app.waitFor("text:x is 1.");
	expect(app.shows("id:chat-reply-streaming")).toBe(false);
	expect(app.shows("id:chat-reply-footer >> text:09:00")).toBe(true);
	expect(app.shows("id:chat-reply-duration")).toBe(true);
	expect(app.texts().slice(-4)).toEqual(["x is 1.", "09:00", "·", "5s"]);
});

test("with durations off, the footer keeps only when the turn ended", async () => {
	const app = await openChat("untimed");
	await app.waitFor("text:x is 1.");
	expect(app.shows("id:chat-reply-footer >> text:09:00")).toBe(true);
	expect(app.shows("id:chat-reply-duration")).toBe(false);
});

test("a turn that worked says how long only on its work, not in the footer", async () => {
	const app = await openChat("settled");
	await app.waitFor("text:Worked for 1m 15s");
	expect(app.shows("id:chat-reply-footer >> text:09:01")).toBe(true);
	expect(app.shows("id:chat-reply-duration")).toBe(false);
});

test("a task list tool shows its progress and opens to its tasks", async () => {
	const app = await openChat("todos");
	await app.waitFor("text:Planned.");
	await app.press("text:Worked for 4s");
	await app.waitFor("text:Ran 1 commands");
	await app.press("text:Ran 1 commands");
	await app.waitFor(TASKS);

	await app.press(TASKS);
	await app.waitFor("text:Change x");
	expect(app.shows("text:Read the file")).toBe(true);
});

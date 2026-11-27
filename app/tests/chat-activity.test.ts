import { expect, open, test } from "nsh/test";
import {
	createReadingIconAlignment,
	readingIconOpticalOffset,
} from "../chat/chat-reading-font";

const desktop = {
	platform: "macos",
	width: 1100,
	height: 720,
	locale: "en-US",
} as const;

// A tool row reads as one text: its name, an en space, then its preview.
const EDIT = "text:Edit\u2002main.ts";
const RUN = "text:Run\u2002pnpm test";
const RUNNING = "Running\u2002pnpm test";
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

	// Collapsing the tool row again unmounts its detail subtree immediately.
	await app.press(RUN);
	expect(app.shows("text:Exit code 0")).toBe(false);
	expect(app.shows("text:all passed")).toBe(false);
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

test("compact output shows a live timer, dot, and collapsible activity groups while running", async () => {
	const app = await openChat("compactRunning");
	await app.waitFor("id:chat-compact-live-preview");
	expect(app.shows("id:chat-compact-live-dot")).toBe(true);
	// Header ticks live from the turn start time (62s ago -> 1m 02s+).
	const initialTitle = app
		.texts()
		.find((item) => /^Working for 1m 0\ds$/.test(item));
	expect(initialTitle).toBeDefined();
	expect(app.shows("id:chat-compact-step-count")).toBe(false);
	expect(
		app.shows(
			"id:chat-compact-activity-toggle >> id:chat-compact-header-title",
		),
	).toBe(false);
	const firstGroup = "Thought process · Read 1 files";
	const narration = "The file sets x to 1.";
	const inOrder = [firstGroup, narration, RUNNING];
	expect(app.texts().filter((item) => inOrder.includes(item))).toEqual(inOrder);
	expect(app.shows(EDIT)).toBe(false);
	expect(app.shows("id:chat-reply-streaming")).toBe(false);

	// The elapsed timer advances while the turn runs.
	await app.waitFor(`text:${initialTitle}`, { state: "gone" });
	const laterTitle = app
		.texts()
		.find((item) => item.startsWith("Working for "));
	expect(laterTitle).toBeDefined();
	expect(laterTitle).not.toBe(initialTitle);

	await app.press(`text:${firstGroup}`);
	await app.waitFor("text:Thought for 3s");
	expect(app.shows(EDIT)).toBe(false);

	await app.press("id:chat-compact-activity-preview");
	await app.waitFor(EDIT);
	expect(app.shows(RUN)).toBe(true);
	expect(app.shows("text:Thought for 3s")).toBe(true);

	await app.press(`text:${firstGroup}`);
	await app.waitFor("text:Thought for 3s", { state: "gone" });
	expect(app.shows(EDIT)).toBe(true);

	await app.press("id:chat-compact-activity-preview");
	await app.waitFor("id:chat-compact-activity-body", { state: "gone" });
});

test("compact output shows starting, sending, and waiting phases before output arrives", async () => {
	for (const [scenario, label] of [
		["compactStarting", "Starting…"],
		["compactSending", "Sending…"],
		["compactWaiting", "Waiting for response…"],
	]) {
		const app = await openChat(scenario);
		await app.waitFor(`id:chat-reply-streaming >> text:${label}`);
		expect(app.shows("id:chat-compact-header-title")).toBe(true);
		expect(app.shows("id:chat-compact-header-divider")).toBe(true);
		expect(app.texts().some((item) => /^Working for \d+s$/.test(item))).toBe(
			true,
		);
		expect(app.shows("id:chat-compact-live-dot")).toBe(false);
	}

	const untimedWaiting = await openChat("compactWaitingUntimed");
	await untimedWaiting.waitFor(
		"id:chat-reply-streaming >> text:Waiting for response…",
	);
	expect(untimedWaiting.shows("id:chat-compact-header-title")).toBe(false);
	expect(untimedWaiting.shows("id:chat-compact-header-divider")).toBe(false);
	expect(untimedWaiting.shows("id:chat-compact-live-dot")).toBe(false);
});

test("compact output shows the latest thought line above live thinking", async () => {
	const app = await openChat("compactThinking");
	await app.waitFor("id:chat-compact-activity-preview");
	expect(app.shows("id:chat-compact-live-dot")).toBe(true);
	expect(
		app.shows("id:chat-compact-thought-preview >> text:Then change x."),
	).toBe(true);
	expect(app.shows("id:chat-compact-activity-preview >> text:Thinking…")).toBe(
		true,
	);
	expect(app.shows("id:chat-reply-streaming")).toBe(false);
});

test("compact output hides the live timer when work durations are off", async () => {
	const app = await openChat("compactUntimed");
	await app.waitFor("id:chat-compact-live-preview");
	expect(app.shows("id:chat-compact-live-dot")).toBe(true);
	expect(app.shows("id:chat-compact-activity >> text:Work activity")).toBe(
		true,
	);
	expect(app.texts().some((item) => item.startsWith("Working for "))).toBe(
		false,
	);
});

test("compact output folds completed work behind one header and expands the full process directly", async () => {
	const app = await openChat("compactSettled");
	await app.waitFor("text:Final answer: x is now 2.");
	expect(app.shows("id:chat-compact-live-dot")).toBe(false);
	const toggle = "id:chat-compact-activity-toggle";
	expect(app.count(toggle)).toBe(1);
	expect(app.shows(`${toggle} >> text:Worked for 1m 15s`)).toBe(true);
	expect(app.shows("text:The file sets x to 1.")).toBe(false);
	expect(app.shows(RUN)).toBe(false);

	await app.press(toggle);
	await app.waitFor("id:chat-compact-activity-body");
	expect(app.count(toggle)).toBe(1);
	expect(
		app.shows(
			"id:chat-compact-activity-body >> text:Final answer: x is now 2.",
		),
	).toBe(false);
	expect(app.shows("text:Thought for 3s")).toBe(true);
	expect(app.shows("text:The file sets x to 1.")).toBe(true);
	expect(app.shows(EDIT)).toBe(true);
	expect(app.shows(RUN)).toBe(true);
});

test("a failed compact reply keeps its last text copyable after trailing work", async () => {
	const app = await openChat("compactFailed");
	await app.waitFor("text:The file sets x to 1.");
	expect(app.shows("text:The turn failed.")).toBe(true);
	expect(app.shows("id:chat-compact-activity-body")).toBe(false);
	await app.hover("text:The file sets x to 1.");
	await app.press("id:chat-reply-footer >> id:chat-copy-message");
	expect(app.clipboard()).toBe("The file sets x to 1.");
});

test("compact output with completed-work folding off shows the scrollable full process open", async () => {
	const app = await openChat("compactExpanded");
	await app.waitFor("text:Final answer: x is now 2.");
	expect(app.shows("id:chat-compact-activity-body")).toBe(true);
	expect(app.shows("text:The file sets x to 1.")).toBe(true);
	expect(app.shows(EDIT)).toBe(true);
	expect(app.shows(RUN)).toBe(true);
});

test("compact output switches each group to a summary once trailing text starts streaming", async () => {
	const app = await openChat("compactStreamingText");
	await app.waitFor("text:Streaming final answer...");
	expect(app.shows("id:chat-compact-live-dot")).toBe(true);
	expect(app.texts().some((item) => /^Working for 1m 0\ds$/.test(item))).toBe(
		true,
	);
	expect(app.shows("text:Thought process · Read 1 files")).toBe(true);
	expect(app.shows("text:Edited 1 files · Ran 1 commands")).toBe(true);
	expect(app.shows("id:chat-compact-live-preview")).toBe(false);
	expect(app.shows("id:chat-reply-streaming")).toBe(false);
});

test("compact output shows a static folded header when a turn was aborted", async () => {
	const app = await openChat("compactAborted");
	await app.waitFor("text:Stopped");
	expect(app.shows("id:chat-compact-live-dot")).toBe(false);
	expect(app.shows("text:Worked for 8s")).toBe(true);
	expect(app.shows("text:The file sets x to 1.")).toBe(true);
	expect(app.shows("id:chat-compact-live-preview")).toBe(false);
	expect(app.shows("id:chat-reply-streaming")).toBe(false);

	await app.press("id:chat-compact-activity-toggle");
	await app.waitFor("id:chat-compact-activity-body");
	expect(app.shows("text:Thought for 3s")).toBe(true);
});

test("a work-only continuation split by compaction omits the empty reply footer", async () => {
	const app = await openChat("compactedContinuation");
	await app.waitFor("text:Context compacted · 2,575 tokens · 09:00");
	expect(app.shows("text:Ran 1 commands")).toBe(true);
	expect(app.shows("id:chat-reply-footer")).toBe(false);
});

test("whitespace-only trailing text does not collapse a tool group", async () => {
	const app = await openChat("whitespaceOnlyText");
	await app.waitFor("text:Ran 1 commands");
	expect(app.shows("text:codemode")).toBe(true);
});

test("activity row icons derive optical offset from actual text metrics", () => {
	// Balanced fonts (e.g. HarmonyOS Sans SC, Microsoft YaHei UI, PingFang SC)
	// need no downward shift.
	expect(
		readingIconOpticalOffset({
			ascender: 14.85,
			descender: 3.9,
			capHeight: 11.2,
		}),
	).toBe(0);
	expect(
		readingIconOpticalOffset({
			ascender: 16.25,
			descender: 4.07,
			capHeight: 12.1,
		}),
	).toBe(0);
	expect(readingIconOpticalOffset(null)).toBe(0);
	// Top-heavy fonts (e.g. Segoe UI, Noto Sans SC) get a measured nudge.
	expect(
		readingIconOpticalOffset({
			ascender: 17.26,
			descender: 4.02,
			capHeight: 11.2,
		}),
	).toBe(1);
	// Negative descender sign convention produces the same result.
	expect(
		readingIconOpticalOffset({
			ascender: 17.26,
			descender: -4.02,
			capHeight: 11.2,
		}),
	).toBe(1);

	const balanced = { ascender: 16.47, descender: 5.53, capHeight: 11.2 };
	const topHeavy = { ascender: 17.62, descender: 4.38, capHeight: 11.2 };
	const firstRow = createReadingIconAlignment();
	const otherRow = createReadingIconAlignment();
	firstRow.onTextLayout({ lines: [topHeavy] });
	otherRow.onTextLayout({ lines: [balanced] });
	expect(firstRow.style()).toEqual({ transform: [{ translateY: 1 }] });
	expect(otherRow.style()).toBeUndefined();

	firstRow.onTextLayout({ lines: [balanced] });
	expect(firstRow.style()).toBeUndefined();
});

import { type App, expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 720 } as const;

function openChat(count: number, unloaded = 0) {
	return open("./chat-message-follow-fixture.tsx", {
		...desktop,
		storage: {
			"fixture.count": String(count),
			"fixture.lines": "30",
			"fixture.unloaded": String(unloaded),
		},
	});
}

/** How many prompt rows the list has made so far. */
function rowsMade(app: App) {
	const made = app.texts().find((text) => text.endsWith(" prompt rows made"));
	return Number(made?.split(" ")[0]);
}

type Measure = Awaited<ReturnType<typeof measure>>;

/** Where the fixture says its anchor prompt and the end of the list are. */
async function measure(app: App) {
	const before = app.texts().find((text) => text.includes(", end at "));
	await app.press("id:measure");
	let measured: string | undefined;
	await app.waitUntil(() => {
		measured = app.texts().find((text) => text.includes(", end at "));
		return measured !== undefined && measured !== before;
	});
	const [, prompt, y, end, height] =
		/^#\d+: (.*) at (-?\d+), end at (-?\d+) of (\d+)$/.exec(measured ?? "") ??
		[];
	return { prompt, y: Number(y), end: Number(end), height: Number(height) };
}

/**
 * Whether a platform draws the app. The headless engine moves a list's
 * offset as its last row grows but leaves the rows where they were, so only
 * a platform shows the end of the list being followed. `nsh/test` does not
 * say which target runs a test; a screenshot, which only a platform can
 * take, does.
 */
function drawn(app: App) {
	return app.screenshot().then(
		() => true,
		() => false,
	);
}

/** Streams lines into the reply, a frame apart, up to line `upTo`. */
async function stream(app: App, upTo: number) {
	await app.press("id:stream");
	await app.waitFor(`text:streamed ${upTo}`);
}

/** Waits for the reply's row to show line `upTo`, at the end of the list. */
function replyShows(app: App, upTo: number) {
	return app.waitUntil(() =>
		app.texts().some((text) => text === `Reply line ${upTo}`),
	);
}

/**
 * Measures until `laidOut` holds, for a change the list lays out under the
 * viewport, where no row shows it. Returns the last measure either way, for
 * the assertions that follow to judge.
 */
async function measureOnce(app: App, laidOut: (at: Measure) => boolean) {
	const deadline = Date.now() + 5_000;
	let at = await measure(app);
	while (!laidOut(at) && Date.now() < deadline) at = await measure(app);
	return at;
}

test("at its end the list follows a reply as it streams and when it settles", async () => {
	const app = await openChat(40);
	await app.waitFor("id:chat-messages >> text:Answer 20");
	const follows = await drawn(app);
	// The prompt and the reply's first row are followed on every target.
	await app.press("id:prompt");
	let at = await measure(app);
	expect(at.end).toBeLessThan(at.height);
	expect(at.end).toBeGreaterThan(at.height - 80);

	await stream(app, 30);
	await replyShows(app, 30);
	at = await measure(app);
	if (follows) {
		expect(at.end).toBeLessThan(at.height);
		expect(at.end).toBeGreaterThan(at.height - 80);
	}
	expect(app.shows("id:chat-scroll-latest")).toBe(false);
	expect(app.shows("id:chat-reply-streaming")).toBe(true);

	await app.press("id:end");
	await app.waitFor("id:chat-reply-streaming", { state: "gone" });
	at = await measure(app);
	if (follows) expect(at.end).toBeLessThan(at.height);
	expect(app.shows("id:chat-scroll-latest")).toBe(false);
});

test("scrolled up, the rows in view stay where they are while a reply streams", async () => {
	const app = await openChat(40);
	await app.waitFor("id:chat-messages >> text:Answer 20");
	await app.scroll("id:chat-messages", -600);
	const before = await measure(app);
	expect(before.end).toBeGreaterThan(before.height);
	await app.waitFor("id:chat-scroll-latest");

	await app.press("id:prompt");
	await stream(app, 30);
	const grown = before.end + 30 * 20;
	const during = await measureOnce(app, (at) => at.end > grown);
	expect(during.prompt).toBe(before.prompt);
	expect(during.y).toBe(before.y);
	// The reply grew under the viewport instead.
	expect(during.end).toBeGreaterThan(grown);

	await app.press("id:end");
	await app.waitFor("id:chat-reply-streaming", { state: "gone" });
	const after = await measure(app);
	expect(after.prompt).toBe(before.prompt);
	expect(after.y).toBe(before.y);
	expect(app.shows("id:chat-scroll-latest")).toBe(true);
});

test("a chat that grows past 16 messages keeps the rows in view where they are", async () => {
	const app = await openChat(14);
	await app.waitFor("id:chat-messages >> text:Answer 7");
	await app.scroll("id:chat-messages", -300);
	const before = await measure(app);

	// The turn makes it 16 messages; the Tauri list changed how it rendered there.
	await app.press("id:prompt");
	await stream(app, 30);
	const grown = before.end + 30 * 20;
	const sixteen = await measureOnce(app, (at) => at.end > grown);
	expect(sixteen.end).toBeGreaterThan(grown);
	expect(sixteen.y).toBe(before.y);

	// The next turn's rows are beyond the ones the list makes: they add
	// their estimated height to the end, whatever streams into them.
	await app.press("id:end");
	await app.waitFor("id:chat-reply-streaming", { state: "gone" });
	await app.press("id:prompt");
	await stream(app, 60);
	const after = await measureOnce(app, (at) => at.end > sixteen.end);
	expect(after.end).toBeGreaterThan(sixteen.end);
	expect(after.prompt).toBe(before.prompt);
	expect(after.y).toBe(before.y);
});

// A read names every reply anew; with history the store has not loaded,
// the messages it has read stay the ones the list reported, with boxes
// standing for the rest: a row is its message's place, so neither remakes
// a row.
for (const unloaded of [0, 20]) {
	test(`a chat read again ${unloaded ? "with its unread history " : ""}keeps the rows in view and makes none anew`, async () => {
		const app = await openChat(40, unloaded);
		await app.waitFor("id:chat-messages >> text:Answer 20");
		await app.scroll("id:chat-messages", -600);
		const before = await measure(app);
		const made = rowsMade(app);

		await app.press("id:reread");
		const after = await measure(app);
		expect(after.prompt).toBe(before.prompt);
		expect(after.y).toBe(before.y);
		expect(after.end).toBe(before.end);
		expect(rowsMade(app)).toBe(made);
	});
}

// The list tells the store which rows are on screen; the store's read
// turns them into messages, and the rows below the viewport stay boxes at
// their messages' estimated heights.
test("a chat's unread messages show as placeholders that load where the list shows them", async () => {
	const app = await openChat(60, 40);
	await app.waitFor("id:chat-messages >> text:Answer 30");
	const ranges = () =>
		app.texts().find((text) => text.startsWith("visible:")) ?? "";
	// Opened at the end, the reported range ends at the last message.
	await app.waitUntil(() => ranges().includes("-59"));

	// Scrolled into the unread part: boxes stand where those messages are.
	await app.scroll("id:chat-messages", -2400);
	await app.waitUntil(() => app.shows("id:chat-history-placeholder"));
	// The reported range follows into them; the fixture's read turns the
	// shown messages into rows, and the boxes above stay.
	await app.waitUntil(() => {
		const last = ranges().split(",").filter(Boolean).at(-1);
		return last !== undefined && Number(last.split("-")[0]) < 40;
	});
	await app.waitUntil(() =>
		app.texts().some((text) => /^Answer ([1-9]|1[0-9]|20)$/.test(text)),
	);
});

// Every streamed event hands the list a new joined array; at 10,000
// messages the cost of one is a pass over it, not a rebuild of the rows.
test("one streamed event of a 10,000-message chat costs the list one pass", async () => {
	const app = await openChat(10_000);
	await app.waitFor("id:chat-messages >> text:Answer 5000");
	await app.press("id:prompt");
	await stream(app, 30);
	await replyShows(app, 30);
	const label = app.texts().find((text) => text.startsWith("event at most "));
	const ms = Number(/event at most (\d+) ms/.exec(label ?? "")?.[1]);
	console.log(`one streamed event at 10,000 messages took at most ${ms} ms`);
	expect(ms).toBeLessThan(100);
});

// Where a chat was read to is kept while another opens; opening it again
// puts the same rows where they were, its place in the chat and its offset
// past the row alike.
test("a chat opened again comes back where it was read to", async () => {
	const app = await openChat(60);
	await app.waitFor("id:chat-messages >> text:Answer 30");
	await app.scroll("id:chat-messages", -2400);
	await app.waitFor("id:chat-scroll-latest");
	const before = await measure(app);

	await app.press("id:other");
	await app.waitFor("id:chat-messages >> text:Answer 10");

	await app.press("id:other");
	const after = await measureOnce(app, (at) => at.prompt === before.prompt);
	expect(after.prompt).toBe(before.prompt);
	// The headless engine restores the row but not its offset; a platform
	// puts both back.
	if (await drawn(app)) {
		expect(Math.abs(after.y - before.y)).toBeLessThan(4);
	}
});

test("the way back to the latest message returns to the end, and the list follows again", async () => {
	const app = await openChat(40);
	await app.waitFor("id:chat-messages >> text:Answer 20");
	expect(app.shows("id:chat-scroll-latest")).toBe(false);
	await app.scroll("id:chat-messages", -600);
	await app.waitFor("id:chat-scroll-latest");
	await app.press("id:prompt");
	await stream(app, 30);

	await app.press("id:chat-scroll-latest");
	await app.waitFor("id:chat-scroll-latest", { state: "gone" });
	let at = await measure(app);
	expect(at.end).toBeLessThan(at.height);

	await stream(app, 60);
	await replyShows(app, 60);
	at = await measure(app);
	if (await drawn(app)) expect(at.end).toBeLessThan(at.height);
	expect(app.shows("id:chat-scroll-latest")).toBe(false);
});

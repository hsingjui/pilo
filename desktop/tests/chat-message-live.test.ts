import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 720 } as const;

test("the list shows a saved chat from the transcript store, then its running turn", async () => {
	const app = await open("./chat-message-live-fixture.tsx", desktop);
	await app.waitFor("id:chat-messages >> text:Saved question 10");
	expect(app.shows("id:chat-history-loading")).toBe(false);
	expect(app.shows("id:chat-reply-streaming")).toBe(false);
	expect(app.texts()).toContain(
		"Saved answer 10\nIt runs over a few lines,\nas a reply usually does.",
	);

	await app.press("id:prompt");
	await app.waitFor("id:chat-messages >> text:new question", {
		timeout: 15_000,
	});
	await app.waitFor("id:chat-messages >> text:partial reply");
	await app.waitFor("id:chat-reply-streaming");
	// The read that put the chat on its snapshot kept the messages on screen.
	expect(app.shows("id:chat-messages >> text:Saved question 10")).toBe(true);
	expect(app.shows("id:chat-load-failed")).toBe(false);
});

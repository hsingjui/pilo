import { expect, open, test } from "nsh/test";

const desktop = { platform: "macos", width: 1100, height: 720 } as const;

function openChat(storage: Record<string, string> = {}) {
	return open("./chat-outline-fixture.tsx", { ...desktop, storage });
}

test("the rail lists one tick per user message and a press jumps to it", async () => {
	const app = await openChat({ "fixture.count": "40" });
	await app.waitFor("id:chat-messages >> text:Answer 20");
	await app.waitFor("id:chat-outline-tick-19");

	await app.press("id:chat-outline-tick-0");
	await app.waitFor("id:chat-messages >> text:Question 1");
	expect(app.shows("id:chat-messages >> text:Answer 20")).toBe(false);

	await app.press("id:chat-outline-tick-19");
	await app.waitFor("id:chat-messages >> text:Answer 20");
});

test("a chat with one round shows no rail", async () => {
	const app = await openChat({ "fixture.count": "2" });
	await app.waitFor("id:chat-messages >> text:Answer 1");
	expect(app.shows("id:chat-outline-rail")).toBe(false);
});

test("the keyboard moves between ticks and Enter jumps", async () => {
	const app = await openChat({ "fixture.count": "40" });
	await app.waitFor("id:chat-outline-tick-0");

	await app.press("id:chat-outline-tick-5");
	await app.waitFor("id:chat-messages >> text:Question 6");

	await app.keyboard.press("arrowup");
	await app.keyboard.press("enter");
	await app.waitFor("id:chat-messages >> text:Question 5");
});

test("jumping to a round of unloaded messages asks the store for its page", async () => {
	const app = await openChat({
		"fixture.count": "40",
		"fixture.prefix": "20",
	});
	await app.waitFor("id:chat-messages >> text:Answer 10");
	await app.waitFor("id:chat-outline-tick-19");

	await app.press("id:chat-outline-tick-0");
	await app.waitUntil(() => {
		const range = app.texts().find((text) => /^\d+-\d+$/.test(text));
		if (!range) return false;
		const start = Number(range.split("-")[0]);
		return start === 0;
	});
});

import { expect, open, test } from "nsh/test";

const SAVED_KEY = JSON.stringify(["pilo", "s1"]);

async function openChat() {
	const app = await open("./open-chat-fixture.tsx", { platform: "macos" });
	await app.waitFor("id:open-saved");
	return app;
}

const shown = (app: Awaited<ReturnType<typeof openChat>>) =>
	app.texts().slice(-2);

test("no chat is open until a session is", async () => {
	const app = await openChat();
	expect(shown(app)).toEqual(["chat: null closed null", "reads: "]);
});

test("opening a saved session reads its transcript under the WebUI chat key", async () => {
	const app = await openChat();
	await app.press("id:open-saved");
	await app.waitUntil(() => shown(app)[0].endsWith("ready history"));
	expect(shown(app)).toEqual([
		`chat: ${SAVED_KEY} ready history`,
		`reads: state of ${SAVED_KEY}; history of pilo /sessions/s1.jsonl`,
	]);

	// The app state changing around the open session does not read it again.
	await app.press("id:reload");
	await app.press("id:open-saved");
	expect(shown(app)[1]).toBe(
		`reads: state of ${SAVED_KEY}; history of pilo /sessions/s1.jsonl`,
	);
});

test("a session the runtime holds a chat for opens under that chat's key", async () => {
	const app = await openChat();
	await app.press("id:open-held");
	await app.waitUntil(() => shown(app)[0].endsWith("ready history"));
	expect(shown(app)).toEqual([
		"chat: held-key ready history",
		"reads: state of held-key; history of pilo /sessions/s2.jsonl",
	]);
});

test("the chat closes when the session is closed or is not a saved one", async () => {
	const app = await openChat();
	await app.press("id:open-saved");
	await app.waitUntil(() => shown(app)[0].endsWith("ready history"));
	await app.press("id:close");
	await app.waitUntil(() => shown(app)[0] === "chat: null closed null");

	await app.press("id:open-held");
	await app.waitUntil(() => shown(app)[0].endsWith("ready history"));
	await app.press("id:open-unknown");
	await app.waitUntil(() => shown(app)[0] === "chat: null closed null");
});

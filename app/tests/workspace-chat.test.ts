import { expect, open, test } from "nsh/test";

/** The sidebar fixture with `pilo` expanded, so its sessions can be opened. */
async function openApp() {
	const app = await open("./sidebar-projects-fixture.tsx", {
		platform: "macos",
		width: 1200,
		height: 800,
		storage: {
			"pilo.collapsedSections@local": JSON.stringify({ "ws:pilo": false }),
		},
	});
	await app.waitFor("id:session:s4");
	return app;
}

test("the workspace shows the open session's messages, and the project's page without one", async () => {
	const app = await openApp();
	// The workspace starts on a new chat in the first project: its landing.
	await app.waitFor("id:workspace >> id:chat-empty >> id:workspace-title");
	expect(app.shows("id:chat-messages")).toBe(false);

	await app.press("id:session:s4");
	await app.waitFor("id:workspace >> id:chat-messages");
	const chat = "id:workspace >> id:chat-messages >> ";
	for (const text of [
		"Resize the sidebar",
		"The sidebar now takes a width.",
		"Keep it between launches",
		"The width is stored.",
	]) {
		expect(app.shows(`${chat}text:${text}`)).toBe(true);
	}
	expect(app.shows("id:workspace-title")).toBe(false);

	// Selecting the project leaves the session for its new-chat draft.
	await app.press("id:ws:pilo:select");
	await app.waitFor("id:workspace >> id:chat-empty >> id:workspace-title");
	expect(app.shows("id:chat-messages")).toBe(false);
});

test("each session keeps its own draft without leaking across sessions", async () => {
	const app = await openApp();
	await app.press("id:session:s4");
	await app.waitFor("id:chat-messages >> text:The width is stored.");
	await app.type("id:chat-composer-input", "keep this draft");

	await app.press("id:sidebar-new-chat");
	await app.waitFor("id:workspace >> id:chat-empty >> id:workspace-title");
	expect(app.shows("id:chat-composer-input >> text:keep this draft")).toBe(
		false,
	);
	await app.type("id:chat-composer-input", "draft for new session");
	await app.waitFor("id:chat-composer-input >> text:draft for new session");

	await app.press("id:session:s4");
	await app.waitFor("id:chat-messages >> text:The width is stored.");
	await app.waitFor("id:chat-composer-input >> text:keep this draft");
	expect(
		app.shows("id:chat-composer-input >> text:draft for new session"),
	).toBe(false);
});

test("a session without messages shows the new session page", async () => {
	const app = await openApp();
	await app.press("id:session:s6");
	await app.waitFor("id:workspace >> id:chat-empty >> id:workspace-title");
	expect(
		app.shows("id:chat-empty >> text:What would you like to work on today?"),
	).toBe(true);
	expect(app.shows("id:chat-empty >> text:pilo")).toBe(true);

	// Another session's messages take its place.
	await app.press("id:session:s4");
	await app.waitFor("id:chat-messages >> text:The width is stored.");
	expect(app.shows("id:chat-empty")).toBe(false);
});

test("a session whose history cannot be read says so, and Retry reads it again", async () => {
	const app = await openApp();
	await app.press("id:session:s7");
	await app.waitFor("id:workspace >> id:chat-load-failed");
	expect(
		app.shows("id:chat-load-failed >> text:The session file is locked."),
	).toBe(true);

	await app.press("id:chat-load-retry");
	await app.waitFor("id:chat-messages >> text:A text field and a send button.");
	expect(app.shows("id:chat-load-failed")).toBe(false);
});

import { expect, open, test } from "nsh/test";

async function openApp() {
	const app = await open("./session-header-fixture.tsx", {
		platform: "macos",
		width: 1200,
		height: 800,
		storage: {
			"pilo.collapsedSections": JSON.stringify({ "ws:pilo": false }),
		},
	});
	await app.press("id:session:s4");
	await app.waitFor("id:session-header");
	return app;
}

test("the header shows the title; the composer the run config and usage", async () => {
	const app = await openApp();
	expect(app.shows("id:session-header >> text:Resize the sidebar")).toBe(true);
	expect(app.shows("id:session-menu-trigger")).toBe(true);
	expect(app.shows("id:session-header >> text:GPT-5")).toBe(false);
	expect(app.shows("id:chat-composer >> text:GPT-5")).toBe(true);
	expect(app.shows("id:chat-composer >> text:High")).toBe(true);
	expect(app.shows("id:chat-composer >> text:21%")).toBe(true);
});

test("the session menu copies the id and renames the session", async () => {
	const app = await openApp();
	await app.press("id:session-menu-trigger");
	await app.waitFor("id:session-menu-copy-id");
	expect(app.shows("id:session-menu-copy-id >> text:s4")).toBe(true);
	expect(app.shows("id:session-menu-copy-path >> text:/s4\\.jsonl/")).toBe(
		true,
	);
	await app.press("id:session-menu-copy-path");
	expect(await app.clipboard()).toBe("/sessions/s4.jsonl");

	await app.press("id:session-menu-trigger");
	await app.waitFor("id:session-menu-rename");
	await app.press("id:session-menu-rename");
	await app.waitFor("id:session-rename-input");
	await app.clear("id:session-rename-input");
	await app.type("id:session-rename-input", "A better name");
	await app.press("id:session-rename-confirm");
	await app.waitFor("id:session:s4 >> text:A better name");
});

test("the run config menu picks a model and a thinking level", async () => {
	const app = await openApp();
	await app.press("id:run-config-trigger");
	await app.hover("text:Model");
	await app.waitFor("id:run-config-model:anthropic:sonnet-4.5");
	await app.press("id:run-config-model:anthropic:sonnet-4.5");
	await app.waitFor("id:chat-composer >> text:Sonnet 4.5");
});

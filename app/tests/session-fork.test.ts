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

test("an assistant reply shows a fork action on hover", async () => {
	const app = await openApp();
	await app.hover("text:Done.");
	await app.waitFor("id:fork:assistant-m1");
	expect(app.shows("id:fork:assistant-m2")).toBe(true);
});

test("forking at a mid-session reply opens the forked session", async () => {
	const app = await openApp();
	await app.hover("text:Done.");
	await app.waitFor("id:fork:assistant-m1");
	await app.press("id:fork:assistant-m1");
	// The forked session joins the index and becomes the open one.
	await app.waitFor("id:session:s5");
	// The source session is still there, unchanged.
	expect(app.shows("id:session:s4 >> text:Resize the sidebar")).toBe(true);
});

test("a cancelled clone reports itself instead of failing", async () => {
	const app = await openApp();
	await app.hover("text:Done again.");
	await app.waitFor("id:fork:assistant-m2");
	// The last reply ends the branch, so a clone runs; it answers cancelled.
	await app.press("id:fork:assistant-m2");
	await app.waitFor("text:Fork cancelled");
});

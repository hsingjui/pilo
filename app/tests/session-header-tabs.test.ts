import { expect, open, test } from "nsh/test";

const compactDesktop = {
	platform: "macos",
	width: 680,
	height: 520,
	locale: "en-US",
} as const;

test("collapses overflowing auxiliary tabs into +N menu and promotes selected overflow tab", async () => {
	const app = await open("./session-header-tabs-fixture.tsx", compactDesktop);
	await app.waitFor("id:session-header");
	expect(app.shows("id:workspace-tabs-divider")).toBe(false);
	expect(app.shows("id:workspace-tabs-overflow")).toBe(false);

	await app.press("id:open-many");
	await app.waitFor("id:workspace-tabs-divider");
	await app.waitFor("id:workspace-tabs-overflow");
	expect(app.shows("id:git-tab")).toBe(true);
	expect(app.shows("id:terminal-tab:t1")).toBe(false);

	// Select the overflowing terminal from the +N menu; it promotes into the visible strip.
	await app.press("id:workspace-tabs-overflow");
	await app.waitFor("id:overflow-tab:terminal:t1");
	await app.press("id:overflow-tab:terminal:t1");
	await app.waitFor("id:terminal-tab:t1");
	expect(app.shows("text:active:terminal:t1")).toBe(true);

	// Closing the promoted terminal tab returns to chat.
	await app.press("id:terminal-tab-close:t1");
	await app.waitUntil(() => !app.shows("id:terminal-tab:t1"));
	expect(app.shows("text:active:chat")).toBe(true);
});

test("shows explicit terminal new and restart controls", async () => {
	const app = await open("./session-header-tabs-fixture.tsx", compactDesktop);
	await app.waitFor("id:session-header");
	expect(app.shows("id:terminal-new-tab")).toBe(false);

	await app.press("id:open-many");
	await app.waitFor("id:terminal-new-tab");
	await app.press("id:terminal-new-tab");
	await app.waitFor("text:active:terminal:t2");
	expect(app.shows("id:terminal-restart-tab")).toBe(false);

	await app.press("id:exit-active-terminal");
	await app.waitFor("id:terminal-restart-tab");
	await app.press("id:terminal-restart-tab");
	await app.waitFor("text:active:terminal:t2-restarted");
	expect(app.shows("id:terminal-tab:t2")).toBe(false);
});

import { expect, open, test } from "nsh/test";

async function openPane() {
	const app = await open("./theme-pane-fixture.tsx", {
		platform: "macos",
		width: 900,
		height: 900,
		locale: "en-US",
	});
	await app.waitFor("id:settings-theme-mode");
	return app;
}

/** The token table is long: shrink it so the footer fits on screen. */
async function collapseTokenList(app: Awaited<ReturnType<typeof openPane>>) {
	await app.type("id:settings-theme-token-search", "zzz-no-match");
	await app.waitFor("text:No matching tokens");
}

async function restoreTokenList(app: Awaited<ReturnType<typeof openPane>>) {
	await app.clear("id:settings-theme-token-search");
	await app.waitFor("id:settings-token-light-background");
}

test("the applied saved theme shows its saved state", async () => {
	const app = await openPane();
	expect(app.shows("id:settings-theme-saved-Crimson")).toBe(true);
	expect(app.shows("id:settings-theme-saved-Old CSS")).toBe(true);
	await app.waitFor("text:Saved and applied");
	expect(app.value("id:settings-theme-name")).toBe("Crimson");
	expect(app.enabled("id:settings-theme-save")).toBe(false);
	expect(app.enabled("id:settings-theme-cancel")).toBe(false);
	expect(app.shows("text:Update and apply")).toBe(true);
});

test("the docs link opens the theme guide", async () => {
	const app = await openPane();
	await app.press("id:settings-theme-docs");
	expect(app.openedUrls()).toContain(
		"https://github.com/hsingjui/pilo/blob/main/desktop/README.md#custom-themes",
	);
});

test("search filters the token table", async () => {
	const app = await openPane();
	expect(app.shows("id:settings-token-light-background")).toBe(true);
	await app.type("id:settings-theme-token-search", "button-hover");
	await app.waitUntil(() => !app.shows("id:settings-token-light-background"));
	expect(app.shows("id:settings-token-light-button-hover")).toBe(true);
	await app.clear("id:settings-theme-token-search");
	await app.type("id:settings-theme-token-search", "no-such-token");
	await app.waitFor("text:No matching tokens");
});

test("an invalid color token shows the field error and blocks saving", async () => {
	const app = await openPane();
	await app.clear("id:settings-token-light-background");
	await app.type("id:settings-token-light-background", "not-a-color");
	await app.waitFor(
		"text:Not a valid color. Use hex (#rgb[a] or #rrggbb[aa]), rgb()/rgba(), hsl()/hsla(), or transparent.",
	);
	expect(app.shows("text:Saved and applied")).toBe(false);
	await collapseTokenList(app);
	expect(app.enabled("id:settings-theme-save")).toBe(false);
	await app.press("id:settings-theme-cancel");
	await app.waitFor("text:Saved and applied");
});

test("editing a token and saving updates the saved theme", async () => {
	const app = await openPane();
	await app.clear("id:settings-token-light-background");
	await app.type("id:settings-token-light-background", "#fafafaff");
	await collapseTokenList(app);
	await app.waitFor("text:Update and apply");
	expect(app.shows("text:Saved and applied")).toBe(false);
	await app.press("id:settings-theme-save");
	await app.waitFor("text:Saved and applied");
	expect(app.enabled("id:settings-theme-save")).toBe(false);
});

test("a new name switches the save button to save", async () => {
	const app = await openPane();
	await app.clear("id:settings-theme-name");
	await app.type("id:settings-theme-name", "Fresh");
	await collapseTokenList(app);
	await app.waitFor("text:Save and apply");
	await app.press("id:settings-theme-save");
	await app.waitFor("id:settings-theme-saved-Fresh");
	await app.waitFor("text:Saved and applied");
});

test("selecting a saved theme applies it and lists its unconverted CSS", async () => {
	const app = await openPane();
	expect(app.shows("id:settings-theme-conversion-details")).toBe(false);
	await app.press("id:settings-theme-saved-Old CSS");
	await app.waitFor("id:settings-theme-conversion-details");
	expect(app.shows("text:Unconverted CSS (1)")).toBe(true);
	expect(app.shows("text:Unsupported at-rule")).toBe(true);
	expect(app.shows("text:@media print")).toBe(true);
	expect(app.value("id:settings-theme-name")).toBe("Old CSS");
	// The CSS-only theme converts to no tokens: it is already saved.
	await collapseTokenList(app);
	await app.waitFor("text:Saved and applied");
});

test("deleting a saved theme removes it after confirming", async () => {
	const app = await openPane();
	await app.press("id:settings-theme-saved-Old CSS-delete");
	await app.waitFor("id:settings-theme-delete-dialog");
	await app.press("text:Delete");
	await app.waitFor("id:settings-theme-delete-dialog", { state: "gone" });
	expect(app.shows("id:settings-theme-saved-Old CSS")).toBe(false);
	expect(app.shows("id:settings-theme-saved-Crimson")).toBe(true);
});

test("cancel discards draft edits back to the applied theme", async () => {
	const app = await openPane();
	await app.clear("id:settings-theme-name");
	await app.type("id:settings-theme-name", "Something else");
	await app.clear("id:settings-token-light-background");
	await app.type("id:settings-token-light-background", "#000000ff");
	await collapseTokenList(app);
	await app.waitFor("text:Save and apply");
	await app.press("id:settings-theme-cancel");
	await app.waitFor("text:Saved and applied");
	expect(app.value("id:settings-theme-name")).toBe("Crimson");
	await restoreTokenList(app);
	expect(app.value("id:settings-token-light-background")).toBe("#fff8f8ff");
});

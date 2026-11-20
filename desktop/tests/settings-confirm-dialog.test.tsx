import { expect, open, test } from "nsh/test";

test("SettingsConfirmDialog confirms and cancels through its buttons", async () => {
	const app = await open("./settings-confirm-dialog-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	await app.press("id:open");
	await app.waitFor("text:Remove connection");
	expect(app.shows("text:This removes the saved connection.")).toBe(true);
	expect(app.shows("text:Outcome: idle")).toBe(true);
	await app.press("text:Remove");
	await app.waitFor("text:Outcome: confirmed");
	// Confirming does not close the dialog; the caller decides.
	expect(app.shows("text:Remove connection")).toBe(true);
	await app.press("text:Cancel");
	await app.waitFor("text:Remove connection", { state: "gone" });
	await app.waitFor("text:Outcome: closed");
});

test("SettingsConfirmDialog blocks closing while busy", async () => {
	const app = await open("./settings-confirm-dialog-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 600,
	});
	await app.press("id:open-busy");
	await app.waitFor("text:Removing…");
	expect(app.enabled("text:Cancel")).toBe(false);
	expect(app.enabled("text:Removing…")).toBe(false);
	await app.keyboard.press("escape");
	// Escape is ignored while busy: the dialog is still up.
	expect(app.shows("text:Remove connection")).toBe(true);
	expect(app.shows("text:Outcome: idle")).toBe(true);
});

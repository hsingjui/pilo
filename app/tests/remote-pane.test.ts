import { expect, open, test } from "nsh/test";

async function openPane(platform: "macos" | "windows" = "macos") {
	const app = await open("./remote-pane-fixture.tsx", {
		platform,
		width: 900,
		height: 1000,
		locale: "en-US",
	});
	await app.waitFor("id:remote-pairing-qr");
	return app;
}

test("a running Remote Host shows status, pairing and devices", async () => {
	const app = await openPane();
	expect(app.shows("text:Running")).toBe(true);
	expect(app.shows("text:http://192.168.1.5:48001/pair?code=PAIR-CODE")).toBe(
		true,
	);
	expect(app.shows("id:remote-pairing-qr")).toBe(true);
	expect(app.shows("id:remote-pairing-copy")).toBe(true);
	expect(app.shows("id:remote-pairing-regenerate")).toBe(true);
	expect(app.shows("text:Jui's iPhone 192.168.1.20")).toBe(true);
	expect(app.shows("text:iPad 192.168.1.21")).toBe(true);
	expect(app.shows("text:2 active")).toBe(true);
	expect(app.enabled("id:remote-device:dev-iphone:revoke")).toBe(true);
});

test("the switch stops the Remote Host and hides pairing", async () => {
	const app = await openPane();
	await app.press("id:remote-enabled-switch");
	await app.waitFor("text:Stopped");
	expect(app.shows("id:remote-pairing-qr")).toBe(false);
	expect(app.shows("text:Pairing")).toBe(false);
	// Switching back on restores the pairing section.
	await app.press("id:remote-enabled-switch");
	await app.waitFor("id:remote-pairing-qr");
});

test("editing the port saves a valid value and rejects an invalid one", async () => {
	const app = await openPane();
	await app.clear("id:remote-port-input");
	await app.type("id:remote-port-input", "48002");
	await app.submit("id:remote-port-input");
	await app.waitFor("id:remote-port-confirm-dialog-confirm");
	await app.press("id:remote-port-confirm-dialog-confirm");
	await app.waitFor("text:Port updated");
	// An out-of-range port is rejected with the hint, not saved.
	await app.clear("id:remote-port-input");
	await app.type("id:remote-port-input", "80");
	await app.submit("id:remote-port-input");
	await app.waitFor("text:Port must be an integer between 1024 and 65535");
});

test("regenerating refreshes the pairing link", async () => {
	const app = await openPane();
	await app.press("id:remote-pairing-regenerate");
	await app.waitFor("text:http://192.168.1.5:48001/pair?code=PAIR-CODE-regen");
});

test("pairing records the chosen permissions only when a new link is generated", async () => {
	const app = await openPane();
	await app.press("id:remote-pairing-scopes");
	await app.press("text:Chat + workspace");
	await app.waitFor(
		"text:Workspace access allows running terminal commands and reading and writing project files.",
	);
	expect(app.shows("text:Current link: Chat only")).toBe(true);
	await app.press("id:remote-pairing-regenerate");
	await app.waitFor("text:Current link: Chat + workspace");
});

test("a device's permissions can be changed and all devices can be revoked together", async () => {
	const app = await openPane();
	await app.press("id:remote-device:dev-iphone:scopes");
	await app.press("text:Chat + workspace");
	await app.waitFor("text:Chat + workspace");
	await app.press("id:remote-devices-revoke-all");
	await app.waitFor("id:remote-revoke-all-dialog-confirm");
	expect(app.shows("text:2 active")).toBe(true);
	await app.press("id:remote-revoke-all-dialog-confirm");
	await app.waitFor("text:No authorized devices");
	expect(app.shows("id:remote-pairing-qr")).toBe(false);
	expect(app.shows("text:Running")).toBe(true);
});

test("revoking a device removes it from the list", async () => {
	const app = await openPane();
	await app.press("id:remote-device:dev-ipad:revoke");
	await app.waitFor("text:Confirm revoke");
	await app.press("id:remote-device:dev-ipad:revoke");
	await app.waitFor("text:1 active");
	expect(app.shows("text:iPad 192.168.1.21")).toBe(false);
	expect(app.shows("text:Jui's iPhone 192.168.1.20")).toBe(true);
	// Revoking the last device shows the empty state.
	await app.press("id:remote-device:dev-iphone:revoke");
	await app.waitFor("text:Confirm revoke");
	await app.press("id:remote-device:dev-iphone:revoke");
	await app.waitFor("text:No authorized devices");
});

test("the LAN picker adds a new address", async () => {
	const app = await openPane();
	await app.press("id:remote-lan-add");
	// The saved LAN address is marked added; the new one is selectable.
	await app.waitFor("text:Added");
	expect(app.enabled("id:remote-lan:192.168.1.5")).toBe(false);
	await app.press("id:remote-lan:10.0.0.8");
	await app.waitFor("id:remote-address:2:input");
});

test("an address row is removed and saved", async () => {
	const app = await openPane();
	await app.press("id:remote-address:1:remove");
	await app.wait(200);
	expect(app.shows("id:remote-address:1:remove")).toBe(false);
});

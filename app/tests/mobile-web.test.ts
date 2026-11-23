import { expect, open, test } from "nsh/test";

test("mobile shell uses textarea composer only and removes React/engine switchers", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
	});

	await app.waitFor("id:mobile-header");
	await app.waitFor("id:mobile-textarea-composer");
	await app.waitFor("id:mobile-textarea-input");

	// Neither input engine toggle nor React WebUI switch should exist.
	expect(app.shows("id:mobile-header-engine-toggle")).toBe(false);
	expect(app.shows("id:chat-composer")).toBe(false);

	// Open session drawer, verify no engine/React/theme switches, and pick the saved session.
	await app.press("id:mobile-menu-button");
	await app.waitFor("id:mobile-drawer");
	await app.waitFor("id:mobile-env-menu:local");
	expect(app.shows("id:mobile-drawer-classic")).toBe(false);
	expect(app.shows("id:mobile-drawer-theme")).toBe(false);
	expect(app.shows("id:mobile-engine:rich")).toBe(false);
	expect(app.shows("id:mobile-engine:textarea")).toBe(false);

	// Switch between Recent and Projects tabs in the drawer.
	await app.press("id:mobile-drawer-tab:recent");
	await app.waitFor("id:mobile-session:s1");
	await app.press("id:mobile-drawer-tab:projects");
	await app.waitFor("id:mobile-session:s1");
	await app.press("id:mobile-session:s1");

	await app.waitFor("text:Hello from iPhone Safari");
	await app.waitFor("text:Everything is running on nsh Web.");

	// Temporary chat toggle in header works.
	await app.press("id:mobile-temporary-chat-button");
	await app.waitFor("id:mobile-header-title");
});

test("mobile run config opens bottom sheet with models and reasoning levels", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
	});

	await app.waitFor("id:run-config-trigger");
	await app.press("id:run-config-trigger");
	await app.waitFor("id:mobile-run-config-sheet");
	await app.waitFor("id:run-config-model:openai:gpt-5");
	await app.waitFor("id:run-config-thinking:high");
	expect(app.shows("id:run-config-edit-scope")).toBe(false);

	await app.press("id:run-config-model:openai:gpt-5");
	await app.press("id:run-config-thinking:high");
	await app.press("id:mobile-run-config-close");
	await app.waitFor("text:GPT-5");
	await app.waitFor("text:High");
});

test("mobile shell opens drawer via rightward swipe gesture", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
	});

	await app.waitFor("id:mobile-workspace-swipe");
	expect(app.shows("id:mobile-drawer")).toBe(false);
	await app.drag("id:mobile-workspace-swipe", { x: 140, y: 0 });
	await app.waitFor("id:mobile-drawer");
});

test("mobile shell shows connection recovery notice above composer and reconnects on tap", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "offline" },
	});

	await app.waitFor("id:mobile-connection-banner");
	await app.press("id:mobile-reconnect-button");
	await app.waitFor("text:Remote connected");
	expect(app.shows("id:mobile-reconnect-button")).toBe(false);
});

test("mobile auth view shows pairing notice without React switch and accepts manual token", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "auth" },
	});

	await app.waitFor("id:mobile-auth-required");
	expect(app.shows("id:mobile-open-classic")).toBe(false);
	expect(app.shows("text:Pilo Remote")).toBe(true);
	expect(app.shows("text:Authorization expired")).toBe(true);
	await app.press("id:mobile-toggle-token-input");
	await app.waitFor("id:mobile-token-input");
});

test("mobile header session info menu and drawer action menus open and close on selection", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
	});

	// Open drawer and test the per-session action menu.
	await app.press("id:mobile-menu-button");
	await app.waitFor("id:mobile-drawer");
	await app.waitFor("id:mobile-session-menu:s1");
	await app.press("id:mobile-session-menu:s1");
	await app.waitFor("id:mobile-session-refresh:s1");
	await app.waitFor("id:mobile-session-delete:s1");
	await app.press("id:mobile-session-refresh:s1");
	expect(app.shows("id:mobile-session-refresh:s1")).toBe(false);

	// Select the saved session so the top-right three-dot session info menu appears.
	await app.press("id:mobile-session:s1");
	await app.waitFor("id:mobile-session-menu-button");
	await app.press("id:mobile-session-menu-button");
	await app.waitFor("id:mobile-session-menu-popup");
	await app.waitFor("id:mobile-session-copy-id");
	await app.waitFor("id:mobile-session-copy-path");

	// Pressing Copy Session ID closes the anchored dropdown.
	await app.press("id:mobile-session-copy-id");
	expect(app.shows("id:mobile-session-menu-popup")).toBe(false);
});

test("mobile dropdown menu anchors below top-right trigger on phone idiom instead of bottom-left", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		platform: "ios",
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "header-menu" },
	});

	await app.waitFor("id:probe-header-menu-trigger");
	await app.press("id:probe-header-menu-trigger");
	await app.waitFor("id:probe-header-menu-item");

	const position = app.texts().find((entry) => entry.startsWith("bottom:"));
	expect(position).toBeDefined();
	const match = /^bottom:(\d+),(\d+),(\d+)x(\d+)$/.exec(position ?? "");
	expect(match).not.toBeNull();
	const x = Number(match![1]);
	const y = Number(match![2]);
	const width = Number(match![3]);

	// Right-aligned under the 44pt top-right header trigger on a 390x844 phone.
	expect(y).toBeGreaterThanOrEqual(40);
	expect(y).toBeLessThan(80);
	expect(x).toBeGreaterThan(80);
	expect(x + width).toBeGreaterThanOrEqual(370);
	expect(x + width).toBeLessThanOrEqual(390);

	await app.press("id:probe-header-menu-item");
	await app.waitFor("text:selected:1");
	expect(app.shows("id:probe-header-menu-item")).toBe(false);
});

test("nsh web pairing auto-completes for single address", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "pairing-single" },
	});

	await app.waitFor("id:pairing-done");
	expect(app.shows(`text:paired:${"b".repeat(43)}`)).toBe(true);
});

test("nsh web pairing lists multiple addresses and navigates on selection", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "pairing-multi" },
	});

	await app.waitFor("id:remote-pairing-addresses");
	await app.waitFor("id:remote-pairing-address:lan");
	await app.waitFor("id:remote-pairing-address:public");
	await app.press("id:remote-pairing-address:public");
	await app.waitFor("id:pairing-navigated");
	expect(
		app
			.texts()
			.some((text) =>
				text.startsWith("https://pilo.example.com/pair/complete#"),
			),
	).toBe(true);
});

test("nsh web pairing shows expired state on 401", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "pairing-expired" },
	});

	await app.waitFor("id:remote-pairing-error");
	await app.waitFor("id:remote-pairing-open");
});

test("mobile shell shows auth expiry reminder and clears it on renew", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "expiring" },
	});

	await app.waitFor("id:mobile-auth-expiry-banner");
	await app.press("id:mobile-auth-renew-button");
	expect(app.shows("id:mobile-auth-expiry-banner")).toBe(false);
});

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

	// Open session drawer, verify no engine/React switches, theme & font scale switches are present, and pick the saved session.
	await app.press("id:mobile-menu-button");
	await app.waitFor("id:mobile-drawer");
	await app.waitFor("id:mobile-env-menu:local");
	expect(app.shows("id:mobile-drawer-classic")).toBe(false);
	expect(app.shows("id:mobile-drawer-font-scale")).toBe(true);
	expect(app.shows("id:mobile-drawer-theme")).toBe(true);
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
	await app.waitFor("text:Connected");
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

test("mobile landing project picker anchors below centered trigger on phone idiom and switches project", async () => {
	const probe = await open("./mobile-web-fixture.tsx", {
		platform: "ios",
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "landing-project-picker" },
	});

	await probe.waitFor("id:landing-project-picker");
	await probe.press("id:landing-project-picker");
	await probe.waitFor("id:landing-project-picker-popup");
	await probe.waitFor("id:landing-project:p2");

	const triggerEntry = probe
		.texts()
		.find((entry) => entry.startsWith("trigger:"));
	const popupEntry = probe.texts().find((entry) => entry.startsWith("bottom:"));
	expect(triggerEntry).toBeDefined();
	expect(popupEntry).toBeDefined();

	const triggerMatch = /^trigger:(\d+),(\d+),(\d+)x(\d+)$/.exec(
		triggerEntry ?? "",
	);
	const popupMatch = /^bottom:(\d+),(\d+),(\d+)x(\d+)$/.exec(popupEntry ?? "");
	expect(triggerMatch).not.toBeNull();
	expect(popupMatch).not.toBeNull();

	const triggerX = Number(triggerMatch![1]);
	const triggerY = Number(triggerMatch![2]);
	const triggerW = Number(triggerMatch![3]);
	const triggerH = Number(triggerMatch![4]);
	const popupX = Number(popupMatch![1]);
	const popupY = Number(popupMatch![2]);
	const popupW = Number(popupMatch![3]);

	// Anchored directly beneath the centered trigger (not pushed to the bottom sheet area).
	expect(popupY).toBeGreaterThanOrEqual(triggerY + triggerH);
	expect(popupY).toBeLessThanOrEqual(triggerY + triggerH + 24);
	// Horizontally centered relative to the trigger on a 390pt viewport.
	const triggerCenter = triggerX + triggerW / 2;
	const popupCenter = popupX + popupW / 2;
	expect(Math.abs(popupCenter - triggerCenter)).toBeLessThanOrEqual(4);

	await probe.press("id:landing-project:p2");
	await probe.waitFor("text:selected:p2");
	expect(probe.shows("id:landing-project-picker-popup")).toBe(false);

	// End-to-end check inside MobileAppShell on phone idiom.
	const app = await open("./mobile-web-fixture.tsx", {
		platform: "ios",
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "multi-project" },
	});

	await app.waitFor("id:landing-project-picker");
	expect(app.shows("id:landing-project-picker >> text:pilo")).toBe(true);
	await app.press("id:landing-project-picker");
	await app.waitFor("id:landing-project-picker-popup");
	await app.waitFor("id:landing-project:p2");
	await app.press("id:landing-project:p2");
	await app.waitFor("id:landing-project-picker-popup", { state: "gone" });
	await app.waitFor("id:landing-project-picker >> text:api");

	// Escape dismisses the anchored popover cleanly.
	await app.press("id:landing-project-picker");
	await app.waitFor("id:landing-project-picker-popup");
	await app.keyboard.press("escape");
	await app.waitFor("id:landing-project-picker-popup", { state: "gone" });
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
	expect(app.shows("id:remote-pairing-open")).toBe(false);
});

test("the mobile drawer archives, opens and restores sessions by project", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
	});
	await app.press("id:mobile-menu-button");
	await app.waitFor("id:mobile-session-menu:s1");
	await app.press("id:mobile-session-menu:s1");
	await app.press("id:mobile-session-archive:s1");
	await app.waitFor("id:mobile-session:s1", { state: "gone" });
	await app.press("id:mobile-drawer-tab:recent");
	expect(app.shows("id:mobile-session:s1")).toBe(false);
	await app.press("id:mobile-drawer-archived");
	await app.waitFor(
		"id:mobile-drawer-archived-sessions >> id:mobile-session:s1",
	);
	const archivedProject = app.layout("id:mobile-drawer-archived-project:p1");
	expect(archivedProject?.x).toBeGreaterThan(0);
	expect(app.layout("id:mobile-session-title:s1")?.x).toBe(archivedProject?.x);
	await app.press("id:mobile-session:s1");
	await app.waitFor("text:Hello from iPhone Safari");
	await app.press("id:mobile-menu-button");
	await app.press("id:mobile-drawer-archived-back");
	await app.press("id:mobile-drawer-tab:projects");
	await app.press("id:mobile-project-archived:p1");
	await app.waitFor("id:mobile-session-unarchive:s1");
	expect(app.shows("id:mobile-session-menu:s1")).toBe(false);
	await app.press("id:mobile-session-delete:s1");
	await app.waitFor("text:Confirm delete");
	await app.press("text:Cancel");
	await app.press("id:mobile-session-unarchive:s1");
	await app.waitFor("text:No archived sessions");
	await app.press("id:mobile-drawer-archived-back");
	await app.waitFor("id:mobile-session:s1");
	await app.press("id:mobile-session-menu:s1");
	await app.press("id:mobile-session-archive:s1");
	await app.press("id:mobile-project-archived:p1");
	await app.press("id:mobile-session-delete:s1");
	await app.waitFor("text:Confirm delete");
	await app.press("id:mobile-session-confirm-delete:s1");
	await app.waitFor("text:No archived sessions");
	await app.waitFor("text:Session moved to trash");
});

test("mobile drawer notifies when deleting a session succeeds or fails", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
	});

	await app.press("id:mobile-menu-button");
	await app.waitFor("id:mobile-session-menu:s1");
	await app.press("id:mobile-session-menu:s1");
	await app.waitFor("id:mobile-session-delete:s1");
	await app.press("id:mobile-session-delete:s1");
	await app.waitFor("id:mobile-session-confirm-delete:s1");
	await app.press("id:mobile-session-confirm-delete:s1");

	await app.waitFor("id:mobile-session:s1", { state: "gone" });
	await app.waitFor("text:Session moved to trash");

	const failed = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "delete-failed" },
	});

	await failed.press("id:mobile-menu-button");
	await failed.waitFor("id:mobile-session-menu:s1");
	await failed.press("id:mobile-session-menu:s1");
	await failed.waitFor("id:mobile-session-delete:s1");
	await failed.press("id:mobile-session-delete:s1");
	await failed.waitFor("id:mobile-session-confirm-delete:s1");
	await failed.press("id:mobile-session-confirm-delete:s1");

	await failed.waitFor("text:Failed to delete session");
	expect(failed.shows("text:Disk is read-only")).toBe(true);
	expect(failed.shows("id:mobile-session:s1")).toBe(true);
});

test("mobile composer context usage opens anchored popover for both empty and populated usage", async () => {
	// Empty session state with known model window (0% trigger).
	const pending = await open("./mobile-web-fixture.tsx", {
		platform: "ios",
		locale: "en-US",
		width: 390,
		height: 844,
	});
	await pending.waitFor("id:composer-context-usage");
	await pending.press("id:composer-context-usage");
	await pending.waitFor("id:composer-context-usage-details");
	expect(pending.shows("text:CONTEXT")).toBe(true);
	await pending.press("id:composer-context-usage");
	await pending.waitFor("id:composer-context-usage-details", { state: "gone" });

	// Populated usage on a narrow 320pt viewport.
	const populated = await open("./mobile-web-fixture.tsx", {
		platform: "ios",
		locale: "en-US",
		width: 320,
		height: 568,
		storage: { "fixture.scenario": "context-usage" },
	});
	await populated.waitFor("id:composer-context-usage");
	expect(populated.shows("id:composer-context-usage >> text:21%")).toBe(true);
	await populated.press("id:composer-context-usage");
	await populated.waitFor("id:composer-context-usage-details");
	expect(populated.shows("text:42k / 200k")).toBe(true);
	expect(populated.shows("text:TOKEN USAGE")).toBe(true);
	expect(populated.shows("text:Total cost")).toBe(true);
	await populated.keyboard.press("escape");
	await populated.waitFor("id:composer-context-usage-details", {
		state: "gone",
	});
});

test("mobile composer send mode hides while idle and uses anchored popover while running", async () => {
	const idle = await open("./mobile-web-fixture.tsx", {
		platform: "ios",
		locale: "en-US",
		width: 390,
		height: 844,
	});
	await idle.waitFor("id:mobile-textarea-input");
	expect(idle.shows("id:chat-composer-send-mode")).toBe(false);

	const app = await open("./mobile-web-fixture.tsx", {
		platform: "ios",
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "queue" },
	});

	await app.waitFor("id:chat-composer-send-mode");
	await app.press("id:chat-composer-send-mode");
	await app.waitFor("id:chat-composer-send-mode-popup");
	expect(app.shows("text:SEND MODE")).toBe(true);
	await app.waitFor("id:chat-composer-send-mode:steer");
	await app.waitFor("id:chat-composer-send-mode:follow_up");
	await app.waitFor("id:chat-composer-send-mode:send_now");

	await app.press("id:chat-composer-send-mode:follow_up");
	await app.waitFor("id:chat-composer-send-mode-popup", { state: "gone" });

	// Reopen and switch to send_now.
	await app.press("id:chat-composer-send-mode");
	await app.waitFor("id:chat-composer-send-mode-popup");
	await app.press("id:chat-composer-send-mode:send_now");
	await app.waitFor("id:chat-composer-send-mode-popup", { state: "gone" });
});

test("mobile pending queue reuses desktop card with touch targets, edit and send-now", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "queue" },
	});

	await app.waitFor("id:mobile-textarea-input");
	expect(app.shows("id:chat-pending-queue")).toBe(false);

	// Queue a steer message via the mobile send button.
	await app.type("id:mobile-textarea-input", "adjust direction");
	await app.press("id:chat-composer-send");
	await app.waitFor("id:chat-pending-queue");
	expect(app.shows("text:Pending messages")).toBe(true);
	expect(app.shows("id:chat-pending-queue-count")).toBe(true);
	expect(app.shows("id:chat-pending-queue >> text:1")).toBe(true);
	expect(app.shows("id:chat-pending-item-0 >> text:Steer")).toBe(true);
	expect(app.shows("id:chat-pending-item-0 >> text:adjust direction")).toBe(
		true,
	);

	// Switch to follow-up mode and queue a second message.
	await app.press("id:chat-composer-send-mode");
	await app.waitFor("id:chat-composer-send-mode:follow_up");
	await app.press("id:chat-composer-send-mode:follow_up");
	await app.type("id:mobile-textarea-input", "then run tests");
	await app.press("id:chat-composer-send");
	await app.waitFor("id:chat-pending-queue >> text:2");
	expect(app.shows("id:chat-pending-item-1 >> text:Queue")).toBe(true);
	expect(app.shows("id:chat-pending-item-1 >> text:then run tests")).toBe(true);

	// Retrieve the first queued message back into the mobile textarea.
	await app.press("id:chat-pending-edit-0");
	await app.waitFor("id:chat-pending-queue >> text:1");
	expect(app.shows("id:chat-pending-item-0 >> text:then run tests")).toBe(true);

	// Interrupt and send the remaining queued message immediately.
	await app.press("id:chat-pending-send-now-0");
	await app.waitFor("id:chat-pending-queue", { state: "gone" });
});

test("mobile pending queue disables actions while offline and re-enables after reconnect", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "queue-offline" },
	});

	await app.waitFor("id:chat-pending-queue");
	expect(
		app.shows("id:chat-pending-item-0 >> text:keep waiting while offline"),
	).toBe(true);

	let editError = "";
	try {
		await app.press("id:chat-pending-edit-0");
	} catch (error) {
		editError = String(error);
	}
	expect(editError).toContain("disabled");

	let sendError = "";
	try {
		await app.press("id:chat-pending-send-now-0");
	} catch (error) {
		sendError = String(error);
	}
	expect(sendError).toContain("disabled");

	// Reconnecting unlocks the queue actions.
	await app.press("id:mobile-reconnect-button");
	await app.waitFor("text:Connected");
	await app.press("id:chat-pending-send-now-0");
	await app.waitFor("id:chat-pending-queue", { state: "gone" });
});

test("mobile shell follows system color scheme automatically and allows manual override in drawer", async () => {
	// Even when the desktop host saved `theme: "light"`, Web defaults to following system appearance.
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		colorScheme: "dark",
	});
	await app.waitFor("id:mobile-app");
	expect(app.viewStyle("id:mobile-app")?.backgroundColor).toBe("#101010ff");

	// Automatic switching follows system light/dark changes.
	await app.setColorScheme("light");
	await app.waitUntil(
		() => app.viewStyle("id:mobile-app")?.backgroundColor === "#ffffffff",
	);

	// Manual dark override stays dark even while the system is light.
	await app.press("id:mobile-menu-button");
	await app.waitFor("id:mobile-drawer-theme");
	await app.press("id:mobile-drawer-theme");
	await app.waitFor("id:mobile-drawer-theme-popup");
	await app.press("id:mobile-drawer-theme:dark");
	await app.waitFor("id:mobile-drawer-theme-popup", { state: "gone" });
	await app.waitUntil(
		() => app.viewStyle("id:mobile-app")?.backgroundColor === "#101010ff",
	);

	// Manual light override stays light even when the system switches to dark.
	await app.setColorScheme("dark");
	await app.press("id:mobile-drawer-theme");
	await app.waitFor("id:mobile-drawer-theme-popup");
	await app.press("id:mobile-drawer-theme:light");
	await app.waitFor("id:mobile-drawer-theme-popup", { state: "gone" });
	await app.waitUntil(
		() => app.viewStyle("id:mobile-app")?.backgroundColor === "#ffffffff",
	);

	// Returning to system follows the current dark system scheme again.
	await app.press("id:mobile-drawer-theme");
	await app.waitFor("id:mobile-drawer-theme-popup");
	await app.press("id:mobile-drawer-theme:system");
	await app.waitFor("id:mobile-drawer-theme-popup", { state: "gone" });
	await app.waitUntil(
		() => app.viewStyle("id:mobile-app")?.backgroundColor === "#101010ff",
	);

	// Saved manual preference is restored on reload.
	const restored = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		colorScheme: "light",
		storage: { "pilo.web.color-scheme.v1": "dark" },
	});
	await restored.waitFor("id:mobile-app");
	await restored.waitUntil(
		() => restored.viewStyle("id:mobile-app")?.backgroundColor === "#101010ff",
	);
});

test("mobile shell applies unified mobile UI font scale and allows per-browser small/default/large override", async () => {
	const app = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: { "fixture.scenario": "font-scale" },
	});
	await app.waitFor("id:mobile-app");
	await app.waitFor("text:fontScale uiSm=16 code=14");

	// Switch to Small in drawer.
	await app.press("id:mobile-menu-button");
	await app.waitFor("id:mobile-drawer-font-scale");
	await app.press("id:mobile-drawer-font-scale");
	await app.waitFor("id:mobile-drawer-font-scale-popup");
	await app.press("id:mobile-drawer-font-scale:small");
	await app.waitFor("id:mobile-drawer-font-scale-popup", { state: "gone" });
	await app.waitFor("text:fontScale uiSm=14 code=12");

	// Switch to Large in drawer.
	await app.press("id:mobile-drawer-font-scale");
	await app.waitFor("id:mobile-drawer-font-scale-popup");
	await app.press("id:mobile-drawer-font-scale:large");
	await app.waitFor("id:mobile-drawer-font-scale-popup", { state: "gone" });
	await app.waitFor("text:fontScale uiSm=18 code=15");

	// Switch back to Standard.
	await app.press("id:mobile-drawer-font-scale");
	await app.waitFor("id:mobile-drawer-font-scale-popup");
	await app.press("id:mobile-drawer-font-scale:default");
	await app.waitFor("id:mobile-drawer-font-scale-popup", { state: "gone" });
	await app.waitFor("text:fontScale uiSm=16 code=14");

	// Saved preset is restored on reload.
	const restored = await open("./mobile-web-fixture.tsx", {
		locale: "en-US",
		width: 390,
		height: 844,
		storage: {
			"fixture.scenario": "font-scale",
			"pilo.web.font-scale.v1": "large",
		},
	});
	await restored.waitFor("id:mobile-app");
	await restored.waitFor("text:fontScale uiSm=18 code=15");
});

test("mobile toasts adapt to narrow viewports, safe area, visible close button, touch action, and font scale", async () => {
	const narrow = await open("./mobile-web-fixture.tsx", {
		platform: "ios",
		locale: "en-US",
		width: 320,
		height: 568,
		storage: {
			"fixture.scenario": "toast",
			"fixture.safeAreaTop": "59",
			"pilo.web.font-scale.v1": "large",
		},
	});

	await narrow.waitFor("id:probe-show-toast");
	await narrow.press("id:probe-show-toast");
	await narrow.waitFor("id:app-toast-overlay");
	await narrow.waitFor("text:Leaving temporary chat");

	// Overlay fits 320pt viewport (12pt margin each side) and sits below top safe area (59 + 8 = 67).
	const overlayLayout = narrow.layout("id:app-toast-overlay");
	expect(overlayLayout?.width).toBe(296);
	expect(overlayLayout?.x).toBe(12);
	expect(overlayLayout?.y).toBe(67);

	// Title follows the per-browser large UI text scale (18px).
	expect(narrow.spanStyle("text:Leaving temporary chat").fontSize).toBe(18);

	// Action button uses mobile touch target height (>= 40pt) and executes on tap.
	const actionLayout = narrow.layout("label:Return");
	expect(actionLayout?.height).toBeGreaterThanOrEqual(40);
	await narrow.press("label:Return");
	await narrow.waitFor("text:toastActions:1");
	await narrow.waitFor("id:app-toast-overlay", { state: "gone" });

	// Close button is immediately visible without hover and dismisses the toast on tap.
	await narrow.press("id:probe-show-toast");
	await narrow.waitFor("id:app-toast-overlay");
	expect(narrow.viewStyle("label:Close")?.opacity).toBe(1);
	await narrow.press("label:Close");
	await narrow.waitFor("id:app-toast-overlay", { state: "gone" });
});

test("mobile composer collapses empty textarea and edit buttons while external Pi is running", async () => {
	const locked = await open("./mobile-web-fixture.tsx", {
		platform: "ios",
		locale: "en-US",
		width: 390,
		height: 844,
		storage: {
			"fixture.scenario": "external-readonly",
		},
	});

	await locked.waitFor("id:chat-composer-readonly");
	await locked.waitFor("text:External Pi is running; editing is paused");
	await locked.waitFor("id:mobile-textarea-input", { state: "gone" });
	await locked.waitFor("id:chat-composer-attach", { state: "gone" });
	await locked.waitFor("id:chat-composer-send", { state: "gone" });
	await locked.waitFor("id:run-config-trigger");
	await locked.waitFor("id:composer-context-usage");

	const surfaceLayout = locked.layout("id:chat-composer-surface");
	expect(surfaceLayout?.height).toBeLessThanOrEqual(96);

	const withDraft = await open("./mobile-web-fixture.tsx", {
		platform: "ios",
		locale: "en-US",
		width: 390,
		height: 844,
		storage: {
			"fixture.scenario": "external-readonly-draft",
		},
	});

	await withDraft.waitFor("id:chat-composer-readonly");
	await withDraft.waitFor(
		"text:An external Pi is running; editing is paused while your draft is preserved",
	);
	await withDraft.waitFor("id:mobile-textarea-input");
	await withDraft.waitFor("id:chat-composer-attach", { state: "gone" });
	await withDraft.waitFor("id:chat-composer-send", { state: "gone" });
	await withDraft.waitFor("id:run-config-trigger");
	await withDraft.waitFor("id:composer-context-usage");
});

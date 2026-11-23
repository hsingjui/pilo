import { expect, open, test } from "nsh/test";

async function openApp() {
	const app = await open("./read-open-session-fixture.tsx", {
		platform: "macos",
	});
	await app.waitFor("id:open-s1");
	return app;
}

type App = Awaited<ReturnType<typeof openApp>>;

/** The unread sessions and what was marked read, as the fixture names them. */
const shown = (app: App) => app.texts().slice(-2);

/** Waits for what a press leads to, and fails on what is shown without it. */
async function shows(app: App, unread: string, marked: string) {
	const expected = [`unread: ${unread}`, `marked: ${marked}`];
	await app
		.waitUntil(() => shown(app).join() === expected.join())
		.catch(() => {});
	expect(shown(app)).toEqual(expected);
}

/**
 * Puts the app in a lifecycle state and says whether it is in it. The
 * headless host does as told. The native one cannot be told: its apps run in
 * the background, inactive, unless the run is given `--foreground`, which
 * makes them the active app.
 */
async function inLifecycle(app: App, state: "active" | "inactive") {
	try {
		await app.setLifecycle(state);
		return true;
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ERR_NSH_TEST_UNSUPPORTED"
		) {
			throw error;
		}
	}
	// Under `--foreground` the app is the active one from its first press on.
	const active = await app.waitFor("text:app: active", { timeout: 1000 }).then(
		() => true,
		() => false,
	);
	return active === (state === "active");
}

test("a turn that ends in the open session of the active app is marked read", async () => {
	const app = await openApp();
	// Runs headless, and on macOS only with `--foreground`:
	// nsh test --target macos --foreground tests/read-open-session.test.ts
	await app.press("id:open-s1");
	if (!(await inLifecycle(app, "active"))) return;
	await shows(app, "", "");
	await app.press("id:turn-s1");
	await shows(app, "", "s1@2");

	// A session that is not open stays unread.
	await app.press("id:turn-s2");
	await shows(app, "s2", "s1@2");
});

test("a turn that ends while the app is not active is marked read once it is", async () => {
	const app = await openApp();
	// Not under `--foreground`, where the app is active.
	await app.press("id:open-s1");
	if (!(await inLifecycle(app, "inactive"))) return;
	await app.press("id:turn-s1");
	await shows(app, "s1", "");

	// Only the headless host can make the app active again.
	if (!(await inLifecycle(app, "active"))) return;
	await shows(app, "", "s1@2");
});

test("a turn that ends before the runtime answers the last mark is marked too", async () => {
	const app = await openApp();
	await app.press("id:open-s1");
	if (!(await inLifecycle(app, "active"))) return;
	await app.press("id:hold");
	await app.press("id:turn-s1");
	await shows(app, "s1", "s1@2");
	await app.press("id:turn-s1");
	await shows(app, "s1", "s1@2, s1@3");

	await app.press("id:release");
	await shows(app, "", "s1@2, s1@3");
});

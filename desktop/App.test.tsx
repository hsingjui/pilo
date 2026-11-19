// `nsh test` runs the app headless against the crate: the lists are read
// from the data directory through the Pilo runtime (`Pilo`, in Rust), and a
// burst published on the runtime's event bus reaches the message list
// through the shared reducer.
import { expect, open, test } from "nsh/test";

test("lists the data directory's projects and sessions", async () => {
	const app = await open("./App.tsx");
	await app.waitFor("PROJECTS");
	expect(app.texts().some((text) => text.startsWith("SESSIONS ("))).toBe(true);
});

test("a burst on the runtime's bus streams into the message list", async () => {
	const app = await open("./App.tsx");
	await app.press("Burst 300 @ 100/s");
	await app.waitUntil(
		() => app.texts().some((text) => text.includes("token299")),
		{ timeout: 10_000 },
	);
	expect(app.texts().some((text) => text.startsWith("events 30"))).toBe(true);
});

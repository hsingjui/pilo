import { expect, open, test } from "nsh/test";

test("switching away from a terminal tab and back preserves layout width and line text", async () => {
	const app = await open("./terminal-view-fixture.tsx", {
		platform: "windows",
		width: 960,
		height: 600,
	});
	await app.waitFor("text:ready:yes");
	await app.waitFor("text:Code\\reverse\\idm via v3.12.14");
	const readLine = (prefix: string) =>
		app.texts().find((line) => line.startsWith(prefix)) ?? "";

	await app.waitUntil(() => readLine("resizes:") !== "resizes:");

	await app.press("id:show-chat");
	await app.waitFor("text:Chat view");
	// Wait past nsh's 80ms terminal RESIZE_SETTLE debounce.
	await app.wait(160);

	expect(readLine("resizes:")).not.toContain("1x1");

	await app.press("id:show-t1");
	await app.waitFor("text:Code\\reverse\\idm via v3.12.14");
	expect(readLine("resizes:")).not.toContain("1x1");
});

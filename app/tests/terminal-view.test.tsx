import { expect, open, test } from "nsh/test";

import {
	encodeTerminalPaste,
	TerminalBracketedPasteTracker,
} from "../shell/terminal-clipboard";

test("encodeTerminalPaste normalizes line endings and wraps when bracketed paste is enabled", () => {
	expect(encodeTerminalPaste("echo hi\r\nls\n", false)).toBe("echo hi\rls\r");
	expect(encodeTerminalPaste("echo hi\r\nls\n", true)).toBe(
		"\x1b[200~echo hi\rls\r\x1b[201~",
	);
});

test("TerminalBracketedPasteTracker tracks DECSET/DECRST 2004 across split chunks and resets", () => {
	const tracker = new TerminalBracketedPasteTracker();
	expect(tracker.active).toBe(false);

	tracker.feed("\x1b[?20");
	expect(tracker.active).toBe(false);
	tracker.feed("04h");
	expect(tracker.active).toBe(true);

	tracker.feed("\x1b[?1;2004l");
	expect(tracker.active).toBe(false);

	tracker.feed("\x1b[?1;2004;1004h");
	expect(tracker.active).toBe(true);

	tracker.feed("\x1bc");
	expect(tracker.active).toBe(false);
});

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

test("terminal supports ctrl+c/ctrl+shift+c copy and ctrl+v/ctrl+shift+v paste without stealing other inputs", async () => {
	const app = await open("./terminal-view-fixture.tsx", {
		platform: "windows",
		width: 960,
		height: 600,
		clipboard: "echo 1\r\necho 2",
	});
	const readLine = (prefix: string) =>
		app.texts().find((line) => line.startsWith(prefix)) ?? "";

	await app.waitFor("text:ready:yes");
	await app.waitFor("text:Code\\reverse\\idm via v3.12.14");

	// A newly opened terminal owns the keyboard; Ctrl+C with no selection sends SIGINT.
	await app.keyboard.press("ctrl+c");
	await app.waitFor("text:writes:t-1:<CTRL-C>");

	// Ctrl+Shift+C with no selection does nothing (does not send SIGINT).
	await app.keyboard.press("ctrl+shift+c");
	await app.wait(30);
	expect(readLine("writes:")).toBe("writes:t-1:<CTRL-C>");

	// Ctrl+V and Ctrl+Shift+V paste clipboard text (plain mode).
	await app.keyboard.press("ctrl+v");
	await app.waitFor("text:writes:t-1:<CTRL-C>|t-1:echo 1<CR>echo 2");
	await app.keyboard.press("ctrl+shift+v");
	await app.waitFor(
		"text:writes:t-1:<CTRL-C>|t-1:echo 1<CR>echo 2|t-1:echo 1<CR>echo 2",
	);

	// Enable bracketed paste mode -> Ctrl+V wraps with DECSET 2004 markers.
	await app.press("id:enable-bracketed");
	await app.press("id:show-chat");
	await app.press("id:show-t1");
	await app.keyboard.press("ctrl+v");
	await app.waitFor(
		"text:writes:t-1:<CTRL-C>|t-1:echo 1<CR>echo 2|t-1:echo 1<CR>echo 2|t-1:<ESC>[200~echo 1<CR>echo 2<ESC>[201~",
	);

	// Focusing another input must keep Ctrl+V out of the terminal.
	const writesBefore = readLine("writes:");
	await app.press("id:focus-external");
	await app.keyboard.press("ctrl+v");
	await app.wait(40);
	expect(readLine("writes:")).toBe(writesBefore);
});

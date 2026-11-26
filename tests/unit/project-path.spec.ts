import assert from "node:assert/strict";
import test from "node:test";

import {
	compactMiddlePath,
	displayProjectPath,
} from "../../shared/project-path.ts";

test("displayProjectPath strips Windows extended-length prefixes", () => {
	assert.equal(displayProjectPath("\\\\?\\C:\\Code\\pilo"), "C:\\Code\\pilo");
	assert.equal(
		displayProjectPath("\\\\?\\UNC\\server\\share\\pilo"),
		"\\\\server\\share\\pilo",
	);
	assert.equal(displayProjectPath("/Users/alice/pilo"), "/Users/alice/pilo");
});

test("compactMiddlePath preserves short paths as-is", () => {
	assert.equal(
		compactMiddlePath("/sessions/s4.jsonl", 38),
		"/sessions/s4.jsonl",
	);
	assert.equal(
		compactMiddlePath("\\\\?\\C:\\Code\\pilo", 38),
		"C:\\Code\\pilo",
	);
});

test("compactMiddlePath keeps drive/root and trailing filename for deep paths", () => {
	const winPath =
		"C:\\Users\\hsingjui\\.pi\\agent\\sessions\\--D--Code-pilo--\\s4.jsonl";
	const compactedWin = compactMiddlePath(winPath, 38);
	assert.ok(compactedWin.length <= 38, compactedWin);
	assert.ok(compactedWin.startsWith("C:\\…\\"), compactedWin);
	assert.ok(compactedWin.endsWith("\\s4.jsonl"), compactedWin);

	const posixPath =
		"/Users/alice/.pi/agent/sessions/--Users-alice-pilo--/session-01.jsonl";
	const compactedPosix = compactMiddlePath(posixPath, 38);
	assert.ok(compactedPosix.length <= 38, compactedPosix);
	assert.ok(compactedPosix.startsWith("/…/"), compactedPosix);
	assert.ok(compactedPosix.endsWith("/session-01.jsonl"), compactedPosix);
});

test("compactMiddlePath preserves drive roots with forward or mixed separators", () => {
	assert.equal(
		compactMiddlePath("C:/long-windows-directory/sessions/s4.jsonl", 24),
		"C:/…/sessions/s4.jsonl",
	);
	assert.equal(
		compactMiddlePath("C:\\long-windows-directory\\sessions/s4.jsonl", 24),
		"C:\\…\\sessions\\s4.jsonl",
	);
	assert.equal(
		compactMiddlePath("C:/long-windows-directory\\sessions/s4.jsonl", 24),
		"C:/…/sessions/s4.jsonl",
	);
});

test("compactMiddlePath keeps prefix and suffix when filename alone exceeds budget", () => {
	const longFilePath =
		"C:\\Users\\hsingjui\\.pi\\agent\\sessions\\--D--Code-pilo--\\2026-11-26T01-32-10-123Z_01a2159f-4c2b-7e1a.jsonl";
	const compacted = compactMiddlePath(longFilePath, 38);
	assert.ok(compacted.length <= 38, compacted);
	assert.ok(compacted.startsWith("C:\\…\\2026-11-26"), compacted);
	assert.ok(compacted.endsWith(".jsonl"), compacted);
});

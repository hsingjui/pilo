import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	findLucideImports,
	generateIcons,
} from "../../scripts/generate-desktop-icons.mjs";

test("Lucide discovery handles aliases, multiline imports, and type-only imports", () => {
	const names = findLucideImports(
		"fixture.tsx",
		`
		// import { Ghost } from "lucide-react";
		import { type LucideIcon, Check as Done, Square } from "lucide-react";
		import {
			MoreHorizontal as Menu,
			Palette,
		} from "lucide-react";
		import type { LucideProps } from "lucide-react";
		import { Camera } from "another-package";
	`,
	);
	assert.deepEqual(names, ["Check", "Square", "MoreHorizontal", "Palette"]);
	assert.throws(
		() =>
			findLucideImports(
				"fixture.tsx",
				'import * as icons from "lucide-react";',
			),
		/fixture\.tsx: use named Lucide icon imports/,
	);
});

test("Lucide paths preserve fill and convert circles, lines, polylines and rounded rectangles", async () => {
	const icons = await generateIcons([
		"PanelLeft",
		"CircleAlert",
		"Check",
		"Inbox",
		"Palette",
		"Check",
	]);
	assert.deepEqual(Object.keys(icons), [
		"Check",
		"CircleAlert",
		"Inbox",
		"Palette",
		"PanelLeft",
	]);
	assert.deepEqual(icons.Check, {
		size: 24,
		paths: [{ d: "M20 6 9 17l-5-5" }],
	});
	assert.deepEqual(icons.CircleAlert.paths.slice(0, 2), [
		{ d: "M2 12A10 10 0 1 0 22 12A10 10 0 1 0 2 12Z" },
		{ d: "M12 8L12 12" },
	]);
	assert.deepEqual(icons.Inbox.paths[0], {
		d: "M22 12 16 12 14 15 10 15 8 12 2 12",
	});
	assert.match(icons.PanelLeft.paths[0].d, /^M5 3H19A2 2 0 0 1 21 5.*Z$/);
	assert.equal(icons.Palette.paths[0].fill, undefined);
	assert.equal(icons.Palette.paths[1].fill, true);
});

test("Lucide aliases resolve to canonical geometry and non-icons fail", async () => {
	const icons = await generateIcons(["MoreHorizontal", "Ellipsis"]);
	assert.deepEqual(icons.MoreHorizontal, icons.Ellipsis);
	await assert.rejects(
		generateIcons(["createLucideIcon"]),
		/Unknown Lucide icon: createLucideIcon/,
	);
});

test("checked-in desktop icons match the generated catalog", () => {
	const script = new URL(
		"../../scripts/generate-desktop-icons.mjs",
		import.meta.url,
	);
	execFileSync(process.execPath, [fileURLToPath(script), "--check"], {
		stdio: "pipe",
	});
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { generateThemes } from "../../scripts/generate-desktop-themes.mjs";

const lody = `
@layer base {
	:root {
		--foreground: 225 7.1% 11%; /* Lody Light */
		--linked: hsl(var(--foreground) / 0.1);
		--radius-control: max(0px, calc(0.5rem - 9px));
		--radius-panel: calc(0.5rem + 3px);
		--sidebar-width: calc(100% - 1rem);
		--pilo-page-font-family: "Inter", system-ui;
		--pilo-shadow-panel: 0 1px 2px hsl(0 0% 0% / 0.08);
		--dur-1: 120ms;
	}
	.dark { --foreground: 0 0% 100%; --dark-only: #abcdef; }
}
@media (min-width: 800px) { :root { --foreign-rule: 1px; } }
`;
const claude = `
@layer base {
	:root[data-theme-family="claude"] { --foreground: 14 61.7% 47%; }
	.dark:root[data-theme-family="claude"] {
		--pilo-shadow-panel: inset 0 1px 2px black;
	}
}
`;

test("colors, aliases and family overrides follow the CSS cascade", () => {
	const themes = generateThemes(lody, claude);
	assert.deepEqual(themes.lody.cssVars.light, {
		foreground: "hsl(225 7.1% 11%)",
		linked: "hsl(225 7.1% 11% / 0.1)",
	});
	assert.deepEqual(themes.lody.cssVars.dark, {
		"dark-only": "#abcdef",
		foreground: "hsl(0 0% 100%)",
		linked: "hsl(0 0% 100% / 0.1)",
	});
	assert.equal(themes.claude.cssVars.theme.foreground, "hsl(14 61.7% 47%)");
	assert.equal(themes.claude.cssVars.theme.linked, "hsl(14 61.7% 47% / 0.1)");
	assert.equal(themes.claude.cssVars.dark["dark-only"], "#abcdef");
});

test("only values nsh can expose are emitted as native tokens", () => {
	const themes = generateThemes(lody, claude);
	assert.deepEqual(themes.lody.cssVars.theme, {
		"font-sans": '"Inter", system-ui',
		"radius-control": "0px",
		"radius-panel": "11px",
	});
	assert.deepEqual(themes.lody.styleVars.theme, {
		"dur-1": "120ms",
		"pilo-shadow-panel": "0 1px 2px hsl(0 0% 0% / 0.08)",
		"sidebar-width": "calc(100% - 1rem)",
	});
	assert.equal(
		themes.claude.styleVars.light["pilo-shadow-panel"],
		"0 1px 2px hsl(0 0% 0% / 0.08)",
	);
	assert.equal(
		themes.claude.styleVars.dark["pilo-shadow-panel"],
		"inset 0 1px 2px black",
	);
});

test("fails on missing scopes, missing references and reference cycles", () => {
	assert.throws(
		() => generateThemes("@layer base { :root {} }", claude),
		/missing.*\.dark/,
	);
	assert.throws(
		() => generateThemes(lody.replace("--foreground)", "--missing)"), claude),
		/Missing theme token --missing/,
	);
	assert.throws(
		() => generateThemes(lody.replace("--foreground)", "--linked)"), claude),
		/Circular theme token --linked/,
	);
});

test("checked-in desktop themes match the CSS", () => {
	const run = spawnSync(
		process.execPath,
		["scripts/generate-desktop-themes.mjs", "--check"],
		{
			cwd: new URL("../../", import.meta.url),
			encoding: "utf8",
		},
	);
	assert.equal(run.status, 0, run.stderr);
});

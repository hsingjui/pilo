import { readFileSync, writeFileSync } from "node:fs";
import {
	createThemeTokenCatalog,
	parseThemeColor,
	validateCustomThemeTokens,
} from "../../shared/theme-tokens.ts";

const base = JSON.parse(
	readFileSync(new URL("../../theme/theme.json", import.meta.url), "utf8"),
);
const catalog = createThemeTokenCatalog(base.cssVars);
const cases: { name: string; input: unknown; expected: unknown }[] = [];
function add(input: unknown) {
	cases.push({
		name: `case-${cases.length}`,
		input,
		expected: validateCustomThemeTokens(input, catalog),
	});
}
const colors = [
	"transparent",
	"Transparent",
	"red",
	"#abc",
	"#abcd",
	"#ABCDEF",
	"#abcdefFF",
	"#ab",
	"#abcde",
	"#ggg",
	"rgb(0 0 0)",
	"rgba(1, 2, 3)",
	"rgb(100% 0% 50%)",
	"rgb(1% 2 3)",
	"rgb(256 0 0)",
	"rgb(-1 0 0)",
	"rgb(1,2,3 / 1)",
	"rgb(1 2 3 / 1 / 1)",
	"rgb(1 2 / 1)",
	"rgb(1 2 3 1)",
	"RGB(1 2 3)",
	"rgb(1\n2 3)",
	"rgb(1\r2 3)",
	"rgb(1\u20282 3)",
	"rgb(1\u20292 3)",
	"rgb(1\t2 3)",
	"rgb(１ 2 3)",
	"rgb(١ 2 3)",
	"rgb(1. 2 3)",
	"rgb(1e1 2 3)",
	"rgb(+.5 2 3)",
	"hsl(0 100% 50%)",
	"hsla(-720deg,100%,50%,1)",
	"hsl(360 0% 100%)",
	"hsl(1turn 0% 0%)",
	"hsl(0 101% 0%)",
	"hsl(0 0 0)",
	"hsl(0DEG 0% 0%)",
	`hsl(${"9".repeat(400)} 0% 0%)`,
	"oklch(0 0 0)",
	"color-mix(in oklab, red, blue)",
];
for (const nonFinite of [
	"9".repeat(400),
	"-" + "9".repeat(400),
	"Infinity",
	"-Infinity",
	"NaN",
]) {
	colors.push(
		`hsl(${nonFinite} 0% 0%)`,
		`hsl(${nonFinite}deg 0% 0%)`,
		`hsl(0 ${nonFinite}% 0%)`,
		`hsl(0 0% ${nonFinite}%)`,
		`rgb(${nonFinite} 0 0)`,
		`rgb(${nonFinite}% 0% 0%)`,
		`rgb(0 0 0 / ${nonFinite})`,
		`rgb(0 0 0 / ${nonFinite}%)`,
	);
}
for (const fn of ["rgb", "rgba", "hsl", "hsla"]) {
	for (const alpha of [
		"0",
		"1",
		".5",
		"0.998",
		"0.99804",
		"0.999",
		"1.001",
		"-0",
		"-.001",
		"0%",
		"100%",
		"99.8%",
		"100.01%",
		"-1%",
		"+1",
		"1.",
		"",
		"NaN",
	]) {
		const channels = fn.startsWith("rgb")
			? ["0", "127.5", "255"]
			: ["-361deg", "50%", "50%"];
		colors.push(
			`${fn}(${channels.join(" ")} / ${alpha})`,
			`${fn}(${channels.join(",")},${alpha})`,
		);
	}
}
for (const color of colors) {
	for (const token of ["primary", "pilo-composer-border"]) {
		for (const scope of ["theme", "light", "dark"])
			add({ [scope]: { [token]: color } });
	}
}
for (const value of [
	"0",
	"-0",
	"+1",
	".5",
	"1.",
	"1e3",
	"Infinity",
	"１２",
	"١",
	"9".repeat(400),
	"-" + "9".repeat(400),
	"-Infinity",
	"NaN",
	"9".repeat(400) + "px",
	"9".repeat(400) + "rem",
	"2" + "0".repeat(307) + "rem",
	"1" + "0".repeat(307) + "rem",
	"1" + "0".repeat(308) + "px",
	"",
	"0px",
	"-0rem",
	"-.1px",
	"+.5rem",
	"1em",
	"1PX",
	"1 px",
	"9".repeat(510) + "px",
]) {
	for (const token of ["z-dialog", "pilo-bubble-radius"])
		for (const scope of ["theme", "light"])
			add({ [scope]: { [token]: value } });
}
for (const value of [
	"Inter",
	"中文 字体",
	"日本語",
	"한글",
	"العربية",
	"é",
	"e\u0301",
	"𝔘",
	"Ⅷ",
	"²",
	"१२",
	"a_b-c",
	"a  b",
	"a\tb",
	"'a b'",
	'"a\\b"',
	"''",
	"'a,b'",
	"Inter, serif",
	"Inter,",
	"😀",
	'"😀"',
	"a".repeat(512),
	"a".repeat(513),
	'"' + "😀".repeat(255) + '"',
	'"' + "😀".repeat(256) + '"',
	"'a\nb'",
])
	add({ theme: { "font-sans": value } });
for (const space of [
	" ",
	"\t",
	"\n",
	"\r",
	"\v",
	"\f",
	"\u0085",
	"\u00a0",
	"\u1680",
	"\u2003",
	"\u2028",
	"\u2029",
	"\u202f",
	"\u205f",
	"\u3000",
	"\ufeff",
	"\u200b",
]) {
	for (const value of [`${space}1`, `1${space}`])
		add({ theme: { "z-dialog": value } });
	colors.push(`${space}#abc${space}`, `rgb(1${space}2${space}3)`);
}
for (const input of [
	null,
	[],
	false,
	1,
	"x",
	{},
	{ theme: {} },
	{ theme: null },
	{ light: [] },
	{ dark: "x" },
	{ other: {} },
	{ "9": {}, "2": {}, z: {}, a: {} },
	{ theme: { "9": "x", "2": "x", unknown: "x", primary: 3 } },
	{ theme: { primary: null }, light: { primary: "#fff" } },
	{ theme: { "z-dialog": "bad" }, dark: { "z-dialog": "1" } },
	{ theme: [], dark: { primary: "#fff" } },
	{ theme: { primary: "#fff" }, dark: { primary: null } },
	{ theme: { unknown: "x" }, light: { unknown: null } },
])
	add(input);
for (const value of [null, 1, true, [], {}])
	for (const token of ["primary", "font-sans", "z-dialog"])
		add({ theme: { [token]: value } });
for (const [token] of catalog)
	add({
		theme: {
			[token]:
				base.cssVars.theme?.[token] ??
				base.cssVars.light?.[token] ??
				base.cssVars.dark?.[token],
		},
	});
writeFileSync(
	new URL("../fixtures/theme-token-cases.jsonl", import.meta.url),
	[
		{ catalog: Object.fromEntries(catalog) },
		...cases,
		...colors.map((input) => ({
			input,
			expected: parseThemeColor(input) ?? null,
		})),
	]
		.map((entry) => JSON.stringify(entry))
		.join("\n") + "\n",
);

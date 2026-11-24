import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parse } from "postcss";
import { writeGenerated } from "./write-generated.mjs";

const FONT_NAMES = {
	"pilo-page-font-family": "font-sans",
	"pilo-code-font-family": "font-mono",
	"pilo-display-font-family": "font-display",
};
const NUMBER = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(px|rem)?$/;
const HSL_CHANNELS = /^[+-]?[\d.]+\s+[\d.]+%\s+[\d.]+%$/;
const COLOR = /^(?:#|(?:rgba?|hsla?|oklch|color-mix)\(|transparent$)/;

function readScopes(css, selectors, from) {
	const scopes = selectors.map(() => ({}));
	const found = new Set();
	parse(css, { from }).walkRules((rule) => {
		if (
			rule.parent.type !== "atrule" ||
			rule.parent.name !== "layer" ||
			rule.parent.params !== "base" ||
			rule.parent.parent.type !== "root"
		)
			return;
		const index = selectors.indexOf(rule.selector);
		if (index === -1) return;
		found.add(index);
		for (const decl of rule.nodes) {
			if (decl.type === "decl" && decl.prop.startsWith("--")) {
				if (decl.important)
					throw decl.error("Theme tokens cannot use !important");
				scopes[index][decl.prop.slice(2)] = decl.value.trim();
			}
		}
	});
	if (found.size !== scopes.length) {
		throw new Error(
			`${from}: missing one of the theme scopes: ${selectors.join(", ")}`,
		);
	}
	return scopes;
}

function resolveTokens(raw) {
	const values = new Map();
	const resolving = new Set();
	function resolve(name) {
		if (values.has(name)) return values.get(name);
		if (!Object.hasOwn(raw, name))
			throw new Error(`Missing theme token --${name}`);
		if (resolving.has(name)) throw new Error(`Circular theme token --${name}`);
		resolving.add(name);
		const value = raw[name].replace(/var\(\s*--([\w-]+)\s*\)/g, (_, ref) =>
			resolve(ref),
		);
		if (/\bvar\(/.test(value))
			throw new Error(`Unsupported var() in --${name}: ${value}`);
		resolving.delete(name);
		const normalized = value
			.replace(/\s+/g, " ")
			.replace(/\( /g, "(")
			.replace(/ \)/g, ")");
		values.set(name, normalized);
		return normalized;
	}
	return Object.fromEntries(
		Object.keys(raw).map((name) => [name, resolve(name)]),
	);
}

function toPoints(value) {
	const parsed = NUMBER.exec(value);
	return parsed
		? Number(parsed[1]) * (parsed[2] === "rem" ? 16 : 1)
		: undefined;
}

function absoluteCalc(value) {
	// Only fold sums of absolute lengths. Percentages depend on layout.
	const direct = /^calc\(([^()]*)\)$/.exec(value);
	const clamped = /^max\(([^,]+), calc\(([^()]*)\)\)$/.exec(value);
	if (!direct && !clamped) return value;
	const terms = (direct?.[1] ?? clamped[2]).split(/\s+([+-])\s+/);
	let result = toPoints(terms[0]);
	const minimum = clamped ? toPoints(clamped[1]) : -Infinity;
	if (result === undefined || minimum === undefined) return value;
	for (let i = 1; i < terms.length; i += 2) {
		const points = toPoints(terms[i + 1]);
		if (points === undefined) return value;
		result += terms[i] === "+" ? points : -points;
	}
	return `${Math.max(minimum, result)}px`;
}

function nativeValue(name, value) {
	if (value === undefined) return;
	if (
		Object.hasOwn(FONT_NAMES, name) ||
		COLOR.test(value) ||
		NUMBER.test(value)
	)
		return value;
	if (HSL_CHANNELS.test(value)) return `hsl(${value})`;
	const absolute = absoluteCalc(value);
	if (absolute !== value) return absolute;
}

function splitTokens(lightRaw, darkRaw) {
	const light = resolveTokens(lightRaw);
	const dark = resolveTokens(darkRaw);
	const cssVars = { theme: {}, light: {}, dark: {} };
	const styleVars = { theme: {}, light: {}, dark: {} };
	for (const name of Object.keys(dark).toSorted()) {
		const l = Object.hasOwn(light, name) ? light[name] : undefined;
		const d = dark[name];
		const nativeLight = nativeValue(name, l);
		const nativeDark = nativeValue(name, d);
		const nativeName = FONT_NAMES[name] ?? name;
		if (nativeLight !== undefined && nativeLight === nativeDark) {
			cssVars.theme[nativeName] = nativeLight;
		} else if (
			(nativeLight === undefined || COLOR.test(nativeLight)) &&
			nativeDark !== undefined &&
			COLOR.test(nativeDark)
		) {
			if (nativeLight !== undefined) cssVars.light[nativeName] = nativeLight;
			cssVars.dark[nativeName] = nativeDark;
		} else if (l === d) {
			styleVars.theme[name] = d;
		} else {
			if (l !== undefined) styleVars.light[name] = l;
			styleVars.dark[name] = d;
		}
	}
	return { cssVars, styleVars };
}

export function generateThemes(lodyCss, claudeCss) {
	const [lody, lodyDark] = readScopes(
		lodyCss,
		[":root", ".dark"],
		"lody-theme.css",
	);
	const [claude, claudeDark] = readScopes(
		claudeCss,
		[
			':root[data-theme-family="claude"]',
			'.dark:root[data-theme-family="claude"]',
		],
		"claude-theme.css",
	);
	return {
		lody: splitTokens(lody, { ...lody, ...lodyDark }),
		claude: splitTokens(
			{ ...lody, ...claude },
			{ ...lody, ...lodyDark, ...claude, ...claudeDark },
		),
	};
}

function readCss(name) {
	return readFileSync(
		new URL(`../theme/${name}-theme.css`, import.meta.url),
		"utf8",
	);
}

if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	const { lody, claude } = generateThemes(readCss("lody"), readCss("claude"));
	writeGenerated(
		new URL("../theme/theme.json", import.meta.url),
		lody,
		"pnpm generate:themes",
	);
	writeGenerated(
		new URL("../theme/claude-theme.json", import.meta.url),
		claude,
		"pnpm generate:themes",
	);
}

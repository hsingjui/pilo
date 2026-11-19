import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as lucide from "lucide-react";
import iconImports from "lucide-react/dynamicIconImports.mjs";
import ts from "typescript";
import { writeGenerated } from "./write-generated.mjs";

const iconModules = new Map(
	Object.entries(iconImports).map(([name, load]) => [
		name.replace(/(^|-)([a-z0-9])/g, (_, _separator, char) =>
			char.toUpperCase(),
		),
		load,
	]),
);

const shapeAttributes = {
	path: ["d"],
	circle: ["cx", "cy", "r"],
	rect: ["x", "y", "width", "height", "rx", "ry"],
	line: ["x1", "y1", "x2", "y2"],
	polyline: ["points"],
};

export function findLucideImports(path, code) {
	const source = ts.createSourceFile(path, code, ts.ScriptTarget.Latest);
	return source.statements.flatMap((statement) => {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== "lucide-react" ||
			statement.importClause?.isTypeOnly
		)
			return [];
		const { name: defaultImport, namedBindings } = statement.importClause ?? {};
		if (defaultImport || !namedBindings || !ts.isNamedImports(namedBindings)) {
			throw new Error(`${path}: use named Lucide icon imports`);
		}
		return namedBindings.elements
			.filter((item) => !item.isTypeOnly)
			.map(({ propertyName, name }) => (propertyName ?? name).text);
	});
}

function readSourceIcons() {
	const source = fileURLToPath(new URL("../src/", import.meta.url));
	return readdirSync(source, { recursive: true, withFileTypes: true })
		.filter((file) => file.isFile() && /\.[jt]sx?$/.test(file.name))
		.flatMap(({ parentPath, name }) => {
			const path = join(parentPath, name);
			return findLucideImports(path, readFileSync(path, "utf8"));
		});
}

function rectPath(number) {
	const x = number("x", 0);
	const y = number("y", 0);
	const width = number("width");
	const height = number("height");
	const radiusX = number("rx", number("ry", 0));
	const rx = Math.min(radiusX, width / 2);
	const ry = Math.min(number("ry", radiusX), height / 2);
	const right = x + width;
	const bottom = y + height;
	if (rx === 0 || ry === 0) return `M${x} ${y}H${right}V${bottom}H${x}Z`;
	const arc = `A${rx} ${ry} 0 0 1`;
	return `M${x + rx} ${y}H${right - rx}${arc} ${right} ${y + ry}V${bottom - ry}${arc} ${right - rx} ${bottom}H${x + rx}${arc} ${x} ${bottom - ry}V${y + ry}${arc} ${x + rx} ${y}Z`;
}

function shapePath(tag, attrs) {
	if (!Object.hasOwn(shapeAttributes, tag))
		throw new Error(`unsupported SVG shape <${tag}>`);
	for (const key of Object.keys(attrs)) {
		if (
			key !== "key" &&
			key !== "fill" &&
			!shapeAttributes[tag].includes(key)
		) {
			throw new Error(`unsupported <${tag}> attribute ${key}`);
		}
	}
	const number = (key, fallback) => {
		const value = Number(attrs[key] ?? fallback);
		if (!Number.isFinite(value)) throw new Error(`invalid <${tag}> ${key}`);
		return value;
	};
	switch (tag) {
		case "path":
			if (!attrs.d?.trim()) throw new Error("empty path");
			return attrs.d;
		case "circle": {
			const x = number("cx", 0);
			const y = number("cy", 0);
			const r = number("r");
			return `M${x - r} ${y}A${r} ${r} 0 1 0 ${x + r} ${y}A${r} ${r} 0 1 0 ${x - r} ${y}Z`;
		}
		case "rect":
			return rectPath(number);
		case "line":
			return `M${number("x1", 0)} ${number("y1", 0)}L${number("x2", 0)} ${number("y2", 0)}`;
		case "polyline": {
			const points = attrs.points
				.trim()
				.split(/[\s,]+/)
				.map(Number);
			if (
				points.length < 4 ||
				points.length % 2 !== 0 ||
				!points.every(Number.isFinite)
			) {
				throw new Error("invalid polyline points");
			}
			return `M${points.join(" ")}`;
		}
	}
}

async function loadIcon(name) {
	const canonical = lucide[name]?.displayName;
	const load = iconModules.get(canonical);
	if (!load) throw new Error(`Unknown Lucide icon: ${name}`);
	// The locked Lucide version exports the raw data next to each ESM component.
	const { __iconData: data, default: component } = await load();
	if (
		!data ||
		component.displayName !== canonical ||
		!Number.isFinite(data.size) ||
		data.size <= 0 ||
		!data.node?.length
	) {
		throw new Error(`Cannot read Lucide data for ${name}`);
	}
	return [
		name,
		{
			size: data.size,
			paths: data.node.map(([tag, attrs]) => {
				try {
					const d = shapePath(tag, attrs);
					if (attrs.fill === "currentColor") return { d, fill: true };
					if (attrs.fill === undefined || attrs.fill === "none") return { d };
					throw new Error(`unsupported fill ${attrs.fill}`);
				} catch (error) {
					throw new Error(`Lucide ${name}: ${error.message}`, { cause: error });
				}
			}),
		},
	];
}

export async function generateIcons(names) {
	return Object.fromEntries(
		await Promise.all([...new Set(names)].toSorted().map(loadIcon)),
	);
}

if (
	process.argv[1] &&
	pathToFileURL(process.argv[1]).href === import.meta.url
) {
	writeGenerated(
		new URL("../desktop/app/lucide-icons.json", import.meta.url),
		await generateIcons(readSourceIcons()),
		"pnpm desktop:generate:icons",
	);
}

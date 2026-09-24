import type { ToolCallActivity } from "@/components/chat/chat-activity";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function formatUnknown(value: unknown) {
	if (typeof value === "string") return value;
	try {
		const serialized = JSON.stringify(value, null, 2);
		return serialized ?? String(value);
	} catch {
		return String(value);
	}
}

export function resultContent(value: unknown): {
	blocks: unknown[];
	metadata: Record<string, unknown> | null;
	fallback: string | null;
} {
	if (!isRecord(value)) {
		return { blocks: [], metadata: null, fallback: formatUnknown(value) };
	}
	const blocks = Array.isArray(value.content) ? value.content : [];
	const metadata = Object.fromEntries(
		Object.entries(value).filter(([key]) => key !== "content"),
	);
	return {
		blocks,
		metadata: Object.keys(metadata).length > 0 ? metadata : null,
		fallback:
			blocks.length === 0 && Object.keys(metadata).length === 0
				? formatUnknown(value)
				: null,
	};
}

export function flattenToolResult(result: ReturnType<typeof resultContent>) {
	const text: string[] = [];
	const images: Array<{ data: string; mimeType: string; key: string }> = [];
	const imageOccurrences = new Map<string, number>();

	for (const block of result.blocks) {
		if (typeof block === "string") {
			text.push(block);
			continue;
		}
		if (
			isRecord(block) &&
			block.type === "text" &&
			typeof block.text === "string"
		) {
			text.push(block.text);
			continue;
		}
		if (
			isRecord(block) &&
			block.type === "image" &&
			typeof block.data === "string" &&
			typeof block.mimeType === "string" &&
			block.mimeType.startsWith("image/")
		) {
			const baseKey = `${block.mimeType}:${block.data.length}:${block.data.slice(0, 32)}`;
			const occurrence = (imageOccurrences.get(baseKey) ?? 0) + 1;
			imageOccurrences.set(baseKey, occurrence);
			images.push({
				data: block.data,
				mimeType: block.mimeType,
				key: `${baseKey}:${occurrence}`,
			});
			continue;
		}
		text.push(formatUnknown(block));
	}

	if (result.metadata) text.push(formatUnknown(result.metadata));
	if (result.fallback) text.push(result.fallback);

	return { text: text.filter(Boolean).join("\n"), images };
}

export function toolEditDiff(result: unknown) {
	if (!isRecord(result)) return null;
	const details = result.details;
	if (!isRecord(details)) return null;
	const diff = details.diff;
	if (typeof diff === "string" && diff.trim()) return diff;
	const patch = details.patch;
	return typeof patch === "string" && patch.trim() ? patch : null;
}

export function keyedDiffLines(diff: string) {
	const occurrences = new Map<string, number>();
	return diff.split("\n").map((line) => {
		const occurrence = (occurrences.get(line) ?? 0) + 1;
		occurrences.set(line, occurrence);
		return { line, key: `${line}:${occurrence}` };
	});
}

export function diffLineStyle(line: string) {
	if (line.startsWith("+") && !line.startsWith("+++")) {
		return {
			marker: "+",
			content: line.slice(1),
			className: "bg-code-added/[0.07] text-foreground/80",
			markerClassName: "text-code-added",
		};
	}
	if (line.startsWith("-") && !line.startsWith("---")) {
		return {
			marker: "−",
			content: line.slice(1),
			className: "bg-destructive/[0.06] text-foreground/80",
			markerClassName: "text-destructive",
		};
	}
	if (
		line.startsWith("@@") ||
		line.startsWith("---") ||
		line.startsWith("+++") ||
		line.trim() === "..."
	) {
		return {
			marker: "",
			content: line,
			className: "text-muted-foreground",
			markerClassName: "",
		};
	}
	return {
		marker: "",
		content: line,
		className: "text-muted-foreground",
		markerClassName: "",
	};
}

export function fileBasename(path: string) {
	const normalized = path.replace(/[\\/]+$/, "");
	const parts = normalized.split(/[\\/]/);
	return parts[parts.length - 1] || path;
}

export function toolPreview(activity: ToolCallActivity) {
	if (!isRecord(activity.args)) return null;
	for (const key of [
		"command",
		"path",
		"filePath",
		"query",
		"pattern",
		"url",
	]) {
		const value = activity.args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

export function toolFilePath(activity: ToolCallActivity) {
	if (!isRecord(activity.args)) return null;
	for (const key of ["path", "filePath"]) {
		const value = activity.args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

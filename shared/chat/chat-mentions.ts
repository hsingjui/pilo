import {
	sessionMentionValue,
	type SessionMention,
} from "@shared/chat/session-mentions";

export type ChatMention =
	| { kind: "session"; path: string; session: SessionMention }
	| { kind: "file"; path: string };

export function fileMentionName(path: string) {
	return path.split(/[\\/]/).pop() || path;
}

/** Quoted paths distinguish completed file picks from an active @ query. */
export function fileMentionValue(path: string) {
	return `@"${path}"`;
}

export function fileMentionPath(value: string): string | null {
	if (!value.startsWith('@"') || !value.endsWith('"')) return null;
	const path = value.slice(2, -1);
	if (!path || /[\r\n"]/.test(path) || path.startsWith("~")) return null;
	const absolute = /^(?:[/\\]|[a-z]:[/\\])/i.test(path);
	// Only server attachment paths extend the relative-file contract; unknown
	// absolute session references must continue to render as ordinary text.
	if (
		absolute &&
		!/[/\\]attachments[/\\][A-Za-z0-9_-]{21}[AQgw][/\\][^/\\]+$/.test(path)
	)
		return null;
	return path;
}

export type ChatMentionPart = {
	value: string;
	start: number;
	mention?: ChatMention;
};

/** Completed picks stay ordinary @paths, including when embedded in body text. */
export function readChatMentionParts(
	value: string,
	sessions: ReadonlyMap<string, SessionMention>,
): ChatMentionPart[] {
	const parts: ChatMentionPart[] = [];
	// Completed inline references do not require leading whitespace.
	const pattern = /@"(?:\\.|[^"\\\r\n])*"|@[^\s"]+/g;
	let offset = 0;
	for (const match of value.matchAll(pattern)) {
		const token = match[0];
		const session = sessions.get(token);
		const path = session?.path ?? fileMentionPath(token);
		if (!path) continue;
		const start = match.index;
		if (start > offset)
			parts.push({ value: value.slice(offset, start), start: offset });
		parts.push({
			value: token,
			start,
			mention: session
				? { kind: "session", path, session }
				: { kind: "file", path },
		});
		offset = start + token.length;
	}
	if (offset < value.length)
		parts.push({ value: value.slice(offset), start: offset });
	return parts;
}

export function readChatMentionDraft(
	value: string,
	sessions: ReadonlyMap<string, SessionMention>,
) {
	const references: ChatMention[] = [];
	const seen = new Set<string>();
	const lines: string[] = [];
	for (const line of value.split("\n")) {
		const parts = readChatMentionParts(line, sessions);
		let text = "";
		let hasReference = false;
		for (const part of parts) {
			if (!part.mention) {
				text += part.value;
				continue;
			}
			hasReference = true;
			const key = `${part.mention.kind}:${part.mention.path}`;
			if (!seen.has(key)) {
				seen.add(key);
				references.push(part.mention);
			}
		}
		// Existing inline drafts and trailing reference blocks share the same shelf.
		if (!hasReference || text.trim()) lines.push(text);
	}
	return { references, text: lines.join("\n") };
}

export function writeChatMentionDraft(
	references: readonly ChatMention[],
	text: string,
) {
	const values = [
		...new Set(
			references.map((mention) =>
				mention.kind === "session"
					? sessionMentionValue(mention.path)
					: fileMentionValue(mention.path),
			),
		),
	];
	return values.length
		? `${text ? `${text}\n` : ""}${values.join("\n")}`
		: text;
}

export type MentionEnhancementPayload = {
	text: string;
	placeholders: readonly { token: string; raw: string }[];
};

/**
 * 将正文中的内联 `@文件` / `@会话` 替换为稳定占位符供草稿优化模型改写，
 * 以便优化后尽量把引用还原在原句中，而不是全部抽离堆到末尾。
 */
export function prepareMentionDraftForEnhancement(
	value: string,
	sessions: ReadonlyMap<string, SessionMention>,
): MentionEnhancementPayload {
	const parts = readChatMentionParts(value, sessions);
	const placeholders: { token: string; raw: string }[] = [];
	const chunks: string[] = [];
	let prefix = "PILO_REF";
	while (value.includes(`[[${prefix}_`)) {
		prefix += "_X";
	}
	for (const part of parts) {
		if (!part.mention) {
			chunks.push(part.value);
			continue;
		}
		const token = `[[${prefix}_${placeholders.length}]]`;
		placeholders.push({ token, raw: part.value });
		chunks.push(token);
	}
	return { text: chunks.join(""), placeholders };
}

/**
 * 将优化后的文本中的占位符还原为原始 `@` 引用；
 * 若模型遗漏了部分占位符，则按原顺序补回末尾，确保绝不丢失引用。
 */
export function restoreMentionDraftFromEnhancement(
	enhancedText: string,
	placeholders: readonly { token: string; raw: string }[],
): string {
	if (placeholders.length === 0) return enhancedText;
	const byToken = new Map<string, string>();
	for (const { token, raw } of placeholders) {
		byToken.set(token, raw);
	}
	const restoredRaws = new Set<string>();
	const pattern = new RegExp(
		Array.from(byToken.keys(), (token) =>
			token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
		).join("|"),
		"g",
	);
	const result = enhancedText.replace(pattern, (match) => {
		const raw = byToken.get(match);
		if (raw === undefined) return match;
		restoredRaws.add(raw);
		return raw;
	});
	const missing: string[] = [];
	const seenMissing = new Set<string>();
	for (const { raw } of placeholders) {
		if (!restoredRaws.has(raw) && !seenMissing.has(raw)) {
			seenMissing.add(raw);
			missing.push(raw);
		}
	}
	return missing.length
		? `${result ? `${result}\n` : ""}${missing.join("\n")}`
		: result;
}

/**
 * 从草稿中精确移除指定的文件或会话引用，同时保持其余内联引用在正文中的原始位置。
 * 如果引用独占一行，连同该行一并清除；如果处于行内，顺带折叠紧邻的一格多余空格。
 */
export function removeChatMention(
	value: string,
	target: Pick<ChatMention, "kind" | "path">,
	sessions: ReadonlyMap<string, SessionMention>,
): string {
	const lines = value.split("\n");
	const nextLines: string[] = [];
	for (const line of lines) {
		const parts = readChatMentionParts(line, sessions);
		let removedAny = false;
		const kept: ChatMentionPart[] = [];
		for (const part of parts) {
			if (
				part.mention &&
				part.mention.kind === target.kind &&
				part.mention.path === target.path
			) {
				removedAny = true;
				continue;
			}
			kept.push(part);
		}
		if (!removedAny) {
			nextLines.push(line);
			continue;
		}
		let rebuilt = "";
		for (const part of kept) {
			if (
				!part.mention &&
				rebuilt.endsWith(" ") &&
				part.value.startsWith(" ")
			) {
				rebuilt += part.value.slice(1);
			} else {
				rebuilt += part.value;
			}
		}
		// 移除行首或行尾因删除内联引用而残留的单个空格；若整行原本只有该引用则整行移除。
		const hadNonTarget = kept.some((part) => part.mention || part.value.trim());
		if (!hadNonTarget) continue;
		const trimmed = rebuilt.replace(/^ (?=\S)/, "").replace(/(?<=\S) $/, "");
		nextLines.push(trimmed);
	}
	return nextLines.join("\n");
}

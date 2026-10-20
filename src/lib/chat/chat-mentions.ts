import {
	sessionMentionValue,
	type SessionMention,
} from "@/lib/chat/session-mentions";

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

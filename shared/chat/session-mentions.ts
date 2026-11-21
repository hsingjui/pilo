export type SessionMention = {
	connectionId: string;
	projectId: string;
	path: string;
	title: string;
	projectName: string;
	updatedAt: number;
};

export function sessionMentionValue(path: string) {
	if (/[\r\n"]/.test(path)) return `@${JSON.stringify(path)}`;
	// Keep Windows separators literal, just like existing file mentions.
	return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

/** References use ordinary @path lines, so drafts, queues and Pi JSONL stay plain text. */
export function readSessionMentionDraft(
	value: string,
	mentions: ReadonlyMap<string, SessionMention>,
) {
	const lines = value.split("\n");
	let referenceStart = lines.length;
	while (referenceStart > 0 && mentions.has(lines[referenceStart - 1]))
		referenceStart -= 1;
	const references = new Map<string, SessionMention>();
	for (const line of lines.slice(referenceStart)) {
		const mention = mentions.get(line);
		if (mention) references.set(mention.path, mention);
	}
	return {
		references: [...references.values()],
		text: lines.slice(0, referenceStart).join("\n"),
	};
}

export function writeSessionMentionDraft(
	references: readonly SessionMention[],
	text: string,
) {
	const values = [
		...new Set(references.map((mention) => sessionMentionValue(mention.path))),
	];
	return values.length
		? `${text ? `${text}\n` : ""}${values.join("\n")}`
		: text;
}

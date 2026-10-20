import { parseSkillInvocation } from "./skill-invocation.ts";
import { fileMentionName, readChatMentionParts } from "./chat-mentions.ts";
import type { SessionMention } from "./session-mentions.ts";
import type { ChatMessage } from "./conversation-types.ts";
import { markdownSearchText, searchTextMatches } from "./chat-search-text.ts";

export type ChatMessageMatch = {
	messageId: string;
	messageIndex: number;
	/** 该消息内第几个命中（0 起），用于对齐 DOM 字符级高亮。 */
	occurrenceIndex: number;
	/** Assistant 文本段的身份与段内序号，避免折叠工作过程后命中错位。 */
	contentId?: string;
	contentOccurrenceIndex?: number;
	/** 命中在可搜索的可见文本中的区间。 */
	start: number;
	end: number;
	/** 命中位置附近的片段，用于展示。 */
	snippet: string;
};

const SNIPPET_LEAD = 24;
const SNIPPET_TAIL = 80;
const markdownTextCache = new WeakMap<
	object,
	{ source: string; text: string }
>();

const EMPTY_SESSIONS: ReadonlyMap<string, SessionMention> = new Map();

/** Match rendered user content: Skill name and inline reference labels in body order. */
function searchableText(
	message: ChatMessage,
	sessions: ReadonlyMap<string, SessionMention>,
): string {
	if (message.role !== "user") return message.text;
	const invocation = parseSkillInvocation(message.text);
	const parts = readChatMentionParts(
		invocation ? invocation.additionalInstructions : message.text,
		sessions,
	);
	return [
		...(invocation ? [invocation.name] : []),
		parts
			.map(({ value, mention }) =>
				mention
					? `\n${mention.kind === "session" ? mention.session.title : fileMentionName(mention.path)}\n`
					: value,
			)
			.join(""),
	].join("\n");
}

/**
 * 在当前会话已加载的消息中做大小写不敏感的子串查找。
 * 每条命中位置各产出一条记录（同一消息内多次命中算多条），导航以「命中」为单位。
 */
export function findMessageMatches(
	messages: readonly ChatMessage[],
	query: string,
	sessions: ReadonlyMap<string, SessionMention> = EMPTY_SESSIONS,
): ChatMessageMatch[] {
	if (!query.trim()) return [];
	const matches: ChatMessageMatch[] = [];
	messages.forEach((message, messageIndex) => {
		if (message.historyPlaceholder) return;
		const textContent =
			message.role === "assistant"
				? message.content?.filter((item) => item.type === "text")
				: undefined;
		const sections = textContent?.length
			? textContent
			: [
					{
						id: message.role === "assistant" ? `${message.id}-text` : undefined,
						text: searchableText(message, sessions),
					},
				];
		let occurrenceIndex = 0;
		let offset = 0;
		for (const section of sections) {
			let text = section.text;
			if (message.role !== "user") {
				const key = textContent?.length ? section : message;
				const cached = markdownTextCache.get(key);
				if (cached?.source === section.text) {
					text = cached.text;
				} else {
					text = markdownSearchText(section.text);
					markdownTextCache.set(key, { source: section.text, text });
				}
			}
			let contentOccurrenceIndex = 0;
			for (const range of searchTextMatches(text, query)) {
				const from = Math.max(0, range.start - SNIPPET_LEAD);
				matches.push({
					messageId: message.id,
					messageIndex,
					occurrenceIndex,
					...(section.id !== undefined
						? { contentId: section.id, contentOccurrenceIndex }
						: {}),
					start: offset + range.start,
					end: offset + range.end,
					snippet: text.slice(from, range.end + SNIPPET_TAIL),
				});
				occurrenceIndex += 1;
				contentOccurrenceIndex += 1;
			}
			offset += text.length;
		}
	});
	return matches;
}

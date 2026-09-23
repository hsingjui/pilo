import { skillInvocationSummary } from "./skill-invocation.ts";
import type { ChatMessage } from "./conversation-types.ts";

export type ChatMessageMatch = {
	messageId: string;
	messageIndex: number;
	/** 该消息内第几个命中（0 起），用于对齐 DOM 字符级高亮。 */
	occurrenceIndex: number;
	/** 命中的字符在消息文本中的起点。 */
	start: number;
	/** 命中位置附近的片段，用于展示。 */
	snippet: string;
};

const SNIPPET_LEAD = 24;
const SNIPPET_TAIL = 80;

/**
 * 查找用的消息文本：用户输入与 Agent 回复都取原文（包含 Markdown 与代码块），
 * 仅用户消息的 Skill 展开块改用 `/skill:<name>` 摘要（与界面显示一致）。
 */
function searchableText(message: ChatMessage): string {
	if (message.role !== "user") return message.text;
	return skillInvocationSummary(message.text) ?? message.text;
}

/**
 * 在当前会话已加载的消息中做大小写不敏感的子串查找。
 * 每条命中位置各产出一条记录（同一消息内多次命中算多条），导航以「命中」为单位。
 */
export function findMessageMatches(
	messages: readonly ChatMessage[],
	query: string,
): ChatMessageMatch[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const matches: ChatMessageMatch[] = [];
	messages.forEach((message, messageIndex) => {
		if (message.historyPlaceholder) return;
		const text = searchableText(message);
		const lower = text.toLowerCase();
		let occurrenceIndex = 0;
		let at = lower.indexOf(needle);
		while (at >= 0) {
			const from = Math.max(0, at - SNIPPET_LEAD);
			matches.push({
				messageId: message.id,
				messageIndex,
				occurrenceIndex,
				start: at,
				snippet: text.slice(from, at + needle.length + SNIPPET_TAIL),
			});
			occurrenceIndex += 1;
			at = lower.indexOf(needle, at + needle.length);
		}
	});
	return matches;
}

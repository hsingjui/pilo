import { skillInvocationSummary } from "./skill-invocation.ts";
import { i18n } from "../i18n/index.ts";

export type ConversationOutlineMessage = {
	id: string;
	role: "user" | "assistant" | "compaction";
	text: string;
};

export type ConversationOutlineEntry = {
	key: string;
	messageIndex: number;
	title: string;
	preview: string;
	weight: 0 | 1 | 2 | 3;
};

function plainText(value: string) {
	return value
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}#{1,6}\s+/gm, "")
		.replace(/[>*_~]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function truncate(value: string, length: number) {
	const points = Array.from(value);
	return points.length > length
		? `${points.slice(0, length).join("").trimEnd()}…`
		: value;
}

function weightForLength(length: number): 0 | 1 | 2 | 3 {
	if (length >= 3000) return 3;
	if (length >= 1500) return 2;
	if (length >= 700) return 1;
	return 0;
}

export function buildConversationOutline(
	messages: readonly ConversationOutlineMessage[],
): ConversationOutlineEntry[] {
	const entries: ConversationOutlineEntry[] = [];
	let current: ConversationOutlineEntry | undefined;
	let currentLength = 0;

	const closeRound = () => {
		if (current) current.weight = weightForLength(currentLength);
		current = undefined;
		currentLength = 0;
	};

	for (const [messageIndex, message] of messages.entries()) {
		if (message.role === "compaction") continue;
		// Skill 调用被 Pi 展开成大段 <skill> 文本，大纲标题用 /skill:<name> 摘要。
		const sourceText =
			message.role === "user"
				? (skillInvocationSummary(message.text) ?? message.text)
				: message.text;
		const summary = plainText(sourceText);
		if (message.role === "user" || !current) {
			closeRound();
			current = {
				key: message.id,
				messageIndex,
				title: truncate(summary || i18n.t("chat.untitledMessage"), 72),
				preview: message.role === "assistant" ? truncate(summary, 240) : "",
				weight: 0,
			};
			entries.push(current);
			currentLength = message.text.length;
			continue;
		}
		currentLength += message.text.length;
		if (!current.preview && message.role === "assistant") {
			current.preview = truncate(summary, 240);
		}
	}
	closeRound();
	return entries;
}

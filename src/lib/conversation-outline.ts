export type ConversationOutlineMessage = {
	id: string;
	role: "user" | "assistant";
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
		const summary = plainText(message.text);
		if (message.role === "user" || !current) {
			closeRound();
			current = {
				key: message.id,
				messageIndex,
				title: truncate(summary || "未命名消息", 72),
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

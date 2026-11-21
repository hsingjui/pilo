import { skillInvocationSummary } from "./skill-invocation.ts";
import { i18n } from "../i18n/instance.ts";

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

/** 供大纲与会话内查找复用的消息纯文本化。 */
export function messageSearchText(message: ConversationOutlineMessage): string {
	const source =
		message.role === "user"
			? (skillInvocationSummary(message.text) ?? message.text)
			: message.text;
	return plainText(source);
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

/**
 * Las entradas que caben en `maxTicks` marcas: todas cuando sobra sitio, o
 * una muestra uniforme que conserva la primera y la última. Cada marca
 * devuelta lleva el índice real de su entrada en `entries`.
 */
export function sampleOutlineEntries(
	entries: readonly ConversationOutlineEntry[],
	maxTicks: number,
): { entry: ConversationOutlineEntry; index: number }[] {
	const count = entries.length;
	if (count === 0 || maxTicks < 1) return [];
	if (maxTicks === 1) {
		return [{ entry: entries[count - 1], index: count - 1 }];
	}
	if (count <= maxTicks) {
		return entries.map((entry, index) => ({ entry, index }));
	}
	const ticks: { entry: ConversationOutlineEntry; index: number }[] = [];
	for (let tick = 0; tick < maxTicks; tick++) {
		const index = Math.round((tick * (count - 1)) / (maxTicks - 1));
		ticks.push({ entry: entries[index], index });
	}
	return ticks;
}

/**
 * El índice de la entrada de la ronda que se está leyendo: la última que
 * empieza en `firstVisibleIndex` o antes. Con la lista pegada al final
 * (`isAtEnd`) es la última: el mensaje más reciente manda aunque el tope
 * del viewport siga dentro de una ronda anterior. Sin entradas, `-1`.
 */
export function getOutlineIndexForVisibleRange(
	entries: readonly ConversationOutlineEntry[],
	firstVisibleIndex: number,
	isAtEnd: boolean,
) {
	if (entries.length === 0) return -1;
	if (isAtEnd) return entries.length - 1;
	let active = 0;
	for (const [index, entry] of entries.entries()) {
		if (entry.messageIndex > firstVisibleIndex) break;
		active = index;
	}
	return active;
}

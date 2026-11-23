import { skillInvocationSummary } from "./skill-invocation.ts";
import { t } from "../i18n/translate.ts";

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
	let count = 0;
	let end = 0;
	for (const point of value) {
		if (count++ === length) return `${value.slice(0, end).trimEnd()}…`;
		end += point.length;
	}
	return value;
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

function buildOutlineTail(
	messages: readonly ConversationOutlineMessage[],
	start: number,
	untitled: string,
): ConversationOutlineEntry[] {
	const entries: ConversationOutlineEntry[] = [];
	let current: ConversationOutlineEntry | undefined;
	let currentLength = 0;

	const closeRound = () => {
		if (current) current.weight = weightForLength(currentLength);
		current = undefined;
		currentLength = 0;
	};

	for (
		let messageIndex = start;
		messageIndex < messages.length;
		messageIndex++
	) {
		const message = messages[messageIndex];
		if (message.role === "compaction") continue;
		if (message.role === "user" || !current) {
			const summary = messageSearchText(message);
			closeRound();
			current = {
				key: message.id,
				messageIndex,
				title: truncate(summary || untitled, 72),
				preview: message.role === "assistant" ? truncate(summary, 240) : "",
				weight: 0,
			};
			entries.push(current);
			currentLength = message.text.length;
			continue;
		}
		currentLength += message.text.length;
		if (!current.preview) {
			current.preview = truncate(messageSearchText(message), 240);
		}
	}
	closeRound();
	return entries;
}

export function buildConversationOutline(
	messages: readonly ConversationOutlineMessage[],
): ConversationOutlineEntry[] {
	return buildOutlineTail(messages, 0, t("chat.untitledMessage"));
}

/** Reuse finished rounds, skipping the merged history prefix while it is unchanged. */
export function createConversationOutline() {
	let previousMessages: readonly ConversationOutlineMessage[] = [];
	let previousHistory: readonly ConversationOutlineMessage[] | undefined;
	let previousUntitled: string | undefined;
	let entries: ConversationOutlineEntry[] = [];
	return (
		messages: readonly ConversationOutlineMessage[],
		historyPrefix: readonly ConversationOutlineMessage[],
		untitled: string,
	): readonly ConversationOutlineEntry[] => {
		let unchanged = 0;
		if (historyPrefix === previousHistory && untitled === previousUntitled) {
			if (messages === previousMessages) return entries;
			unchanged = historyPrefix.length;
			const commonLength = Math.min(messages.length, previousMessages.length);
			for (; unchanged < commonLength; unchanged++) {
				const a = previousMessages[unchanged];
				const b = messages[unchanged];
				if (
					a !== b &&
					(a.id !== b.id || a.role !== b.role || a.text !== b.text)
				)
					break;
			}
		}
		const sameMessages =
			unchanged === messages.length && unchanged === previousMessages.length;
		previousMessages = messages;
		previousHistory = historyPrefix;
		previousUntitled = untitled;
		if (sameMessages) return entries;

		// A changed row can start or remove a round, so resume at the preceding round.
		const from =
			unchanged === 0
				? 0
				: Math.max(
						0,
						getOutlineIndexForVisibleRange(entries, unchanged - 1, false),
					);
		const start = Math.min(unchanged, entries[from]?.messageIndex ?? unchanged);
		const tail = buildOutlineTail(messages, start, untitled);
		if (
			entries.length === from + tail.length &&
			tail.every((entry, index) => {
				const before = entries[from + index];
				return (
					entry.key === before.key &&
					entry.messageIndex === before.messageIndex &&
					entry.title === before.title &&
					entry.preview === before.preview &&
					entry.weight === before.weight
				);
			})
		)
			return entries;
		entries = from === 0 ? tail : entries.slice(0, from).concat(tail);
		return entries;
	};
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
	let low = 0;
	let high = entries.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (entries[mid].messageIndex <= firstVisibleIndex) low = mid + 1;
		else high = mid;
	}
	return Math.max(0, low - 1);
}

import { context, signal, type Signal } from "nsh";

import type { AssistantContentItem } from "@shared/chat/chat-activity-state";

/** Lets a manual disclosure yield bottom-following in its message list. */
export const ChatDisclosureAction = context<(update: () => void) => void>(
	(update) => update(),
);

/** The key of a tool call's details, as the WebUI names it. */
export function chatToolExpansionKey(messageId: string, toolCallId: string) {
	return `tool:${messageId}:${toolCallId}`;
}

/** The key of a thinking block's details within an activity group. */
export function chatThinkingExpansionKey(
	groupExpansionKey: string,
	thinkingId: string,
) {
	return `${groupExpansionKey}:thinking:${thinkingId}`;
}

/**
 * What the user opened and closed in one chat, as the WebUI's expansion
 * store keeps it. A list row is dropped when it scrolls away and reused for
 * other messages, so a disclosure reads its state from here by key: until
 * the user presses it, it shows its own default (which may change, a turn
 * that ends folds its work); once pressed, it shows the user's choice.
 */
export class ChatExpansion {
	private readonly chosen = new Map<string, Signal<boolean | undefined>>();

	private choice(key: string): Signal<boolean | undefined> {
		let choice = this.chosen.get(key);
		if (!choice) {
			choice = signal<boolean | undefined>(undefined);
			this.chosen.set(key, choice);
		}
		return choice;
	}

	/** Whether the disclosure at `key` is open: the user's choice, else `initial`. */
	isOpen(key: string, initial: boolean): boolean {
		return this.choice(key)() ?? initial;
	}

	/** Keeps the user's choice for the disclosure at `key`. */
	setOpen(key: string, open: boolean): void {
		this.choice(key).set(open);
	}

	/** Where in `content` the first tool the user opened is, or -1. */
	findExpandedToolIndex(
		messageId: string,
		content: readonly AssistantContentItem[],
	): number {
		return content.findIndex(
			(item) =>
				item.type === "tool" &&
				this.choice(chatToolExpansionKey(messageId, item.id))() === true,
		);
	}

	/** 检查用户是否手动展开了该组内的工具、思考块或分组本身，防止自动折叠抽走正在阅读的内容。 */
	hasUserExpandedActivity(
		messageId: string,
		groupExpansionKey: string,
		content: readonly AssistantContentItem[],
	): boolean {
		if (this.choice(`${groupExpansionKey}:group`)() === true) return true;
		return content.some((item) =>
			item.type === "tool"
				? this.choice(chatToolExpansionKey(messageId, item.id))() === true
				: item.type === "thinking"
					? this.choice(
							chatThinkingExpansionKey(groupExpansionKey, item.id),
						)() === true
					: false,
		);
	}
}

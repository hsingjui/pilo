import type { ChatMessage } from "@shared/chat/conversation-types";

/**
 * The height an unloaded history message's placeholder row takes, estimated
 * from the message's length: the rows around it are laid out before the
 * message is read, so their places stay about right for when it arrives.
 * Shared by the WebUI's row and the nsh desktop list.
 */
export function historyPlaceholderHeight(message: ChatMessage): number {
	const estimatedChars = message.historyEstimatedChars ?? message.text.length;
	switch (message.role) {
		case "user":
			return Math.min(152, 52 + Math.ceil(estimatedChars / 90) * 20);
		case "compaction":
			return 40;
		default:
			return Math.min(360, 72 + Math.ceil(estimatedChars / 110) * 20);
	}
}

import { createContext, useContext } from "react";

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

export const ChatFindMatchContext = createContext<ChatMessageMatch | null>(
	null,
);

export function useChatFindMatch(messageId: string) {
	const match = useContext(ChatFindMatchContext);
	return match?.messageId === messageId ? match : null;
}

import { memo } from "react";

import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { AssistantMessage } from "@/components/chat/chat-message";
import { UserMessage } from "@/components/chat/chat-user-message";
import { CompactionMessage } from "@/components/chat/compaction-message";
import type { ChatMessage } from "@/lib/conversation-types";

type MessageRowProps = {
	message: ChatMessage;
	isLastMessage: boolean;
	onForkAssistant?: (messageId: string) => void;
	forkingMessageId?: string | null;
	forkDisabled?: boolean;
	suppressInterruptedError?: boolean;
};

function HistoryMessagePlaceholder({ message }: { message: ChatMessage }) {
	const estimatedChars = message.historyEstimatedChars ?? message.text.length;
	const estimatedHeight =
		message.role === "user"
			? Math.min(152, 52 + Math.ceil(estimatedChars / 90) * 20)
			: message.role === "compaction"
				? 40
				: Math.min(360, 72 + Math.ceil(estimatedChars / 110) * 20);
	return (
		<ConversationColumn className="py-2 sm:py-3">
			<div
				className={
					message.role === "user"
						? "ml-auto w-[min(70%,28rem)] rounded-2xl border border-foreground/[0.05] bg-foreground/[0.025]"
						: "w-full rounded-lg bg-foreground/[0.018]"
				}
				style={{ minHeight: estimatedHeight }}
				data-history-placeholder="true"
				aria-hidden="true"
			/>
		</ConversationColumn>
	);
}

function renderMessageRow({
	message,
	isLastMessage,
	onForkAssistant,
	forkingMessageId,
	forkDisabled,
	suppressInterruptedError,
}: MessageRowProps) {
	if (message.historyPlaceholder) {
		return <HistoryMessagePlaceholder message={message} />;
	}
	if (message.role === "compaction") {
		return <CompactionMessage message={message} />;
	}
	return message.role === "user" ? (
		<UserMessage message={message} />
	) : (
		<AssistantMessage
			message={message}
			onFork={onForkAssistant}
			forking={forkingMessageId === message.id}
			forkDisabled={forkDisabled}
			suppressInterruptedError={
				Boolean(suppressInterruptedError) && isLastMessage
			}
			replyRunwayPx={isLastMessage ? message.replyRunwayPx : undefined}
		/>
	);
}

export const MessageRow = memo(function MessageRow({
	message,
	isLastMessage,
	onForkAssistant,
	forkingMessageId,
	forkDisabled,
	suppressInterruptedError,
}: MessageRowProps) {
	return (
		<div className="contents" data-message-id={message.id}>
			{renderMessageRow({
				message,
				isLastMessage,
				onForkAssistant,
				forkingMessageId,
				forkDisabled,
				suppressInterruptedError,
			})}
		</div>
	);
});

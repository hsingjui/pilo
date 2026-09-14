import { useMemo, useState } from "react";

import type {
	ChatUiState,
	ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatEmptyHero } from "@/components/chat/chat-empty-hero";
import { ChatHistorySkeleton } from "@/components/chat/chat-history-skeleton";
import { SessionHeader } from "@/components/chat/chat-session-header";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import {
	formatTime,
	type ChatSession,
} from "@/components/chat/chat-page-utils";
import { UserMessage } from "@/components/chat/chat-user-message";
import {
	summarizeChatImages,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import { toast } from "sonner";

const EMPTY_CHAT_IMAGES: readonly ChatImageAttachment[] = [];

function LoadingComposer({
	uiStateKey,
	readUiState,
	writeUiState,
}: {
	uiStateKey: string;
	readUiState: (key: string) => ChatUiState;
	writeUiState: (key: string, patch: ChatUiStatePatch) => void;
}) {
	const [draft, setDraft] = useState(() => readUiState(uiStateKey).draft);
	const updateDraft = (value: string) => {
		setDraft(value);
		writeUiState(uiStateKey, { draft: value });
	};
	const deferSubmission = (submission: ChatSubmission) => {
		if (submission.images.length > 0) {
			toast.info("历史消息加载完成后再发送图片");
			return;
		}
		const trimmed = submission.text.trim();
		if (!trimmed) return;
		const current = readUiState(uiStateKey);
		writeUiState(uiStateKey, {
			draft: "",
			deferredSubmissions: [...current.deferredSubmissions, trimmed],
		});
		setDraft("");
	};

	return (
		<div className="relative -mt-4 w-full shrink-0 pb-4">
			<ConversationColumn className="relative">
				<ChatComposer
					value={draft}
					onChange={updateDraft}
					onSubmit={deferSubmission}
				/>
			</ConversationColumn>
		</div>
	);
}

export function ChatPageLoadingFallback({
	session,
	initialMessage,
	initialImages = EMPTY_CHAT_IMAGES,
	uiStateKey,
	readUiState,
	writeUiState,
	reserveWindowControls = false,
	sidebarCollapsed = false,
	onNewTemporaryChat,
	onExpandSidebar,
}: {
	session: ChatSession;
	initialMessage?: string;
	initialImages?: readonly ChatImageAttachment[];
	uiStateKey: string;
	readUiState: (key: string) => ChatUiState;
	writeUiState: (key: string, patch: ChatUiStatePatch) => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
	onNewTemporaryChat?: () => void;
	onExpandSidebar?: () => void;
}) {
	const pendingMessage = useMemo(
		() =>
			initialMessage || initialImages.length > 0
				? {
						id: `${session.id}-initial-fallback`,
						role: "user" as const,
						text: initialMessage ?? "",
						images: summarizeChatImages(initialImages),
						time: formatTime(),
					}
				: null,
		[initialImages, initialMessage, session.id],
	);

	return (
		<div className="flex h-full min-w-0 flex-col bg-background">
			<SessionHeader
				session={session}
				onNewTemporaryChat={onNewTemporaryChat}
				onExpandSidebar={onExpandSidebar}
				reserveWindowControls={reserveWindowControls}
				sidebarCollapsed={sidebarCollapsed}
				overlay={
					Boolean(session.temporary) && !session.sessionPath && !pendingMessage
				}
			/>
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div className="scrollbar-pro flex min-h-0 w-full flex-1 flex-col overflow-hidden">
					{session.sessionPath ? (
						<ChatHistorySkeleton />
					) : pendingMessage ? (
						/* 新会话没有历史可读，直接复用正式消息组件呈现真实首帧。 */
						<div className="pt-4 sm:pt-6">
							<UserMessage message={pendingMessage} recordRender={false} />
						</div>
					) : (
						<ConversationColumn className="flex flex-1 items-center justify-center">
							<ChatEmptyHero />
						</ConversationColumn>
					)}
				</div>
				<LoadingComposer
					uiStateKey={uiStateKey}
					readUiState={readUiState}
					writeUiState={writeUiState}
				/>
			</div>
		</div>
	);
}

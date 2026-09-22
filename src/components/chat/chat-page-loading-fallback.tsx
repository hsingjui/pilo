import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

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
import { useScrollbarGutterWidth } from "@/components/chat/use-scrollbar-gutter";
import {
	summarizeChatImages,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import { toast } from "sonner";

const EMPTY_CHAT_IMAGES: readonly ChatImageAttachment[] = [];

function LoadingComposer({
	projectId,
	uiStateKey,
	readUiState,
	writeUiState,
	scrollbarWidth,
}: {
	projectId: string;
	uiStateKey: string;
	readUiState: (key: string) => ChatUiState;
	writeUiState: (key: string, patch: ChatUiStatePatch) => void;
	scrollbarWidth: number;
}) {
	const { t } = useTranslation();
	const [draft, setDraft] = useState(() => readUiState(uiStateKey).draft);
	const updateDraft = (value: string) => {
		setDraft(value);
		writeUiState(uiStateKey, { draft: value });
	};
	const deferSubmission = (submission: ChatSubmission) => {
		if (submission.images.length > 0) {
			toast.info(t("chat.waitHistory"));
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
		<div
			className="relative z-20 -mt-4 w-full shrink-0 pb-4"
			style={{ paddingRight: scrollbarWidth }}
		>
			<ConversationColumn className="relative">
				<ChatComposer
					value={draft}
					historyKey={projectId}
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
	onOpenTerminal,
	terminalRunning = false,
	terminalVisible = false,
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
	onOpenTerminal?: () => void;
	terminalRunning?: boolean;
	terminalVisible?: boolean;
	onNewTemporaryChat?: () => void;
	onExpandSidebar?: () => void;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	// 滚动区与真实页同样恒定预留 stable gutter，输入区同样补偿，
	// 骨架 → 正文首帧切换才不会横向跳动。
	const scrollbarWidth = useScrollbarGutterWidth(scrollRef);

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
		<div className="@container flex h-full min-w-0 flex-col bg-background">
			<SessionHeader
				session={session}
				onOpenTerminal={onOpenTerminal}
				terminalRunning={terminalRunning}
				terminalVisible={terminalVisible}
				onNewTemporaryChat={onNewTemporaryChat}
				onExpandSidebar={onExpandSidebar}
				reserveWindowControls={reserveWindowControls}
				sidebarCollapsed={sidebarCollapsed}
				overlay={
					Boolean(session.temporary) && !session.sessionPath && !pendingMessage
				}
			/>
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div
					ref={scrollRef}
					className="chat-scrollbar flex min-h-0 w-full flex-1 flex-col overflow-x-hidden overflow-y-auto"
				>
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
					projectId={session.projectRecord.id}
					uiStateKey={uiStateKey}
					readUiState={readUiState}
					writeUiState={writeUiState}
					scrollbarWidth={scrollbarWidth}
				/>
			</div>
		</div>
	);
}

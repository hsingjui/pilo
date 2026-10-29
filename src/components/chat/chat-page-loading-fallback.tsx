import { useMemo, useRef, useState } from "react";
import { ProjectWorkspacePanel } from "@/components/app/project-workspace-panel";
import { useTranslation } from "react-i18next";

import type {
	ChatUiState,
	ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import { ChatComposer } from "@/components/chat/chat-composer";
import { uploadChatFile } from "@/lib/api/files";
import { tauriPiloClient } from "@/lib/api/tauri-pilo-client";
import { usePromptEnhancementSettings } from "@/lib/use-prompt-enhancement-settings";
import { SessionMentionScope } from "@/components/chat/session-mention-context";
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
} from "@/lib/chat/chat-submission";
import { toast } from "sonner";

const EMPTY_CHAT_IMAGES: readonly ChatImageAttachment[] = [];

function LoadingComposer({
	projectId,
	connectionId,
	uiStateKey,
	readUiState,
	writeUiState,
	readProjectDraft,
	writeProjectDraft,
	scrollbarWidth,
}: {
	projectId: string;
	connectionId: string;
	uiStateKey: string;
	readUiState: (key: string) => ChatUiState;
	writeUiState: (key: string, patch: ChatUiStatePatch) => void;
	readProjectDraft: (projectId: string) => string;
	writeProjectDraft: (projectId: string, value: string) => void;
	scrollbarWidth: number;
}) {
	const { t } = useTranslation();
	const promptEnhancement = usePromptEnhancementSettings(
		tauriPiloClient,
		connectionId,
	);
	const [draft, setDraft] = useState(() => readProjectDraft(projectId));
	const updateDraft = (value: string) => {
		setDraft(value);
		writeProjectDraft(projectId, value);
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
			deferredSubmissions: [...current.deferredSubmissions, trimmed],
		});
		writeProjectDraft(projectId, "");
		setDraft("");
	};

	return (
		<div
			data-chat-composer-region=""
			className="relative z-20 -mt-4 w-full shrink-0 pb-4"
			style={{ paddingRight: scrollbarWidth }}
		>
			<ConversationColumn className="relative">
				<ChatComposer
					value={draft}
					canEditScope={false}
					historyKey={projectId}
					attachmentScopeKey={uiStateKey}
					onUploadFile={(file) => uploadChatFile(projectId, file)}
					onEnhancePrompt={
						promptEnhancement.settings?.enabled
							? (draftValue) =>
									tauriPiloClient.enhancePrompt(projectId, draftValue, null)
							: undefined
					}
					enhancePromptDisabled
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
	readProjectDraft,
	writeProjectDraft,
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
	readProjectDraft: (projectId: string) => string;
	writeProjectDraft: (projectId: string, value: string) => void;
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

	const headerOverlay =
		Boolean(session.temporary) && !session.sessionPath && !pendingMessage;
	return (
		<SessionMentionScope connectionId={session.projectRecord.connection.id}>
			<div className="@container relative flex h-full min-w-0 flex-col bg-background">
				<SessionHeader
					project={session.projectRecord}
					session={session}
					onOpenTerminal={onOpenTerminal}
					terminalRunning={terminalRunning}
					terminalVisible={terminalVisible}
					onNewTemporaryChat={onNewTemporaryChat}
					onExpandSidebar={onExpandSidebar}
					reserveWindowControls={reserveWindowControls}
					sidebarCollapsed={sidebarCollapsed}
					overlay={headerOverlay}
				/>
				<ProjectWorkspacePanel
					project={session.projectRecord}
					headerOverlay={headerOverlay}
				>
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
						connectionId={session.projectRecord.connection.id}
						uiStateKey={uiStateKey}
						readUiState={readUiState}
						writeUiState={writeUiState}
						readProjectDraft={readProjectDraft}
						writeProjectDraft={writeProjectDraft}
						scrollbarWidth={scrollbarWidth}
					/>
				</ProjectWorkspacePanel>
			</div>
		</SessionMentionScope>
	);
}

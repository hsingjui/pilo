import { useMemo, useState } from "react";

import type {
	ChatUiState,
	ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatHistorySkeleton } from "@/components/chat/chat-history-skeleton";
import {
	formatTime,
	type ChatSession,
} from "@/components/chat/chat-page-utils";
import { UserMessage } from "@/components/chat/chat-user-message";
import { IS_MACOS, TRAFFIC_LIGHT_GUTTER } from "@/components/title-bar";
import { cn } from "@/lib/utils";
import {
	summarizeChatImages,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@/lib/chat-submission";
import { toast } from "sonner";

const EMPTY_CHAT_IMAGES: readonly ChatImageAttachment[] = [];

function LoadingHeader({
	session,
	reserveWindowControls,
	sidebarCollapsed,
}: {
	session: ChatSession;
	reserveWindowControls: boolean;
	sidebarCollapsed: boolean;
}) {
	return (
		<header
			data-tauri-drag-region="deep"
			className={cn(
				"mt-0.5 flex h-11 shrink-0 items-center bg-background",
				IS_MACOS && sidebarCollapsed && TRAFFIC_LIGHT_GUTTER,
				reserveWindowControls && "pr-[7.75rem]",
			)}
		>
			{sidebarCollapsed ? <div className="w-10 shrink-0" /> : null}
			<div className="flex min-w-0 flex-1 items-center px-1">
				<div className="flex h-8 w-full min-w-0 items-center gap-1.5 px-3 text-[13px] text-foreground">
					<svg
						viewBox="0 0 800 800"
						className="size-3 shrink-0 text-muted-foreground opacity-60"
						aria-hidden="true"
					>
						<path
							className="fill-current"
							fillRule="evenodd"
							d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
						/>
						<path
							className="fill-current"
							d="M517.36 400H634.72V634.72H517.36Z"
						/>
					</svg>
					<span className="truncate">{session.title}</span>
				</div>
			</div>
			<div className="w-10 shrink-0 pr-2" />
		</header>
	);
}

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
		<div className="relative -mt-4 w-full shrink-0 pb-4 pr-2">
			<div className="mx-auto w-full max-w-[46rem] px-3 sm:px-4">
				<ChatComposer
					value={draft}
					onChange={updateDraft}
					onSubmit={deferSubmission}
				/>
			</div>
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
}: {
	session: ChatSession;
	initialMessage?: string;
	initialImages?: readonly ChatImageAttachment[];
	uiStateKey: string;
	readUiState: (key: string) => ChatUiState;
	writeUiState: (key: string, patch: ChatUiStatePatch) => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
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
			<LoadingHeader
				session={session}
				reserveWindowControls={reserveWindowControls}
				sidebarCollapsed={sidebarCollapsed}
			/>
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div className="scrollbar-pro min-h-0 w-full flex-1 overflow-hidden [scrollbar-gutter:stable]">
					{session.sessionPath ? (
						<ChatHistorySkeleton />
					) : pendingMessage ? (
						/* 新会话没有历史可读，直接复用正式消息组件呈现真实首帧。 */
						<div className="pt-4 sm:pt-6">
							<UserMessage message={pendingMessage} recordRender={false} />
						</div>
					) : null}
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

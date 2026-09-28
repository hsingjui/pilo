import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Wifi, WifiOff, X } from "lucide-react";

import { toSidebarSession } from "@/components/app/app-chat-state";
import { runtimeActivityFromStates } from "@/components/app/app-session-index-model";
import { useSessionUnread } from "@/components/app/use-session-unread";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { ChatConversationViewport } from "@/components/chat/chat-conversation-viewport";
import { ChatInterruptedTurnNotice } from "@/components/chat/chat-interrupted-turn-notice";
import { PiExtensionNotifications } from "@/components/chat/pi-extension-notifications";
import { PiExtensionUiDialog } from "@/components/chat/pi-extension-ui-dialog";
import { ChatPendingQueue } from "@/components/chat/chat-pending-queue";
import { ChatRuntimeRecoveryNotice } from "@/components/chat/chat-runtime-recovery-notice";
import { useScrollbarGutterWidth } from "@/components/chat/use-scrollbar-gutter";
import { DraftProjectPicker } from "@/components/chat/draft-project-picker";
import { SessionHeader } from "@/components/chat/chat-session-header";
import {
	ChatImageLightbox,
	ChatImageScopeProvider,
} from "@/components/chat/chat-image-viewer";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { connectionLabel } from "@/lib/projects";
import type { PiloClientEventMessage } from "@/lib/pilo-client";
import { Spinner, TooltipProvider } from "@/ui";
import { useMediaQuery } from "./remote-app-model";
import { RemoteMobileNavigation } from "./remote-mobile-navigation";
import { useRemoteKeyboardInset } from "./use-remote-keyboard-inset";
import { useRemoteChat } from "./use-remote-chat";
import { useRemoteConnection } from "./use-remote-connection";
import { useRemoteSessions } from "./use-remote-sessions";

export function RemoteApp() {
	const { t } = useTranslation();
	const pairingSecret = useMemo(
		() => new URLSearchParams(window.location.search).get("pair"),
		[],
	);
	const socketHandlerRef = useRef<(message: PiloClientEventMessage) => void>(
		() => {},
	);
	const reconnectProbeRef = useRef<() => void>(() => {});

	const connection = useRemoteConnection({
		pairingSecret,
		onSocketMessageRef: socketHandlerRef,
		onReconnectProbeRef: reconnectProbeRef,
	});
	const sessions = useRemoteSessions({
		client: connection.client,
		handleExpiredAuth: connection.handleExpiredAuth,
		setFatalError: connection.setFatalError,
		resyncKey: connection.resyncKey,
	});

	const isNarrow = useMediaQuery("(max-width: 1023px)");
	useRemoteKeyboardInset();
	// 触屏没有 hover，消息上 hover-only 的复制/时间戳会永久不可见。
	// 用 JS 判断而不是 CSS media query：与 chat-composer-run-config.tsx 的
	// useIsTouchDevice() 同源，且 CSS 媒体查询无法在预览/测试环境里探测。
	const isTouch = useMediaQuery("(hover: none) and (pointer: coarse)");
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
	const [sidebarRefreshing, setSidebarRefreshing] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	// "chat-scrollbar" 预留 stable gutter，输入框不在滚动容器内，需补等宽内边距
	// 才能与消息列左右对齐（手机 overlay 滚动条为 0，仅在桌面浏览器可见）。
	const scrollbarWidth = useScrollbarGutterWidth(scrollRef, true);
	const closeMobileNavigation = useCallback(
		() => setMobileNavigationOpen(false),
		[],
	);

	const chat = useRemoteChat({
		client: connection.client,
		handleExpiredAuth: connection.handleExpiredAuth,
		setFatalError: connection.setFatalError,
		resyncKey: connection.resyncKey,
		setResyncKey: connection.setResyncKey,
		projects: sessions.projects,
		rawSessions: sessions.rawSessions,
		chatSessions: sessions.chatSessions,
		refreshProjectSessions: sessions.refreshProjectSessions,
		refreshAllSessions: sessions.refreshAllSessions,
		scheduleRuntimeActivityRefresh: sessions.scheduleRuntimeActivityRefresh,
		isExternalOpenTurn: sessions.isExternalOpenTurn,
		isNarrow,
		closeMobileNavigation,
	});

	useEffect(() => {
		socketHandlerRef.current = chat.handleSocketMessage;
	}, [chat.handleSocketMessage]);
	useEffect(() => {
		reconnectProbeRef.current = sessions.reloadBootstrap;
	}, [sessions.reloadBootstrap]);

	const {
		projects,
		chatSessions,
		rawSessions,
		externalActivity,
		refreshingProjectIds,
		reloadBootstrap,
		refreshProjectSessions,
		refreshAllSessions,
	} = sessions;
	// 刷新侧栏：拉取 bootstrap 与会话索引。远程端没有桌面版的事件驱动目录，
	// 靠一个 loading 状态给刷新按钮反馈，避免“点了没反应”。
	const handleRefreshSidebar = async () => {
		setSidebarRefreshing(true);
		try {
			await Promise.allSettled([reloadBootstrap(), refreshAllSessions()]);
		} finally {
			setSidebarRefreshing(false);
		}
	};
	const {
		connected,
		recoveryState,
		reconnectNow,
		fatalError,
		setFatalError,
		token,
		pairing,
	} = connection;

	const envs = useMemo(() => {
		const byId = new Map<string, { id: string; name: string }>();
		for (const project of projects) {
			byId.set(project.connection.id, {
				id: project.connection.id,
				name: connectionLabel(project.connection),
			});
		}
		const list = [...byId.values()];
		list.sort((a, b) => (a.id === "local" ? -1 : b.id === "local" ? 1 : 0));
		return list;
	}, [projects]);

	const sidebarProjects = useMemo(
		() =>
			projects.map((project) => ({
				id: project.id,
				name: project.name,
				path: project.metadata.cwd,
				envId: project.connection.id,
				connectionType: project.connection.kind.type,
			})),
		[projects],
	);

	const runtimeActivity = useMemo(
		() => runtimeActivityFromStates(chatSessions),
		[chatSessions],
	);

	const sessionsWithActivity = useMemo(
		() =>
			rawSessions.map((session) => {
				const sidebar = toSidebarSession(session);
				const externalActive =
					externalActivity
						.get(session.projectId)
						?.openTurnPaths.has(session.sessionPath) ?? false;
				const runtimeActive =
					runtimeActivity.get(session.projectId)?.has(session.sessionPath) ??
					false;
				return externalActive || runtimeActive
					? { ...sidebar, active: true }
					: sidebar;
			}),
		[rawSessions, runtimeActivity, externalActivity],
	);

	const unreadSessionIds = useSessionUnread(
		sessionsWithActivity,
		chat.identifiedSessionId ?? null,
	);

	const sidebarSessions = useMemo(
		() =>
			unreadSessionIds.size === 0
				? sessionsWithActivity
				: sessionsWithActivity.map((session) =>
						unreadSessionIds.has(session.id)
							? { ...session, unread: true }
							: session,
					),
		[sessionsWithActivity, unreadSessionIds],
	);

	// 移动端侧栏长按删除：删除后从本地索引移除，避免整个侧栏重刷。
	const { client, handleExpiredAuth } = connection;
	const { setRawSessions } = sessions;
	const { startDraft, selectedSessionPath } = chat;
	const handleDeleteMobileSession = useCallback(
		(sessionId: string) => {
			const session = sidebarSessions.find((item) => item.id === sessionId);
			if (!session || !client) return;
			void client
				.deleteSession(session.projectId, session.sessionPath)
				.then(() => {
					setRawSessions((current) =>
						current.filter((item) => item.sessionPath !== session.sessionPath),
					);
					if (selectedSessionPath === session.sessionPath) {
						startDraft(session.projectId);
					}
				})
				.catch((error) => {
					if (!handleExpiredAuth(error)) {
						console.debug("Failed to delete remote session", error);
					}
				});
		},
		[
			client,
			handleExpiredAuth,
			selectedSessionPath,
			setRawSessions,
			sidebarSessions,
			startDraft,
		],
	);

	if (pairing) {
		return (
			<div className="flex min-h-[var(--remote-viewport-height,100dvh)] items-center justify-center bg-background p-6">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Spinner className="size-4" /> {t("settings.remoteConnecting")}
				</div>
			</div>
		);
	}

	if (!token) {
		return (
			<div className="flex min-h-[var(--remote-viewport-height,100dvh)] items-center justify-center bg-background p-6">
				<div className="w-full max-w-sm rounded-2xl border bg-card p-6 text-center shadow-sm">
					<WifiOff className="mx-auto size-6 text-muted-foreground" />
					<h1 className="mt-4 text-base font-semibold">Pilo Remote</h1>
					<p className="mt-2 text-sm leading-6 text-muted-foreground">
						{fatalError || t("settings.remotePairRequired")}
					</p>
				</div>
			</div>
		);
	}

	const active = chat.conversation.active !== null;
	const pendingFollowUps = chat.conversation.pendingUsers.filter(
		(user) => user.queueKind === "follow_up",
	).length;

	const sidebarNode = (
		<AppSidebar
			collapsed={sidebarCollapsed}
			onCollapse={() => setSidebarCollapsed(true)}
			envs={envs}
			projects={sidebarProjects}
			sessions={sidebarSessions}
			selectedProjectId={chat.activeProjectId || null}
			selectedSessionId={chat.identifiedSessionId ?? null}
			onSelectSession={chat.handleSelectSession}
			onNewChat={() => chat.startDraft(chat.activeProjectId || undefined)}
			onNewChatInProject={(projectId) => chat.startDraft(projectId)}
			onRefreshProjectSessions={(projectId) =>
				void refreshProjectSessions(projectId, true)
			}
			onRefresh={handleRefreshSidebar}
			refreshing={sidebarRefreshing}
			refreshingProjectIds={refreshingProjectIds}
			footer={
				<div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
					{connected ? (
						<Wifi className="size-3 shrink-0" />
					) : (
						<WifiOff className="size-3 shrink-0" />
					)}
					<span className="truncate">
						{connected
							? t("settings.remoteConnected")
							: t("settings.remoteReconnecting")}
					</span>
					<button
						type="button"
						aria-label="Reload"
						className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground"
						onClick={() => void reloadBootstrap()}
					>
						<RefreshCw className="size-3.5" />
					</button>
				</div>
			}
		/>
	);

	return (
		<TooltipProvider>
			<div
				data-remote-webui=""
				data-touch-reveal={isTouch ? "" : undefined}
				className="flex h-[var(--remote-viewport-height,100dvh)] overflow-hidden bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-foreground"
			>
				{isNarrow ? (
					<RemoteMobileNavigation
						client={connection.client}
						open={mobileNavigationOpen}
						onOpenChange={setMobileNavigationOpen}
						onDeleteSession={handleDeleteMobileSession}
						envs={envs}
						projects={sidebarProjects}
						sessions={sidebarSessions}
						activeProjectId={chat.activeProjectId || null}
						selectedSessionId={chat.identifiedSessionId ?? null}
						connected={connected}
						refreshingProjectIds={refreshingProjectIds}
						onSelectSession={chat.handleSelectSession}
						onNewChat={(projectId) =>
							chat.startDraft(projectId ?? chat.activeProjectId ?? undefined)
						}
						onRefreshProjectSessions={(projectId) =>
							void refreshProjectSessions(projectId, true)
						}
						onRefresh={handleRefreshSidebar}
						refreshing={sidebarRefreshing}
						onReload={() => void reloadBootstrap()}
					/>
				) : (
					sidebarNode
				)}
				<main className="@container relative flex min-w-0 flex-1 flex-col bg-background">
					<SessionHeader
						session={chat.headerSession ?? undefined}
						sessionState={chat.chatState ?? undefined}
						onNewChat={
							isNarrow
								? () => chat.startDraft(chat.activeProjectId || undefined)
								: undefined
						}
						onNewTemporaryChat={
							isNarrow
								? () =>
										chat.toggleTemporaryChat(chat.activeProjectId || undefined)
								: undefined
						}
						onExpandSidebar={() => {
							if (isNarrow) setMobileNavigationOpen(true);
							else setSidebarCollapsed(false);
						}}
						sidebarCollapsed={isNarrow ? true : sidebarCollapsed}
						overlay={chat.conversation.messages.length === 0}
					/>

					<div className="relative flex min-h-0 flex-1 flex-col">
						<ChatImageScopeProvider scope={chat.historyImageScope}>
							<ChatConversationViewport
								key={chat.routeKey ?? "remote-draft"}
								active
								visualLive
								showSwitchSkeleton={chat.showSwitchSkeleton}
								sessionId={chat.activeSessionKey ?? "remote-draft"}
								sessionPath={chat.headerSession?.sessionPath}
								messages={chat.visibleMessages}
								onVisibleRangeChange={chat.requestHistoryRange}
								activeAssistantMessageId={chat.activeAssistantMessageId}
								compacting={chat.compacting}
								effectiveLoadState={
									chat.loadingConversation ? "loading" : "ready"
								}
								initialScrollTop={chat.initialScrollState.scrollTop}
								initialSticky={chat.initialScrollState.sticky}
								initialVirtualizerCache={
									chat.initialUiState.virtualizerMessageCount ===
									chat.visibleMessages.length
										? chat.initialUiState.virtualizerCache
										: undefined
								}
								onScrollStateChange={chat.persistScrollState}
								onVirtualizerCacheChange={chat.persistVirtualizerCache}
								runtimeScrollRef={scrollRef}
								suppressInterruptedError={active || chat.readOnly}
								onVisualReady={chat.handleVisualReady}
								onRetryHistory={chat.retryHistory}
								onForkAssistant={
									chat.selectedSession ? chat.handleForkAssistant : undefined
								}
								forkingMessageId={chat.forkingMessageId}
								forkDisabled={chat.forkDisabled}
							/>
						</ChatImageScopeProvider>
						<div
							className="relative z-20 -mt-4 w-full shrink-0 pb-[max(1rem,env(safe-area-inset-bottom))]"
							style={{ paddingRight: scrollbarWidth }}
						>
							<ConversationColumn className="relative">
								<ChatPendingQueue
									items={chat.conversation.pendingUsers}
									onEdit={(item) =>
										void chat.handleEditQueued(item.clientMessageId)
									}
									onSendNow={(item) =>
										void chat.handleSendQueuedNow(item.clientMessageId)
									}
								/>
								{recoveryState.status === "idle" &&
								!chat.readOnly &&
								!active &&
								chat.latestTurnInterrupted ? (
									<ChatInterruptedTurnNotice />
								) : null}
								<ChatRuntimeRecoveryNotice
									state={recoveryState}
									onReconnect={reconnectNow}
								/>
								<PiExtensionNotifications
									notifications={chat.extensionNotifications}
									onDismiss={chat.dismissExtensionNotification}
								/>
								{!chat.hasIdentifiedSession ? (
									<DraftProjectPicker
										projects={projects}
										project={chat.activeProject}
										onSwitchProject={chat.switchDraftProject}
									/>
								) : null}
								{chat.extensionDialog ? (
									<PiExtensionUiDialog
										request={chat.extensionDialog}
										onRespond={(response) =>
											void chat.respondToExtensionDialog(response)
										}
									/>
								) : null}
								<ChatComposer
									value={chat.readOnly ? "" : chat.composer}
									onChange={chat.handleComposerChange}
									muted={chat.readOnly}
									placeholder={
										chat.readOnly ? t("chat.externalReadOnly") : undefined
									}
									desktopShortcuts={false}
									historyKey={chat.activeProjectId || null}
									suggestions={chat.composerSuggestions}
									onSuggestionTrigger={chat.handleSuggestionTrigger}
									images={chat.images}
									onImagesChange={chat.setImages}
									onSubmit={(submission) =>
										void chat.sendSubmission(submission, "prompt")
									}
									onSteer={
										active
											? (submission) =>
													void chat.sendSubmission(submission, "steer")
											: undefined
									}
									onFollowUp={
										active
											? (submission) =>
													void chat.sendSubmission(submission, "follow_up")
											: undefined
									}
									disabled={
										chat.readOnly ||
										chat.sending ||
										!chat.activeProjectId ||
										(chat.hasIdentifiedSession && !chat.runtimeReady)
									}
									running={active && !chat.readOnly}
									onStop={chat.readOnly ? undefined : () => void chat.stop()}
									pendingFollowUps={pendingFollowUps}
									statusText={chat.composerStatusText}
									compacting={chat.compacting}
									retrying={chat.retryState?.kind === "agent"}
									onAbortRetry={() => void chat.abortPiRetry()}
									contextUsage={chat.chatState}
									models={chat.models}
									selectedModel={chat.selectedModel}
									modelLoading={chat.modelLoading}
									modelError={fatalError}
									modelDisabled={
										chat.hasIdentifiedSession
											? !chat.runtimeReady
											: !chat.activeProjectId
									}
									onModelMenuOpen={() => {
										if (chat.hasIdentifiedSession)
											void chat.refreshAgentConfig();
										else if (chat.activeProjectId)
											void chat.loadDraftCatalog(chat.activeProjectId);
									}}
									onModelRefresh={() => {
										if (chat.hasIdentifiedSession)
											void chat.refreshAgentConfig();
										else if (chat.activeProjectId)
											void chat.loadDraftCatalog(chat.activeProjectId);
									}}
									onModelChange={(model) => {
										if (model) void chat.changeModel(model);
									}}
									thinkingLevels={chat.composerThinkingLevels}
									selectedThinkingLevel={chat.composerSelectedThinkingLevel}
									thinkingDisabled={
										chat.hasIdentifiedSession
											? !chat.runtimeReady || chat.thinkingLevels.length === 0
											: !chat.activeProjectId ||
												chat.composerThinkingLevels.length === 0
									}
									onThinkingMenuOpen={() => {
										if (chat.hasIdentifiedSession)
											void chat.refreshAgentConfig();
										else if (chat.activeProjectId)
											void chat.loadDraftCatalog(chat.activeProjectId);
									}}
									onThinkingChange={(level) => {
										if (level) void chat.changeThinking(level);
									}}
								/>
							</ConversationColumn>
						</div>
					</div>
				</main>

				<ChatImageLightbox />

				{fatalError ? (
					<div className="fixed inset-x-3 bottom-24 z-50 mx-auto max-w-lg rounded-xl border border-destructive/30 bg-background px-3 py-2 text-xs shadow-lg">
						<div className="flex items-start gap-2">
							<p className="min-w-0 flex-1 text-destructive">{fatalError}</p>
							<button type="button" onClick={() => setFatalError(null)}>
								<X className="size-3.5" />
							</button>
						</div>
					</div>
				) : null}
			</div>
		</TooltipProvider>
	);
}

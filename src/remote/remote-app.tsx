import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	ProjectWorkspaceContext,
	useProjectWorkspaces,
} from "@/components/app/project-workspace-context";
import { ProjectWorkspacePanel } from "@/components/app/project-workspace-panel";
import { useTranslation } from "react-i18next";
import { Wifi, WifiOff, X } from "lucide-react";
import { toast } from "sonner";

import {
	chatUiStateKey,
	toSidebarSession,
} from "@/components/app/app-chat-state";
import { runtimeActivityFromStates } from "@/components/app/app-session-index-model";
import { useSyncedSessionUnread } from "@/components/app/use-synced-session-unread";
import { CacheKeepAliveNotice } from "@/components/chat/cache-keep-alive-notice";
import { useCacheKeepAliveStatus } from "@/lib/use-cache-keep-alive-status";
import { useNextPrompt } from "@/components/chat/use-next-prompt";
import {
	SessionMentionProvider,
	SessionMentionScope,
} from "@/components/chat/session-mention-context";
import { ChatComposer } from "@/components/chat/chat-composer";
import { promptEnhancementModel } from "@/lib/prompt-enhancement";
import { usePromptEnhancementSettings } from "@/lib/use-prompt-enhancement-settings";
import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { RemoteConversationViewport } from "./remote-conversation-viewport";
import { ChatInterruptedTurnNotice } from "@/components/chat/chat-interrupted-turn-notice";
import { PiExtensionNotifications } from "@/components/chat/pi-extension-notifications";
import { PiExtensionUiDialog } from "@/components/chat/pi-extension-ui-dialog";
import { ChatPendingQueue } from "@/components/chat/chat-pending-queue";
import { ChatTodoCapsule } from "@/components/chat/chat-todo-capsule";
import { useScrollbarGutterWidth } from "@/components/chat/use-scrollbar-gutter";
import { DraftProjectPicker } from "@/components/chat/draft-project-picker";
import { BootShellRemover } from "@/components/boot-shell-remover";
import { SessionHeader } from "@/components/chat/chat-session-header";
import {
	ChatImageLightbox,
	ChatImageScopeProvider,
} from "@/components/chat/chat-image-viewer";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { ChatMarkdownImageScopeProvider } from "@/components/chat/chat-markdown-image";
import { connectionLabel } from "@/lib/api/projects";
import type { PiloClientEventMessage } from "@/lib/api/pilo-client";
import { TooltipProvider } from "@/ui";
import { RemotePairingPage } from "./remote-pairing-page";
import { isRemotePairingLocation } from "./remote-pairing-model";
import { useMediaQuery } from "./remote-app-model";
import { remoteConnectionLabelKey } from "./remote-connection-state";
import { RemoteConnectionNotice } from "./remote-connection-notice";
import { RemoteMobileNavigation } from "./remote-mobile-navigation";
import { useRemoteKeyboardInset } from "./use-remote-keyboard-inset";
import { useRemoteChat } from "./use-remote-chat";
import { useRemoteConnection } from "./use-remote-connection";
import { useRemoteNetworkLifecycle } from "./use-remote-network-lifecycle";
import { useRemotePwa } from "./use-remote-pwa";
import { useRemoteSessions } from "./use-remote-sessions";
import { useRemotePreferences } from "./use-remote-preferences";
import { useRemoteTheme } from "./use-remote-theme";

export function RemoteApp() {
	return isRemotePairingLocation() ? (
		<>
			<BootShellRemover />
			<RemotePairingPage />
		</>
	) : (
		<RemoteWorkspace />
	);
}

function RemoteWorkspace() {
	const { t } = useTranslation();
	const socketHandlerRef = useRef<(message: PiloClientEventMessage) => void>(
		() => {},
	);
	const reconnectProbeRef = useRef<() => void>(() => {});
	const { browserOnline, recoveryGeneration } = useRemoteNetworkLifecycle();
	const { updateAvailable, applyUpdate } = useRemotePwa();

	const connection = useRemoteConnection({
		browserOnline,
		recoveryGeneration,
		onSocketMessageRef: socketHandlerRef,
		onReconnectProbeRef: reconnectProbeRef,
	});
	const handlePreferencesEvent = useRemotePreferences({
		client: connection.client,
		refreshKey: `${connection.resyncKey}:${connection.snapshotRefreshKey}`,
		onError: connection.handleExpiredAuth,
	});
	const { handleThemeEvent } = useRemoteTheme({
		client: connection.client,
		refreshKey: `${connection.resyncKey}:${connection.snapshotRefreshKey}`,
		onError: connection.handleExpiredAuth,
	});
	const sessions = useRemoteSessions({
		client: connection.client,
		browserOnline,
		handleExpiredAuth: connection.handleExpiredAuth,
		setFatalError: connection.setFatalError,
		resyncKey: connection.resyncKey,
		snapshotRefreshKey: connection.snapshotRefreshKey,
	});

	const workspaceProjectIds = useMemo(
		() => sessions.projects.map((project) => project.id),
		[sessions.projects],
	);
	const workspaces = useProjectWorkspaces(workspaceProjectIds);
	const isNarrow = useMediaQuery("(max-width: 1023px)");
	useRemoteKeyboardInset();
	// 触屏没有 hover，消息上 hover-only 的复制/时间戳会永久不可见。
	// 用 JS 判断而不是 CSS media query：与 chat-composer-run-config.tsx 的
	// useIsTouchDevice() 同源，且 CSS 媒体查询无法在预览/测试环境里探测。
	const isTouch = useMediaQuery("(hover: none) and (pointer: coarse)");
	const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
	const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	// Wide layouts compensate for the message scrollbar gutter; narrow layouts
	// keep the composer side spacing symmetric.
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
		snapshotRefreshKey: connection.snapshotRefreshKey,
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
		reconnectProbeRef.current = sessions.reloadBootstrap;
	}, [sessions.reloadBootstrap]);

	const {
		projects,
		chatSessions,
		rawSessions,
		externalActivity,
		refreshingProjectIds,
		refreshProjectSessions,
		reloadBootstrap,
	} = sessions;
	const {
		networkState,
		recoveryState,
		reconnectNow,
		fatalError,
		setFatalError,
		token,
	} = connection;
	const visibleError = fatalError ?? sessions.refreshError;
	// 草稿优化按当前项目所属 Connection 的 Host 设置开关；默认关闭。
	const promptEnhancement = usePromptEnhancementSettings(
		connection.client,
		chat.activeProject?.connection.id ?? "",
		`${connection.resyncKey}:${connection.snapshotRefreshKey}`,
	);
	// 草稿优化回调在等待期间读取，不能依赖属性窄化，先落成常量。
	const enhanceProjectId = chat.activeProjectId ?? "";
	const active = chat.conversationUi.active;
	const updateBlocked =
		active || chat.sending || chat.compacting || chat.retryState !== null;

	useEffect(() => {
		if (!token || updateBlocked || !updateAvailable) return;
		const toastId = toast.info(t("settings.remoteUpdateAvailable"), {
			description: t("settings.remoteUpdateDescription"),
			duration: Infinity,
			position: isNarrow ? "bottom-center" : "bottom-left",
			action: {
				label: t("settings.remoteUpdateAction"),
				onClick: () => void applyUpdate(),
			},
		});
		return () => {
			toast.dismiss(toastId);
		};
	}, [applyUpdate, isNarrow, t, token, updateAvailable, updateBlocked]);

	const envs = useMemo(() => {
		const byId = new Map<string, { id: string; name: string }>();
		for (const project of projects) {
			if (!project.connection.shownInHome) continue;
			byId.set(project.connection.id, {
				id: project.connection.id,
				name: connectionLabel(project.connection),
			});
		}
		const list = [...byId.values()];
		list.sort((a, b) => (a.id === "local" ? -1 : b.id === "local" ? 1 : 0));
		return list;
	}, [projects]);

	// 与桌面端一致：输入框上方的项目切换只列出首页可见连接下的项目。
	const homeProjects = useMemo(() => {
		const visible = new Set(envs.map((env) => env.id));
		return projects.filter((project) => visible.has(project.connection.id));
	}, [envs, projects]);

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

	const { unread: unreadSessionIds, handleReadEvent } = useSyncedSessionUnread(
		sessionsWithActivity,
		chat.identifiedSessionId
			? chatUiStateKey(chat.activeProjectId, chat.identifiedSessionId)
			: null,
		chatSessions,
		{
			client: connection.client,
			refreshKey: `${connection.resyncKey}:${connection.snapshotRefreshKey}`,
			onError: connection.handleExpiredAuth,
		},
	);

	const {
		status: cacheKeepAliveStatus,
		handleMessage: handleCacheKeepAliveMessage,
	} = useCacheKeepAliveStatus({
		client: connection.client,
		sessionKey: chat.activeSessionKey,
		refreshKey: `${connection.resyncKey}:${connection.snapshotRefreshKey}`,
	});
	const nextPrompt = useNextPrompt({
		client: connection.client,
		connectionId: chat.activeProject?.connection.id ?? "",
		sessionKey: chat.activeSessionKey,
		sessionId: chat.identifiedSessionId ?? null,
		draft: chat.composer,
		hasAttachments: chat.images.length > 0,
		active: networkState === "connected",
		connected: networkState === "connected",
		loading: !chat.historyReady,
		busy: active || chat.sending || chat.compacting || Boolean(chat.retryState),
		blocked: chat.readOnly || Boolean(chat.extensionDialog),
		model: chat.selectedModel,
		getSessionState: chat.readSessionState,
		refreshKey: `${connection.resyncKey}:${connection.snapshotRefreshKey}`,
	});
	const { handleSocketMessage } = chat;
	const { handleMessage: handleNextPromptMessage } = nextPrompt;
	const { handleEvent: handlePromptEnhancementEvent } = promptEnhancement;
	useEffect(() => {
		socketHandlerRef.current = (message) => {
			if (message.type === "events") {
				for (const event of message.events) {
					handleThemeEvent(event);
					handlePreferencesEvent(event);
					if (event.type === "configuration_changed") void reloadBootstrap();
					handleReadEvent(event);
					handlePromptEnhancementEvent(event);
				}
			}
			handleCacheKeepAliveMessage(message);
			handleNextPromptMessage(message);
			handleSocketMessage(message);
		};
	}, [
		handleSocketMessage,
		handleReadEvent,
		handleThemeEvent,
		handlePreferencesEvent,
		reloadBootstrap,
		handleNextPromptMessage,
		handleCacheKeepAliveMessage,
		handlePromptEnhancementEvent,
	]);

	const sidebarSessions = useMemo(
		() =>
			unreadSessionIds.size === 0
				? sessionsWithActivity
				: sessionsWithActivity.map((session) =>
						unreadSessionIds.has(chatUiStateKey(session.projectId, session.id))
							? { ...session, unread: true }
							: session,
					),
		[sessionsWithActivity, unreadSessionIds],
	);

	// 移动端侧栏长按删除：删除后从本地索引移除，避免整个侧栏重刷。
	const { client, handleExpiredAuth } = connection;
	const { removeIndexedSession } = sessions;
	const handleDeleteMobileSession = useCallback(
		(sessionId: string, projectId: string) => {
			const session = sidebarSessions.find(
				(item) => item.projectId === projectId && item.id === sessionId,
			);
			if (!session || !client) return;
			void client
				.deleteSession(session.projectId, session.sessionPath)
				.then(() => {
					removeIndexedSession(projectId, session.sessionPath);
				})
				.catch((error) => {
					if (!handleExpiredAuth(error)) {
						console.debug("Failed to delete remote session", error);
					}
				});
		},
		[client, handleExpiredAuth, removeIndexedSession, sidebarSessions],
	);

	if (!token) {
		return (
			<div className="flex min-h-[var(--remote-viewport-height,100dvh)] items-center justify-center bg-background p-6">
				<BootShellRemover />
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

	const pendingFollowUps = chat.conversationUi.pendingUsers.filter(
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
			onRefreshSession={chat.refreshSession}
			onNewChat={() => chat.startDraft(chat.activeProjectId || undefined)}
			onNewChatInProject={(projectId) => chat.startDraft(projectId)}
			onRefreshProjectSessions={(projectId) =>
				void refreshProjectSessions(projectId, true)
			}
			refreshingProjectIds={refreshingProjectIds}
			footer={
				<div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
					{networkState === "connected" ? (
						<Wifi className="size-3 shrink-0" />
					) : (
						<WifiOff className="size-3 shrink-0" />
					)}
					<span className="min-w-0 flex-1 truncate">
						{t(remoteConnectionLabelKey(networkState))}
					</span>
				</div>
			}
		/>
	);

	return (
		<ProjectWorkspaceContext.Provider value={workspaces}>
			<TooltipProvider>
				<BootShellRemover
					ready={
						sessions.bootstrapSettled || !browserOnline || Boolean(fatalError)
					}
				/>
				<SessionMentionProvider projects={projects} sessions={sidebarSessions}>
					<SessionMentionScope
						connectionId={chat.activeProject?.connection.id ?? ""}
					>
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
									onRefreshSession={chat.refreshSession}
									envs={envs}
									projects={sidebarProjects}
									sessions={sidebarSessions}
									activeProjectId={chat.activeProjectId || null}
									selectedSessionId={chat.identifiedSessionId ?? null}
									connectionState={networkState}
									refreshingProjectIds={refreshingProjectIds}
									onSelectSession={chat.handleSelectSession}
									onNewChat={(projectId) =>
										chat.startDraft(
											projectId ?? chat.activeProjectId ?? undefined,
										)
									}
									onRefreshProjectSessions={(projectId) =>
										void refreshProjectSessions(projectId, true)
									}
								/>
							) : (
								sidebarNode
							)}
							<main className="@container relative flex min-w-0 flex-1 flex-col bg-background">
								<SessionHeader
									project={chat.activeProject}
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
													chat.toggleTemporaryChat(
														chat.activeProjectId || undefined,
													)
											: undefined
									}
									onExpandSidebar={() => {
										if (isNarrow) setMobileNavigationOpen(true);
										else setSidebarCollapsed(false);
									}}
									sidebarCollapsed={isNarrow ? true : sidebarCollapsed}
									overlay={chat.conversationUi.messageCount === 0}
								/>

								<ProjectWorkspacePanel
									project={chat.activeProject}
									readImage={chat.projectImageScope?.readImage}
									headerOverlay={chat.conversationUi.messageCount === 0}
								>
									<ChatMarkdownImageScopeProvider
										scope={chat.projectImageScope}
									>
										<ChatImageScopeProvider scope={chat.historyImageScope}>
											<RemoteConversationViewport
												key={chat.routeKey ?? "remote-draft"}
												active
												visualLive
												showSwitchSkeleton={chat.showSwitchSkeleton}
												sessionId={chat.activeSessionKey ?? "remote-draft"}
												sessionPath={chat.headerSession?.sessionPath}
												conversationStore={chat.conversationStore}
												historyPrefix={chat.historyPrefix}
												onVisibleRangeChange={chat.requestHistoryRange}
												compacting={chat.compacting}
												effectiveLoadState={
													chat.loadingConversation ? "loading" : "ready"
												}
												initialScrollTop={chat.initialScrollState.scrollTop}
												initialSticky={chat.initialScrollState.sticky}
												initialVirtualizerCache={
													chat.initialUiState.virtualizerCache
												}
												initialVirtualizerMessageCount={
													chat.initialUiState.virtualizerMessageCount
												}
												onScrollStateChange={chat.persistScrollState}
												onVirtualizerCacheChange={chat.persistVirtualizerCache}
												runtimeScrollRef={scrollRef}
												suppressInterruptedError={active || chat.readOnly}
												onVisualReady={chat.handleVisualReady}
												onRetryHistory={chat.retryHistory}
												onForkAssistant={
													chat.selectedSession
														? chat.handleForkAssistant
														: undefined
												}
												forkingMessageId={chat.forkingMessageId}
												forkDisabled={chat.forkDisabled}
											/>
										</ChatImageScopeProvider>
									</ChatMarkdownImageScopeProvider>
									<div
										data-chat-composer-region=""
										className="relative z-20 -mt-4 w-full shrink-0 pb-[var(--remote-composer-bottom-padding,max(1rem,env(safe-area-inset-bottom)))]"
										style={{ paddingRight: isNarrow ? 0 : scrollbarWidth }}
									>
										<ConversationColumn className="relative">
											<ChatPendingQueue
												items={chat.conversationUi.pendingUsers}
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
											<RemoteConnectionNotice
												connectionState={networkState}
												recoveryState={recoveryState}
												onReconnect={reconnectNow}
											/>
											<PiExtensionNotifications
												notifications={chat.extensionNotifications}
												onDismiss={chat.dismissExtensionNotification}
											/>
											{!chat.hasIdentifiedSession ? (
												<DraftProjectPicker
													projects={homeProjects}
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
											<CacheKeepAliveNotice
												key={`cache-keep-alive:${chat.activeSessionKey}`}
												status={cacheKeepAliveStatus}
											/>
											<ChatTodoCapsule
												key={`chat-todo:${chat.activeSessionKey}`}
												conversationStore={chat.conversationStore}
												historyMessages={chat.historyPrefix}
												running={active && !chat.readOnly}
											/>
											<ChatComposer
												nextPrompt={nextPrompt.text}
												onNextPromptDismiss={nextPrompt.dismiss}
												value={chat.readOnly ? "" : chat.composer}
												onChange={chat.handleComposerChange}
												muted={chat.readOnly}
												placeholder={
													chat.sessionHeaderMissing
														? t("chat.sessionHeaderMissing")
														: chat.readOnly
															? t("chat.externalReadOnly")
															: undefined
												}
												desktopShortcuts={false}
												historyKey={chat.activeProjectId || null}
												attachmentScopeKey={chat.activeSessionKey}
												onUploadFile={
													client && chat.activeProjectId
														? async (file) => {
																try {
																	return await client.uploadChatFile(
																		chat.activeProjectId,
																		file,
																	);
																} catch (error) {
																	handleExpiredAuth(error);
																	throw error;
																}
															}
														: undefined
												}
												onEnhancePrompt={
													client &&
													enhanceProjectId &&
													promptEnhancement.settings?.enabled
														? async (draftValue) => {
																try {
																	return await client.enhancePrompt(
																		enhanceProjectId,
																		draftValue,
																		promptEnhancementModel(chat.selectedModel),
																	);
																} catch (error) {
																	handleExpiredAuth(error);
																	throw error;
																}
															}
														: undefined
												}
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
												onSendNow={active ? chat.handleSendNow : undefined}
												onFollowUp={
													active
														? (submission) =>
																void chat.sendSubmission(
																	submission,
																	"follow_up",
																)
														: undefined
												}
												disabled={
													chat.readOnly ||
													chat.sending ||
													chat.draftConfigPending ||
													!chat.activeProjectId ||
													!chat.historyReady
												}
												running={active && !chat.readOnly}
												onStop={
													chat.readOnly ? undefined : () => void chat.stop()
												}
												pendingFollowUps={pendingFollowUps}
												statusText={chat.composerStatusText}
												statusError={
													(chat.sessionHeaderMissing
														? t("chat.sessionHeaderMissing")
														: null) ??
													chat.retryState?.errorMessage ??
													chat.draftConfigError ??
													(chat.historyIndexStale
														? t("chat.historyIndexStale")
														: null)
												}
												compacting={chat.compacting}
												retrying={chat.retryState?.kind === "agent"}
												onAbortRetry={() => void chat.abortPiRetry()}
												contextUsage={chat.chatState}
												models={chat.models}
												modelScope={chat.modelScope}
												canEditScope={!isNarrow}
												selectedModel={chat.selectedModel}
												modelLoading={chat.modelLoading}
												modelError={chat.modelError ?? fatalError}
												modelDisabled={
													chat.readOnly ||
													!chat.historyReady ||
													!chat.activeProjectId
												}
												onModelMenuOpen={() => {
													if (chat.hasIdentifiedSession)
														void chat.refreshAgentConfig(
															chat.runtimeReady && !chat.readOnly,
														);
													else if (chat.activeProjectId)
														void chat.loadDraftCatalog(chat.activeProjectId);
												}}
												onModelRefresh={() => {
													if (chat.activeProjectId)
														void chat.loadDraftCatalog(
															chat.activeProjectId,
															true,
														);
												}}
												onModelChange={(model) => {
													if (model) void chat.changeModel(model);
												}}
												thinkingLevels={chat.composerThinkingLevels}
												selectedThinkingLevel={
													chat.composerSelectedThinkingLevel
												}
												thinkingDisabled={
													chat.readOnly ||
													!chat.historyReady ||
													!chat.activeProjectId ||
													chat.composerThinkingLevels.length === 0
												}
												onThinkingChange={(level) => {
													if (level) void chat.changeThinking(level);
												}}
											/>
										</ConversationColumn>
									</div>
								</ProjectWorkspacePanel>
							</main>

							<ChatImageLightbox />

							{visibleError ? (
								<div
									role="alert"
									className="fixed inset-x-3 bottom-24 z-50 mx-auto max-w-lg rounded-xl border border-destructive/30 bg-background px-3 py-2 text-xs shadow-lg"
								>
									<div className="flex items-start gap-2">
										<p className="min-w-0 flex-1 break-words text-destructive">
											{visibleError}
										</p>
										<button
											type="button"
											aria-label={t("common.close")}
											className="flex size-11 shrink-0 items-center justify-center rounded-md"
											onClick={() => {
												setFatalError(null);
												sessions.clearRefreshErrors();
											}}
										>
											<X className="size-3.5" />
										</button>
									</div>
								</div>
							) : null}
						</div>
					</SessionMentionScope>
				</SessionMentionProvider>
			</TooltipProvider>
		</ProjectWorkspaceContext.Provider>
	);
}

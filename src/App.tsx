import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	Group,
	Panel,
	Separator as ResizeSeparator,
	type PanelImperativeHandle,
} from "react-resizable-panels";
import { toast } from "sonner";

import { useChatFileOpener } from "@/components/chat/chat-file-open-context";
import { SessionMentionProvider } from "@/components/chat/session-mention-context";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { AddProjectDialog } from "@/components/sidebar/add-project-dialog";
import {
	projectViewerPath,
	retainedBackgroundChatVisualControllerIds,
	type OpenChat,
} from "@/components/app/app-chat-state";
import { useAppCatalog } from "@/components/app/use-app-catalog";
import { useAppChatWorkspace } from "@/components/app/use-app-chat-workspace";
import { useAppProjectActions } from "@/components/app/use-app-project-actions";
import { useOpenedChatControllers } from "@/components/app/use-opened-chat-controllers";
import {
	ChatImageLightbox,
	openChatImageLightbox,
} from "@/components/chat/chat-image-viewer";
import { ChatPageLoadingFallback } from "@/components/chat/chat-page-loading-fallback";
import { NewChatLanding } from "@/components/new-chat-landing";
import { SidebarFooter } from "@/components/sidebar-footer";
import { BootShellRemover } from "@/components/boot-shell-remover";
import { CUSTOM_TITLEBAR, TitleBar } from "@/components/title-bar";
import {
	ProjectWorkspaceContext,
	useProjectWorkspaces,
} from "@/components/app/project-workspace-context";
import { readProjectFile, readProjectTextFile } from "@/lib/api/files";
import { loadChatProjectImageUrl } from "@/lib/chat/chat-image-media";
import { resolveChatImageMimeType } from "@/lib/chat/chat-submission";
import { workspaceFileKey } from "@/lib/project-workspace";
import { recordChatSessionSwitchStart } from "@/lib/chat/chat-performance";
import { usePreferences } from "@/lib/preferences-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import {
	isSessionWindow,
	openSessionInNewWindow,
	readSessionWindowTarget,
} from "@/lib/api/window";
import { TooltipProvider } from "@/ui";

const importChatPage = () => import("@/components/chat/chat-page");
const ChatPage = lazy(() =>
	importChatPage().then((module) => ({
		default: module.ChatPage,
	})),
);
const RightSidebar = lazy(() =>
	import("@/components/right-sidebar").then((module) => ({
		default: module.RightSidebar,
	})),
);
const TerminalDock = lazy(() =>
	import("@/components/terminal-dock").then((module) => ({
		default: module.TerminalDock,
	})),
);

// Keep the existing right-sidebar implementation available for future work,
// but do not render or reserve layout space for it for now.
const RIGHT_SIDEBAR_ENABLED = false;

function App() {
	const { t } = useTranslation();
	const { keyboardShortcuts } = usePreferences();
	const rightPanelRef = useRef<PanelImperativeHandle>(null);
	const [leftSidebarCollapsedState, setLeftSidebarCollapsed] = useState(false);
	const [isResizing, setIsResizing] = useState(false);
	const [openedChats, setOpenedChats] = useState<OpenChat[]>([]);
	const {
		projects,
		setProjects,
		projectsReady,
		connectionCatalog,
		connectionsReady,
		envs,
		homeProjects,
		sidebarProjects,
		firstProject,
	} = useAppCatalog();
	const {
		busyChatControllersRef,
		busyChatControllerSince,
		handleChatRuntimeBusyChange,
	} = useOpenedChatControllers({
		projects,
		projectsReady,
		openedChats,
		setOpenedChats,
	});
	const {
		activeProject,
		activeProjectId,
		selectedSessionId,
		setFocusedProjectId,
		sidebarSessions,
		refreshingProjectIds,
		refreshProjectSessions,
		chatSession,
		draftTemporary,
		renderedOpenedChats,
		draftSessionId,
		readChatUiState,
		writeChatUiState,
		readProjectDraft,
		writeProjectDraft,
		handleProjectsRemoved,
		startLandingSession,
		startNewChat: navigateNewChat,
		startTemporaryChat: navigateTemporaryChat,
		switchDraftProject,
		selectSession,
		openSearchSession,
		registerSessionRefresh,
		refreshSession,
		updateSession,
		deleteSession,
		handleSessionIdentified,
		handleForkSessionCreated,
	} = useAppChatWorkspace({
		projects,
		projectsReady,
		firstProject,
		openedChats,
		setOpenedChats,
		busyChatControllersRef,
		busyChatControllerSince,
		preloadChatPage: importChatPage,
	});
	const activeChatControllerId = useMemo(() => {
		if (!chatSession) return null;
		return (
			renderedOpenedChats.find(
				(entry) =>
					entry.session.projectRecord.id === chatSession.projectRecord.id &&
					(entry.session.id === chatSession.id ||
						entry.piSessionId === chatSession.id),
			)?.controllerId ?? null
		);
	}, [chatSession, renderedOpenedChats]);

	// 新窗口启动时按 URL 参数定位会话（项目加载完成后再跳）。
	// 由「在新窗口打开会话」创建的窗口：隐藏左侧导航，使用自定义顶栏。
	const bootWindowTarget = useMemo(() => readSessionWindowTarget(), []);
	const sessionWindow = useMemo(() => isSessionWindow(), []);
	const leftSidebarCollapsed = sessionWindow
		? false
		: leftSidebarCollapsedState;
	const bootedWindowRef = useRef(false);
	useEffect(() => {
		if (bootedWindowRef.current || !bootWindowTarget || !projectsReady) return;
		bootedWindowRef.current = true;
		openSearchSession(bootWindowTarget);
	}, [bootWindowTarget, openSearchSession, projectsReady]);
	const [visualReadyControllerIds, setVisualReadyControllerIds] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const handleChatVisualReadyChange = useCallback(
		(controllerId: string, ready: boolean) => {
			setVisualReadyControllerIds((current) => {
				if (current.has(controllerId) === ready) return current;
				const next = new Set(current);
				if (ready) next.add(controllerId);
				else next.delete(controllerId);
				return next;
			});
		},
		[],
	);
	const retainedBackgroundVisualControllerIds = useMemo(
		() =>
			retainedBackgroundChatVisualControllerIds(
				renderedOpenedChats,
				activeChatControllerId,
				busyChatControllerSince,
			),
		[activeChatControllerId, busyChatControllerSince, renderedOpenedChats],
	);
	// LRU order is useful for eviction/retention, but must not become DOM order:
	// moving an existing WebView scroll container resets its native scrollTop.
	const mountedOpenedChats = useMemo(() => {
		const mounted = [...renderedOpenedChats];
		// oxlint-disable-next-line unicorn/no-array-sort -- sorting a clone keeps the LRU source immutable while giving mounted DOM a stable order. Plain codepoint comparison keeps that order locale-independent.
		mounted.sort((left, right) =>
			left.controllerId < right.controllerId
				? -1
				: left.controllerId > right.controllerId
					? 1
					: 0,
		);
		return mounted;
	}, [renderedOpenedChats]);
	const workspaceProjectIds = useMemo(
		() => projects.map((project) => project.id),
		[projects],
	);
	const workspaces = useProjectWorkspaces(workspaceProjectIds);
	const { openFile: openWorkspaceFile, selectFile: selectWorkspaceFile } =
		workspaces;
	const startNewChat = useCallback(
		(projectId?: string) => {
			const target = projectId ?? activeProject?.id;
			if (target) selectWorkspaceFile(target, null);
			navigateNewChat(projectId);
		},
		[activeProject?.id, navigateNewChat, selectWorkspaceFile],
	);
	const startTemporaryChat = useCallback(
		(projectId?: string) => {
			const target = projectId ?? activeProject?.id;
			if (target) selectWorkspaceFile(target, null);
			navigateTemporaryChat(projectId);
		},
		[activeProject?.id, navigateTemporaryChat, selectWorkspaceFile],
	);
	const monitoredSelectSession = useCallback(
		(sessionId: string, projectId: string) => {
			recordChatSessionSwitchStart(selectedSessionId ?? null, sessionId);
			selectWorkspaceFile(projectId, null);
			selectSession(sessionId, projectId);
		},
		[selectSession, selectWorkspaceFile, selectedSessionId],
	);
	const monitoredOpenSearchSession = useCallback(
		(target: Parameters<typeof openSearchSession>[0]) => {
			recordChatSessionSwitchStart(selectedSessionId ?? null, target.sessionId);
			selectWorkspaceFile(target.projectId, null);
			openSearchSession(target);
		},
		[openSearchSession, selectWorkspaceFile, selectedSessionId],
	);
	const {
		addProjectOpen,
		setAddProjectOpen,
		addProjectConnectionId,
		handleAddProject,
		handleReorderProjects,
		handleDeleteProject,
		handleDeleteConnection,
	} = useAppProjectActions({
		projects,
		setProjects,
		connectionCatalog,
		onProjectsRemoved: handleProjectsRemoved,
	});
	const [terminalOpenRequest, setTerminalOpenRequest] = useState(0);
	const [terminalMounted, setTerminalMounted] = useState(false);
	const [terminalVisible, setTerminalVisible] = useState(false);
	const [terminalRunning, setTerminalRunning] = useState(false);

	const toggleTerminal = useCallback(() => {
		if (terminalVisible) {
			setTerminalVisible(false);
			return;
		}
		if (!activeProject) {
			toast.info(t("app.addProjectFirst"));
			return;
		}
		setTerminalMounted(true);
		setTerminalVisible(true);
		setTerminalOpenRequest((request) => request + 1);
	}, [activeProject, t, terminalVisible]);
	const destroyTerminalDock = useCallback(() => {
		setTerminalVisible(false);
		setTerminalMounted(false);
		setTerminalRunning(false);
	}, []);
	const openedProjectFiles = workspaces.state.get(
		activeProject?.id ?? "",
	)?.files;
	const openViewerFile = useCallback(
		(candidate: string) => {
			if (!activeProject) return;
			const path = projectViewerPath(activeProject, candidate);
			if (!path) return;
			const absolutePath =
				path.startsWith("/") || /^[A-Za-z]:\//.test(path)
					? path
					: `${activeProject.path.replace(/[\\/]+$/, "")}/${path}`;
			const existing = openedProjectFiles?.find(
				(file) =>
					workspaceFileKey(file.path) === workspaceFileKey(absolutePath),
			);
			if (existing) {
				selectWorkspaceFile(activeProject.id, existing.path);
				return;
			}
			const mimeType = resolveChatImageMimeType({ name: path, type: "" });
			const request = mimeType
				? loadChatProjectImageUrl(path, mimeType, {
						projectId: activeProject.id,
						sessionKey: "file-viewer",
						readImage: async (projectId, imagePath) =>
							new Uint8Array(await readProjectFile(projectId, imagePath)),
					}).then((url) => {
						openChatImageLightbox({
							url,
							name: path.split("/").pop() || path,
						});
					})
				: readProjectTextFile(activeProject.id, path).then((content) => {
						openWorkspaceFile(activeProject.id, {
							path: absolutePath,
							content,
						});
					});
			void request.catch((error: unknown) => {
				toast.error(t("file.openFailed"), {
					description: error instanceof Error ? error.message : String(error),
				});
			});
		},
		[
			activeProject,
			t,
			openWorkspaceFile,
			openedProjectFiles,
			selectWorkspaceFile,
		],
	);

	const canOpenViewerFile = useCallback(
		(candidate: string) =>
			Boolean(activeProject && projectViewerPath(activeProject, candidate)),
		[activeProject],
	);

	// 工具行里的文件路径按类型打开图片查看器或工作区 Tab。
	useChatFileOpener(openViewerFile, canOpenViewerFile);

	useKeyboardShortcut(keyboardShortcuts["new-chat"], () => startNewChat());
	useKeyboardShortcut(keyboardShortcuts["toggle-sidebar"], () => {
		setLeftSidebarCollapsed((collapsed) => !collapsed);
	});

	return (
		<ProjectWorkspaceContext.Provider value={workspaces}>
			<TooltipProvider>
				<BootShellRemover ready={projectsReady && connectionsReady} />
				<SessionMentionProvider
					projects={projects}
					sessions={sidebarSessions}
					desktopDrag
				>
					<div
						data-session-window={sessionWindow ? "" : undefined}
						className="flex h-full bg-background text-foreground"
					>
						{sessionWindow ? null : (
							<AppSidebar
								collapsed={leftSidebarCollapsed}
								onCollapse={() => setLeftSidebarCollapsed(true)}
								envs={envs}
								projects={sidebarProjects}
								sessions={sidebarSessions}
								selectedProjectId={activeProjectId}
								selectedSessionId={selectedSessionId}
								onSelectSession={monitoredSelectSession}
								onOpenSearchSession={monitoredOpenSearchSession}
								onUpdateSession={(sessionId, update, projectId) => {
									void updateSession(sessionId, update, projectId);
								}}
								onRefreshSession={refreshSession}
								onDeleteSession={(sessionId, projectId) => {
									void deleteSession(sessionId, projectId);
								}}
								onDeleteProject={(projectId) =>
									void handleDeleteProject(projectId)
								}
								onDeleteConnection={(connectionId) =>
									void handleDeleteConnection(connectionId)
								}
								onNewChat={() => startNewChat()}
								onNewChatInProject={(projectId) => startNewChat(projectId)}
								onFocusProject={setFocusedProjectId}
								onReorderProjects={(connectionId, projectIds) =>
									void handleReorderProjects(connectionId, projectIds)
								}
								onAddProject={(connectionId) =>
									void handleAddProject(connectionId)
								}
								onRefreshProjectSessions={(projectId) => {
									void refreshProjectSessions(projectId, true).catch((error) =>
										console.error("Failed to refresh sessions", error),
									);
								}}
								refreshingProjectIds={refreshingProjectIds}
								footer={<SidebarFooter />}
							/>
						)}
						<main className="relative flex min-w-0 flex-1 flex-col">
							{CUSTOM_TITLEBAR && <TitleBar showAlwaysOnTop={sessionWindow} />}
							<Group orientation="horizontal" className="min-h-0 flex-1">
								<Panel
									defaultSize={RIGHT_SIDEBAR_ENABLED ? 560 : "100"}
									minSize={400}
									className="relative min-w-0"
								>
									{mountedOpenedChats.map((entry) => {
										const active =
											chatSession !== null &&
											entry.session.projectRecord.id ===
												chatSession.projectRecord.id &&
											(entry.session.id === chatSession.id ||
												entry.piSessionId === chatSession.id);
										const visualVisible =
											entry.controllerId === activeChatControllerId;
										return (
											<div
												key={entry.controllerId}
												aria-hidden={!visualVisible}
												className={
													visualVisible
														? active
															? "h-full min-h-0"
															: "pointer-events-none h-full min-h-0"
														: "pointer-events-none invisible absolute inset-0 h-full min-h-0"
												}
											>
												<Suspense
													fallback={
														<ChatPageLoadingFallback
															session={entry.session}
															initialMessage={entry.initialMessage}
															initialImages={entry.initialImages}
															uiStateKey={entry.uiStateKey}
															readUiState={readChatUiState}
															writeUiState={writeChatUiState}
															readProjectDraft={readProjectDraft}
															writeProjectDraft={writeProjectDraft}
															reserveWindowControls={CUSTOM_TITLEBAR}
															sidebarCollapsed={leftSidebarCollapsed}
															onOpenTerminal={toggleTerminal}
															terminalRunning={terminalRunning}
															terminalVisible={terminalVisible}
															onNewTemporaryChat={() =>
																startTemporaryChat(
																	entry.session.projectRecord.id,
																)
															}
															onExpandSidebar={() =>
																setLeftSidebarCollapsed(false)
															}
														/>
													}
												>
													<ChatPage
														session={entry.session}
														controllerId={entry.controllerId}
														performanceSessionId={
															entry.piSessionId ?? entry.session.id
														}
														uiStateKey={entry.uiStateKey}
														readUiState={readChatUiState}
														writeUiState={writeChatUiState}
														readProjectDraft={readProjectDraft}
														writeProjectDraft={writeProjectDraft}
														onRuntimeBusyChange={handleChatRuntimeBusyChange}
														onRegisterSessionRefresh={registerSessionRefresh}
														active={active}
														retainBackgroundVisual={retainedBackgroundVisualControllerIds.has(
															entry.controllerId,
														)}
														onVisualReadyChange={(ready) =>
															handleChatVisualReadyChange(
																entry.controllerId,
																ready,
															)
														}
														showSwitchSkeleton={
															active &&
															Boolean(entry.session.sessionPath) &&
															!visualReadyControllerIds.has(entry.controllerId)
														}
														initialMessage={entry.initialMessage}
														initialImages={entry.initialImages}
														onSessionIdentified={(piSessionId) =>
															handleSessionIdentified(entry, piSessionId)
														}
														onForkSessionCreated={(target) =>
															handleForkSessionCreated(entry, target)
														}
														onOpenChanges={
															RIGHT_SIDEBAR_ENABLED
																? () => rightPanelRef.current?.expand()
																: undefined
														}
														onOpenTerminal={toggleTerminal}
														terminalRunning={terminalRunning}
														terminalVisible={terminalVisible}
														onNewChat={() =>
															startNewChat(entry.session.projectRecord.id)
														}
														onNewTemporaryChat={() =>
															startTemporaryChat(entry.session.projectRecord.id)
														}
														onRenameSession={(title) => {
															void updateSession(
																entry.piSessionId ?? entry.session.id,
																{ title },
																entry.session.projectRecord.id,
															);
														}}
														onOpenInNewWindow={
															sessionWindow
																? undefined
																: () => {
																		openSessionInNewWindow({
																			sessionId:
																				entry.piSessionId ?? entry.session.id,
																			projectId: entry.session.projectRecord.id,
																			sessionPath:
																				entry.session.sessionPath ?? "",
																			title: entry.session.title,
																		});
																	}
														}
														onExpandSidebar={() =>
															setLeftSidebarCollapsed(false)
														}
														reserveWindowControls={CUSTOM_TITLEBAR}
														sidebarCollapsed={leftSidebarCollapsed}
													/>
												</Suspense>
											</div>
										);
									})}
									{!chatSession ? (
										<NewChatLanding
											key={`landing:${draftSessionId}`}
											sessionId={draftSessionId}
											temporary={draftTemporary}
											onNewChat={() => startNewChat(activeProject?.id)}
											projectAvailable={
												projectsReady && connectionsReady
													? Boolean(activeProject)
													: true
											}
											project={activeProject}
											projects={homeProjects}
											onSwitchProject={switchDraftProject}
											readProjectDraft={readProjectDraft}
											writeProjectDraft={writeProjectDraft}
											onOpenTerminal={toggleTerminal}
											terminalRunning={terminalRunning}
											terminalVisible={terminalVisible}
											onNewTemporaryChat={() =>
												startTemporaryChat(activeProject?.id)
											}
											onStartSession={startLandingSession}
											onExpandSidebar={() => setLeftSidebarCollapsed(false)}
											reserveWindowControls={CUSTOM_TITLEBAR}
											sidebarCollapsed={leftSidebarCollapsed}
										/>
									) : null}
								</Panel>
								{RIGHT_SIDEBAR_ENABLED ? (
									<>
										<ResizeSeparator
											className="w-1 bg-transparent transition-colors hover:bg-sidebar-border"
											onPointerDown={() => setIsResizing(true)}
											onPointerUp={() => setIsResizing(false)}
											onPointerCancel={() => setIsResizing(false)}
										/>
										<Suspense
											fallback={
												<Panel
													defaultSize={0}
													minSize={280}
													collapsible
													collapsedSize={0}
												/>
											}
										>
											<RightSidebar
												panelRef={rightPanelRef}
												resizing={isResizing}
												project={activeProject ?? undefined}
												onOpenFile={openViewerFile}
											/>
										</Suspense>
									</>
								) : null}
							</Group>
							{terminalMounted ? (
								<Suspense fallback={null}>
									<TerminalDock
										project={activeProject ?? undefined}
										visible={terminalVisible}
										openRequest={terminalOpenRequest}
										onRunningChange={setTerminalRunning}
										onDestroy={destroyTerminalDock}
									/>
								</Suspense>
							) : null}
						</main>
					</div>
					{addProjectOpen ? (
						<AddProjectDialog
							open
							onOpenChange={setAddProjectOpen}
							connection={
								connectionCatalog.find(
									(connection) => connection.id === addProjectConnectionId,
								) ??
								projects.find(
									(project) => project.connection.id === addProjectConnectionId,
								)?.connection ??
								null
							}
						/>
					) : null}
					<ChatImageLightbox />
				</SessionMentionProvider>
			</TooltipProvider>
		</ProjectWorkspaceContext.Provider>
	);
}

export default App;

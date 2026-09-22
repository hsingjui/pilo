import { lazy, Suspense, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Group,
	Panel,
	Separator as ResizeSeparator,
	type PanelImperativeHandle,
} from "react-resizable-panels";
import { toast } from "sonner";

import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { AddProjectDialog } from "@/components/sidebar/add-project-dialog";
import {
	projectRelativePath,
	retainedBackgroundChatVisualControllerIds,
	type OpenChat,
} from "@/components/app/app-chat-state";
import { useAppCatalog } from "@/components/app/use-app-catalog";
import { useAppChatWorkspace } from "@/components/app/use-app-chat-workspace";
import { useAppProjectActions } from "@/components/app/use-app-project-actions";
import { useOpenedChatControllers } from "@/components/app/use-opened-chat-controllers";
import { ChatImageLightbox } from "@/components/chat/chat-image-viewer";
import { ChatPageLoadingFallback } from "@/components/chat/chat-page-loading-fallback";
import { NewChatLanding } from "@/components/new-chat-landing";
import { SidebarFooter } from "@/components/sidebar-footer";
import { CUSTOM_TITLEBAR, IS_MACOS, TitleBar } from "@/components/title-bar";
import type { ViewerOpenRequest } from "@/components/project-viewer";
import { recordChatSessionSwitchStart } from "@/lib/chat-performance";
import { usePreferences } from "@/lib/preferences-provider";
import type { Project } from "@/lib/projects";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { TooltipProvider } from "@/ui";

const importChatPage = () => import("@/components/chat/chat-page");
const ChatPage = lazy(() =>
	importChatPage().then((module) => ({
		default: module.ChatPage,
	})),
);
const ProjectViewer = lazy(() =>
	import("@/components/project-viewer").then((module) => ({
		default: module.ProjectViewer,
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

let viewerRequestSequence = 0;

function App() {
	const { t } = useTranslation();
	const { keyboardShortcuts } = usePreferences();
	const rightPanelRef = useRef<PanelImperativeHandle>(null);
	const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
	const [isResizing, setIsResizing] = useState(false);
	const [openedChats, setOpenedChats] = useState<OpenChat[]>([]);
	const handleProjectsLoaded = useCallback((nextProjects: Project[]) => {
		setOpenedChats((current) =>
			current.filter((entry) =>
				nextProjects.some(
					(project) => project.id === entry.session.projectRecord.id,
				),
			),
		);
	}, []);
	const {
		projects,
		setProjects,
		projectsReady,
		connectionCatalog,
		connectionsReady,
		envs,
		sidebarProjects,
		firstProject,
	} = useAppCatalog(handleProjectsLoaded);
	const {
		busyChatControllersRef,
		busyChatControllerIds,
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
		renderedOpenedChats,
		draftSessionId,
		readChatUiState,
		writeChatUiState,
		handleProjectsRemoved,
		startLandingSession,
		startNewChat,
		startTemporaryChat,
		switchDraftProject,
		selectSession,
		openSearchSession,
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
		busyChatControllerIds,
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
				busyChatControllerIds,
			),
		[activeChatControllerId, busyChatControllerIds, renderedOpenedChats],
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
	const monitoredSelectSession = useCallback(
		(sessionId: string) => {
			recordChatSessionSwitchStart(selectedSessionId ?? null, sessionId);
			selectSession(sessionId);
		},
		[selectSession, selectedSessionId],
	);
	const monitoredOpenSearchSession = useCallback(
		(target: Parameters<typeof openSearchSession>[0]) => {
			recordChatSessionSwitchStart(selectedSessionId ?? null, target.sessionId);
			openSearchSession(target);
		},
		[openSearchSession, selectedSessionId],
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
	const [viewerRequest, setViewerRequest] = useState<ViewerOpenRequest | null>(
		null,
	);
	const [viewerVisible, setViewerVisible] = useState(false);
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
	const openViewerFile = useCallback(
		(candidate: string) => {
			if (!activeProject) return;
			const path = projectRelativePath(activeProject, candidate);
			if (!path) return;
			viewerRequestSequence += 1;
			setViewerRequest({
				id: viewerRequestSequence,
				projectId: activeProject.id,
				path,
			});
			setViewerVisible(true);
		},
		[activeProject],
	);

	useKeyboardShortcut(keyboardShortcuts["new-chat"], () => startNewChat());
	useKeyboardShortcut(keyboardShortcuts["toggle-sidebar"], () => {
		setLeftSidebarCollapsed((collapsed) => !collapsed);
	});

	return (
		<TooltipProvider>
			<div className="flex h-full bg-background text-foreground">
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
					onUpdateSession={(sessionId, update) => {
						void updateSession(sessionId, update);
					}}
					onDeleteSession={(sessionId) => {
						void deleteSession(sessionId);
					}}
					onDeleteProject={(projectId) => void handleDeleteProject(projectId)}
					onDeleteConnection={(connectionId) =>
						void handleDeleteConnection(connectionId)
					}
					onNewChat={() => startNewChat()}
					onNewChatInProject={(projectId) => startNewChat(projectId)}
					onFocusProject={setFocusedProjectId}
					onReorderProjects={(connectionId, projectIds) =>
						void handleReorderProjects(connectionId, projectIds)
					}
					onAddProject={(connectionId) => void handleAddProject(connectionId)}
					onRefreshProjectSessions={(projectId) => {
						void refreshProjectSessions(projectId, true).catch((error) =>
							console.error("Failed to refresh sessions", error),
						);
					}}
					refreshingProjectIds={refreshingProjectIds}
					footer={<SidebarFooter />}
				/>
				<main className="relative flex min-w-0 flex-1 flex-col">
					{CUSTOM_TITLEBAR && <TitleBar />}
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
													reserveWindowControls={CUSTOM_TITLEBAR}
													sidebarCollapsed={leftSidebarCollapsed}
													onOpenTerminal={toggleTerminal}
													terminalRunning={terminalRunning}
													terminalVisible={terminalVisible}
													onNewTemporaryChat={() =>
														startTemporaryChat(entry.session.projectRecord.id)
													}
													onExpandSidebar={() => setLeftSidebarCollapsed(false)}
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
												onRuntimeBusyChange={handleChatRuntimeBusyChange}
												active={active}
												retainBackgroundVisual={retainedBackgroundVisualControllerIds.has(
													entry.controllerId,
												)}
												onVisualReadyChange={(ready) =>
													handleChatVisualReadyChange(entry.controllerId, ready)
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
												onExpandSidebar={() => setLeftSidebarCollapsed(false)}
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
									onNewChat={() => startNewChat(activeProject?.id)}
									projectAvailable={
										projectsReady && connectionsReady
											? Boolean(activeProject)
											: true
									}
									project={activeProject}
									projects={projects}
									onSwitchProject={switchDraftProject}
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
							{activeProject && viewerRequest ? (
								<Suspense fallback={null}>
									<ProjectViewer
										key={`viewer:${activeProject.id}`}
										project={activeProject}
										request={
											viewerRequest?.projectId === activeProject.id
												? viewerRequest
												: undefined
										}
										visible={
											viewerVisible &&
											viewerRequest?.projectId === activeProject.id
										}
										reserveTrafficLights={IS_MACOS && leftSidebarCollapsed}
										onClose={() => setViewerVisible(false)}
									/>
								</Suspense>
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
		</TooltipProvider>
	);
}

export default App;

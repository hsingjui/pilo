import { lazy, Suspense, useCallback, useRef, useState } from "react";
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
	type OpenChat,
} from "@/components/app/app-chat-state";
import { useAppCatalog } from "@/components/app/use-app-catalog";
import { useAppChatWorkspace } from "@/components/app/use-app-chat-workspace";
import { useAppProjectActions } from "@/components/app/use-app-project-actions";
import { useOpenedChatControllers } from "@/components/app/use-opened-chat-controllers";
import { ChatPageLoadingFallback } from "@/components/chat/chat-page-loading-fallback";
import { NewChatLanding } from "@/components/new-chat-landing";
import { SidebarFooter } from "@/components/sidebar-footer";
import { CUSTOM_TITLEBAR, IS_MACOS, TitleBar } from "@/components/title-bar";
import type { EditorOpenRequest } from "@/components/project-editor";
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
const ProjectEditor = lazy(() =>
	import("@/components/project-editor").then((module) => ({
		default: module.ProjectEditor,
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

let editorRequestSequence = 0;

function App() {
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
	const [editorRequest, setEditorRequest] = useState<EditorOpenRequest | null>(
		null,
	);
	const [editorVisible, setEditorVisible] = useState(false);
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
			toast.info("请先新增项目");
			return;
		}
		setTerminalMounted(true);
		setTerminalVisible(true);
		setTerminalOpenRequest((request) => request + 1);
	}, [activeProject, terminalVisible]);
	const destroyTerminalDock = useCallback(() => {
		setTerminalVisible(false);
		setTerminalMounted(false);
		setTerminalRunning(false);
	}, []);
	const openEditorFile = useCallback(
		(candidate: string) => {
			if (!activeProject) return;
			const path = projectRelativePath(activeProject, candidate);
			if (!path) return;
			editorRequestSequence += 1;
			setEditorRequest({
				id: editorRequestSequence,
				projectId: activeProject.id,
				path,
			});
			setEditorVisible(true);
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
					onSelectSession={selectSession}
					onOpenSearchSession={openSearchSession}
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
							{renderedOpenedChats.map((entry) => {
								const visible =
									chatSession !== null &&
									entry.session.projectRecord.id ===
										chatSession.projectRecord.id &&
									(entry.session.id === chatSession.id ||
										entry.piSessionId === chatSession.id);
								return (
									<div
										key={entry.controllerId}
										className={visible ? "h-full min-h-0" : "hidden"}
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
												uiStateKey={entry.uiStateKey}
												readUiState={readChatUiState}
												writeUiState={writeChatUiState}
												onRuntimeBusyChange={handleChatRuntimeBusyChange}
												active={visible}
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
												onOpenFile={openEditorFile}
												onSessionChanged={() => {
													void refreshProjectSessions(
														entry.session.projectRecord.id,
													).catch((error) =>
														console.error("Failed to refresh sessions", error),
													);
												}}
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
							{activeProject && editorRequest ? (
								<Suspense fallback={null}>
									<ProjectEditor
										key={`editor:${activeProject.id}`}
										project={activeProject}
										request={
											editorRequest?.projectId === activeProject.id
												? editorRequest
												: undefined
										}
										visible={
											editorVisible &&
											editorRequest?.projectId === activeProject.id
										}
										reserveTrafficLights={IS_MACOS && leftSidebarCollapsed}
										onClose={() => setEditorVisible(false)}
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
										onOpenFile={openEditorFile}
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
		</TooltipProvider>
	);
}

export default App;

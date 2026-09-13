import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Group,
	Panel,
	Separator as ResizeSeparator,
	type PanelImperativeHandle,
} from "react-resizable-panels";

import {
	createChatUiStateCache,
	type ChatUiStateCache,
	type ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { AddProjectDialog } from "@/components/sidebar/add-project-dialog";
import {
	chatUiStateKey,
	createDraftSessionId,
	identifyOpenedChat,
	indexedChatSession,
	mergeSidebarSessionsWithOpenChats,
	projectRelativePath,
	syncOpenedChatSessionMetadata,
	touchOpenedChat,
	trimOpenedChats,
	upsertOpenedChat,
	type OpenChat,
} from "@/components/app/app-chat-state";
import { useAppSessionIndex } from "@/components/app/use-app-session-index";
import { ChatPageLoadingFallback } from "@/components/chat/chat-page-loading-fallback";
import type { ChatSession } from "@/components/chat/chat-page";
import { NewChatLanding } from "@/components/new-chat-landing";
import { SidebarFooter } from "@/components/sidebar-footer";
import { CUSTOM_TITLEBAR, IS_MACOS, TitleBar } from "@/components/title-bar";
import type { EditorOpenRequest } from "@/components/project-editor";
import { stopChatSession } from "@/lib/chat-session-client";
import type { PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import {
	connectionLabel,
	listProjects,
	notifyProjectsChanged,
	touchProject,
	PROJECTS_CHANGED_EVENT,
	type Project,
} from "@/lib/projects";
import { TooltipProvider } from "@/ui";

const ChatPage = lazy(() =>
	import("@/components/chat/chat-page").then((module) => ({
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

let editorRequestSequence = 0;

function App() {
	const rightPanelRef = useRef<PanelImperativeHandle>(null);
	const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
	const [isResizing, setIsResizing] = useState(false);
	const [projects, setProjects] = useState<Project[]>([]);
	const [openedChats, setOpenedChats] = useState<OpenChat[]>([]);
	const chatUiStateCacheRef = useRef<ChatUiStateCache | null>(null);
	if (chatUiStateCacheRef.current === null) {
		chatUiStateCacheRef.current = createChatUiStateCache();
	}
	const readChatUiState = useCallback(
		(key: string) => chatUiStateCacheRef.current!.get(key),
		[],
	);
	const writeChatUiState = useCallback(
		(key: string, patch: ChatUiStatePatch) => {
			chatUiStateCacheRef.current!.patch(key, patch);
		},
		[],
	);
	const previousOpenedChatsRef = useRef(new Map<string, OpenChat>());
	const busyChatControllersRef = useRef(new Set<string>());
	const [busyChatControllerIds, setBusyChatControllerIds] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const handleChatRuntimeBusyChange = useCallback(
		(controllerId: string, busy: boolean) => {
			const busyControllers = busyChatControllersRef.current;
			const changed = busy
				? !busyControllers.has(controllerId)
				: busyControllers.has(controllerId);
			if (busy) busyControllers.add(controllerId);
			else busyControllers.delete(controllerId);
			if (changed) setBusyChatControllerIds(new Set(busyControllers));
			if (!busy) {
				setOpenedChats((current) => trimOpenedChats(current, busyControllers));
			}
		},
		[],
	);
	const [draftSessionPrompt, setDraftSessionPrompt] = useState<string | null>(
		null,
	);
	const [draftSessionModel, setDraftSessionModel] = useState<PiModel | null>(
		null,
	);
	const [draftSessionThinkingLevel, setDraftSessionThinkingLevel] =
		useState<PiThinkingLevel | null>(null);
	const [draftSessionStarted, setDraftSessionStarted] = useState(false);
	const [draftSessionId, setDraftSessionId] = useState(createDraftSessionId);
	const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);
	const [addProjectOpen, setAddProjectOpen] = useState(false);
	const [addProjectConnectionId, setAddProjectConnectionId] = useState<
		string | null
	>(null);
	const [editorRequest, setEditorRequest] = useState<EditorOpenRequest | null>(
		null,
	);
	const [editorVisible, setEditorVisible] = useState(false);

	useEffect(() => {
		const next = new Map(
			openedChats.map((entry) => [entry.controllerId, entry] as const),
		);
		let busyChanged = false;
		for (const [controllerId, entry] of previousOpenedChatsRef.current) {
			if (next.has(controllerId)) continue;
			busyChanged =
				busyChatControllersRef.current.delete(controllerId) || busyChanged;
			void stopChatSession(
				entry.session.projectRecord.id,
				entry.session.id,
			).catch((error) =>
				console.warn("Failed to stop evicted chat session", error),
			);
		}
		if (busyChanged) {
			setBusyChatControllerIds(new Set(busyChatControllersRef.current));
		}
		previousOpenedChatsRef.current = next;
	}, [openedChats]);

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const next = await listProjects();
				if (active) {
					setProjects(next);
					setOpenedChats((current) =>
						current.filter((entry) =>
							next.some(
								(project) => project.id === entry.session.projectRecord.id,
							),
						),
					);
				}
			} catch (error) {
				console.error("Failed to load projects", error);
			}
		};
		void load();
		const handleChanged = () => void load();
		window.addEventListener(PROJECTS_CHANGED_EVENT, handleChanged);
		return () => {
			active = false;
			window.removeEventListener(PROJECTS_CHANGED_EVENT, handleChanged);
		};
	}, []);

	const envs = useMemo(() => {
		const seen = new Set<string>();
		return projects.flatMap((project) => {
			if (seen.has(project.connection.id)) return [];
			seen.add(project.connection.id);
			return [
				{
					id: project.connection.id,
					name: connectionLabel(project.connection),
				},
			];
		});
	}, [projects]);

	const sidebarProjects = useMemo(
		() =>
			projects.map((project) => ({
				id: project.id,
				name: project.name,
				path: project.metadata.cwd,
				envId: project.connection.id,
			})),
		[projects],
	);

	const firstProject = projects[0] ?? null;
	const activeProject =
		projects.find((project) => project.id === draftProjectId) ?? firstProject;
	const activeProjectId = activeProject?.id ?? null;
	const {
		indexedSessions,
		refreshProjectSessions,
		sidebarSessions: indexedSidebarSessions,
		updateSession: updateIndexedSession,
	} = useAppSessionIndex(activeProjectId);
	useEffect(() => {
		setOpenedChats((current) =>
			trimOpenedChats(
				syncOpenedChatSessionMetadata(current, indexedSessions),
				busyChatControllersRef.current,
			),
		);
	}, [indexedSessions]);
	const sidebarSessions = useMemo(
		() =>
			mergeSidebarSessionsWithOpenChats(
				indexedSidebarSessions,
				openedChats,
				busyChatControllerIds,
			),
		[indexedSidebarSessions, openedChats, busyChatControllerIds],
	);
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

	const selectedIndexedSession =
		indexedSessions.find(
			(session) => session.piSessionId === selectedSessionId,
		) ?? null;
	const selectedOpenedChat = selectedSessionId
		? (openedChats.find(
				(entry) =>
					entry.session.id === selectedSessionId ||
					entry.piSessionId === selectedSessionId,
			) ?? null)
		: null;
	const selectedOpenedChatBusy = selectedOpenedChat
		? busyChatControllerIds.has(selectedOpenedChat.controllerId)
		: false;
	const selectedProject = selectedIndexedSession
		? (projects.find(
				(project) => project.id === selectedIndexedSession.projectId,
			) ?? null)
		: null;
	const chatSession = useMemo<ChatSession | null>(() => {
		if (
			selectedOpenedChat &&
			(selectedOpenedChatBusy || !selectedIndexedSession)
		) {
			return selectedOpenedChat.session;
		}
		if (selectedIndexedSession && selectedProject) {
			return indexedChatSession(selectedIndexedSession, selectedProject);
		}
		if (activeProject && draftSessionStarted) {
			return {
				id: draftSessionId,
				title: "新对话",
				projectRecord: activeProject,
				initialModel: draftSessionModel ?? undefined,
				initialThinkingLevel: draftSessionThinkingLevel ?? undefined,
			};
		}
		return null;
	}, [
		selectedOpenedChat,
		selectedOpenedChatBusy,
		selectedIndexedSession,
		selectedProject,
		activeProject,
		draftSessionStarted,
		draftSessionId,
		draftSessionModel,
		draftSessionThinkingLevel,
	]);
	const renderedOpenedChats = useMemo(
		() =>
			chatSession
				? upsertOpenedChat(
						openedChats,
						chatSession,
						draftSessionPrompt ?? undefined,
					)
				: openedChats,
		[chatSession, draftSessionPrompt, openedChats],
	);

	const startNewChat = (projectId?: string) => {
		const targetProjectId = projectId ?? firstProject?.id ?? null;
		setDraftSessionStarted(false);
		setDraftSessionPrompt(null);
		setDraftSessionModel(null);
		setDraftSessionThinkingLevel(null);
		setDraftSessionId(createDraftSessionId());
		setDraftProjectId(targetProjectId);
		setSelectedSessionId(null);
		if (targetProjectId) {
			void touchProject(targetProjectId)
				.then(() => notifyProjectsChanged())
				.catch((error) =>
					console.error("Failed to update recent project", error),
				);
		}
	};

	const selectSession = (sessionId: string) => {
		const opened = openedChats.find(
			(entry) =>
				entry.session.id === sessionId || entry.piSessionId === sessionId,
		);
		const session = indexedSessions.find(
			(candidate) => candidate.piSessionId === sessionId,
		);
		const openedIsBusy = opened
			? busyChatControllersRef.current.has(opened.controllerId)
			: false;
		if (opened && (openedIsBusy || !session)) {
			const projectId = opened.session.projectRecord.id;
			setOpenedChats((current) =>
				trimOpenedChats(
					touchOpenedChat(current, opened.session, opened.initialMessage),
					busyChatControllersRef.current,
				),
			);
			setSelectedSessionId(sessionId);
			setDraftSessionStarted(false);
			setDraftSessionPrompt(null);
			setDraftSessionModel(null);
			setDraftSessionThinkingLevel(null);
			setDraftProjectId(projectId);
			void touchProject(projectId)
				.then(() => notifyProjectsChanged())
				.catch((error) =>
					console.error("Failed to update recent project", error),
				);
			return;
		}
		if (!session) return;
		const project = projects.find(
			(candidate) => candidate.id === session.projectId,
		);
		if (project) {
			const nextChat = indexedChatSession(session, project);
			setOpenedChats((current) =>
				trimOpenedChats(
					touchOpenedChat(current, nextChat),
					busyChatControllersRef.current,
				),
			);
		}
		setSelectedSessionId(sessionId);
		setDraftSessionStarted(false);
		setDraftSessionPrompt(null);
		setDraftSessionModel(null);
		setDraftSessionThinkingLevel(null);
		setDraftProjectId(session.projectId);
		void touchProject(session.projectId)
			.then(() => notifyProjectsChanged())
			.catch((error) =>
				console.error("Failed to update recent project", error),
			);
	};

	const updateSession = async (
		sessionId: string,
		update: { pinned?: boolean; archived?: boolean; title?: string },
	) => {
		const next = await updateIndexedSession(sessionId, update);
		if (next?.archived && selectedSessionId === next.piSessionId) {
			setSelectedSessionId(null);
		}
	};

	return (
		<TooltipProvider>
			<div className="flex h-full bg-background text-foreground">
				<AppSidebar
					collapsed={leftSidebarCollapsed}
					onCollapse={() => setLeftSidebarCollapsed(true)}
					envs={envs}
					projects={sidebarProjects}
					sessions={sidebarSessions}
					selectedSessionId={selectedSessionId}
					onSelectSession={selectSession}
					onUpdateSession={(sessionId, update) => {
						void updateSession(sessionId, update);
					}}
					onArchiveProjectSessions={(sessionIds) => {
						for (const sessionId of sessionIds) {
							void updateSession(sessionId, { archived: true });
						}
					}}
					onNewChat={() => startNewChat()}
					onNewChatInProject={(projectId) => startNewChat(projectId)}
					onAddProject={(connectionId) => {
						setAddProjectConnectionId(connectionId ?? null);
						setAddProjectOpen(true);
					}}
					onRefreshProjectSessions={(projectId) => {
						void refreshProjectSessions(projectId).catch((error) =>
							console.error("Failed to refresh sessions", error),
						);
					}}
					footer={<SidebarFooter />}
				/>
				<main className="relative flex min-w-0 flex-1 flex-col">
					{CUSTOM_TITLEBAR && <TitleBar />}
					<Group orientation="horizontal" className="min-h-0 flex-1">
						<Panel defaultSize={560} minSize={400} className="relative min-w-0">
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
													reserveWindowControls={CUSTOM_TITLEBAR}
													sidebarCollapsed={leftSidebarCollapsed}
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
												onSessionIdentified={(piSessionId) => {
													const nextUiStateKey = chatUiStateKey(
														entry.session.projectRecord.id,
														piSessionId,
													);
													chatUiStateCacheRef.current!.rekey(
														entry.uiStateKey,
														nextUiStateKey,
													);
													setOpenedChats((current) =>
														identifyOpenedChat(
															current,
															entry.controllerId,
															piSessionId,
														),
													);
													setSelectedSessionId((current) =>
														current === entry.session.id ||
														current === entry.piSessionId
															? piSessionId
															: current,
													);
												}}
												onOpenChanges={() => rightPanelRef.current?.expand()}
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
									key={`landing:${activeProject?.id ?? "no-project"}:${draftSessionId}`}
									projectAvailable={Boolean(activeProject)}
									project={activeProject}
									onStartSession={(prompt, model, thinkingLevel) => {
										if (!activeProject) return;
										const nextChat: ChatSession = {
											id: draftSessionId,
											title: "新对话",
											projectRecord: activeProject,
											initialModel: model ?? undefined,
											initialThinkingLevel: thinkingLevel ?? undefined,
										};
										setOpenedChats((current) =>
											trimOpenedChats(
												touchOpenedChat(current, nextChat, prompt),
												busyChatControllersRef.current,
											),
										);
										setDraftProjectId(activeProject.id);
										setSelectedSessionId(draftSessionId);
										setDraftSessionModel(model);
										setDraftSessionThinkingLevel(thinkingLevel);
										setDraftSessionPrompt(prompt);
										setDraftSessionStarted(true);
									}}
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
					</Group>
				</main>
			</div>
			{addProjectOpen ? (
				<AddProjectDialog
					open
					onOpenChange={setAddProjectOpen}
					initialConnectionId={addProjectConnectionId}
				/>
			) : null}
		</TooltipProvider>
	);
}

export default App;

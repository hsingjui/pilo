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
import { toast } from "sonner";

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
import { CONNECTIONS_CHANGED_EVENT } from "@/lib/connection-events";
import { listConnectionCatalog } from "@/lib/connections";
import {
	listenForDesktopNotificationActions,
	type DesktopNotificationSessionTarget,
} from "@/lib/desktop-notifications";
import {
	HOME_CONNECTIONS_CHANGED_EVENT,
	listHomeConnectionIds,
} from "@/lib/home-connections";
import {
	hydrateProjectPiModels,
	refreshAllProjectPiModels,
	refreshProjectPiModels,
} from "@/lib/pi-models";
import { usePreferences } from "@/lib/preferences-provider";
import type { Connection, PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import {
	addProject,
	connectionLabel,
	listProjects,
	notifyProjectsChanged,
	pickLocalProjectDirectory,
	touchProject,
	PROJECTS_CHANGED_EVENT,
	type Project,
} from "@/lib/projects";
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

// Keep the existing right-sidebar implementation available for future work,
// but do not render or reserve layout space for it for now.
const RIGHT_SIDEBAR_ENABLED = false;

let editorRequestSequence = 0;

function App() {
	const { keyboardShortcuts } = usePreferences();
	const rightPanelRef = useRef<PanelImperativeHandle>(null);
	const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
	const [isResizing, setIsResizing] = useState(false);
	const [projects, setProjects] = useState<Project[]>([]);
	const [projectsReady, setProjectsReady] = useState(false);
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
	const startupModelRefreshStartedRef = useRef(false);
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
	const pendingLandingSubmissionRef = useRef<{
		prompt: string;
		model: PiModel | null;
		thinkingLevel: PiThinkingLevel | null;
	} | null>(null);
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
	const localProjectPickerPendingRef = useRef(false);
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
		void hydrateProjectPiModels().catch((error) => {
			console.warn("Failed to hydrate Pi model cache", error);
		});
	}, []);

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const next = await listProjects();
				if (active) {
					setProjects(next);
					if (!startupModelRefreshStartedRef.current) {
						startupModelRefreshStartedRef.current = true;
						void refreshAllProjectPiModels(next.map((project) => project.id));
					}
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
			} finally {
				if (active) setProjectsReady(true);
			}
		};
		void load();
		const handleChanged = () => void load();
		window.addEventListener(PROJECTS_CHANGED_EVENT, handleChanged);
		window.addEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		return () => {
			active = false;
			window.removeEventListener(PROJECTS_CHANGED_EVENT, handleChanged);
			window.removeEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		};
	}, []);

	// 首页环境列表除了项目所属连接，还包含被显式标记「显示在首页」的连接。
	const [connectionCatalog, setConnectionCatalog] = useState<Connection[]>([]);
	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const next = await listConnectionCatalog();
				if (active) setConnectionCatalog(next);
			} catch (error) {
				console.error("Failed to load connections", error);
			}
		};
		void load();
		const handleChanged = () => void load();
		window.addEventListener(HOME_CONNECTIONS_CHANGED_EVENT, handleChanged);
		window.addEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		return () => {
			active = false;
			window.removeEventListener(HOME_CONNECTIONS_CHANGED_EVENT, handleChanged);
			window.removeEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		};
	}, []);

	useEffect(() => {
		if (projects.length === 0) return;
		const timer = window.setInterval(
			() => {
				void refreshAllProjectPiModels(projects.map((project) => project.id));
			},
			60 * 60 * 1000,
		);
		return () => window.clearInterval(timer);
	}, [projects]);

	const envs = useMemo(() => {
		const byId = new Map<string, { id: string; name: string }>();
		for (const project of projects) {
			byId.set(project.connection.id, {
				id: project.connection.id,
				name: connectionLabel(project.connection),
			});
		}
		const shown = listHomeConnectionIds();
		for (const connection of connectionCatalog) {
			if (!shown.has(connection.id) || byId.has(connection.id)) continue;
			byId.set(connection.id, {
				id: connection.id,
				name: connectionLabel(connection),
			});
		}
		const list = [...byId.values()];
		// Local 始终置顶；其余保持稳定的插入顺序。
		list.sort((a, b) => (a.id === "local" ? -1 : b.id === "local" ? 1 : 0));
		return list;
	}, [projects, connectionCatalog]);

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
		removeSession: removeIndexedSession,
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
	const startDraftSession = useCallback(
		(
			project: Project,
			prompt: string,
			model: PiModel | null,
			thinkingLevel: PiThinkingLevel | null,
		) => {
			const nextChat: ChatSession = {
				id: draftSessionId,
				title: "新对话",
				projectRecord: project,
				initialModel: model ?? undefined,
				initialThinkingLevel: thinkingLevel ?? undefined,
			};
			setOpenedChats((current) =>
				trimOpenedChats(
					touchOpenedChat(current, nextChat, prompt),
					busyChatControllersRef.current,
				),
			);
			setDraftProjectId(project.id);
			setSelectedSessionId(draftSessionId);
			setDraftSessionModel(model);
			setDraftSessionThinkingLevel(thinkingLevel);
			setDraftSessionPrompt(prompt);
			setDraftSessionStarted(true);
		},
		[draftSessionId],
	);

	// 刷新后的首个项目读取是异步的，但 Landing 不应该因此禁用输入框。
	// 如果用户恰好在项目列表返回前发送，先记住这次提交，项目就绪后立即继续。
	useEffect(() => {
		if (!projectsReady) return;
		const pending = pendingLandingSubmissionRef.current;
		if (!pending) return;
		pendingLandingSubmissionRef.current = null;
		if (!activeProject) {
			toast.info("请先新增项目");
			return;
		}
		startDraftSession(
			activeProject,
			pending.prompt,
			pending.model,
			pending.thinkingLevel,
		);
	}, [activeProject, projectsReady, startDraftSession]);

	// 落地页提交第一条消息后会立即切到 lazy ChatPage。项目可用后就预热该 chunk，
	// 避免它与真正的发送动作竞争，同时不让无项目的首屏承担这部分加载成本。
	useEffect(() => {
		if (chatSession || !activeProject) return;
		void importChatPage().catch(() => undefined);
	}, [activeProject, chatSession]);

	const startNewChat = useCallback(
		(projectId?: string) => {
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
		},
		[firstProject?.id],
	);

	useKeyboardShortcut(keyboardShortcuts["new-chat"], () => startNewChat());
	useKeyboardShortcut(keyboardShortcuts["toggle-sidebar"], () => {
		setLeftSidebarCollapsed((collapsed) => !collapsed);
	});

	const selectSession = useCallback(
		(sessionId: string) => {
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
		},
		[indexedSessions, openedChats, projects],
	);

	const openNotificationSession = useCallback(
		(target: DesktopNotificationSessionTarget) => {
			setDraftProjectId(target.projectId);
			setSelectedSessionId(target.sessionId);
			setDraftSessionStarted(false);
			setDraftSessionPrompt(null);
			setDraftSessionModel(null);
			setDraftSessionThinkingLevel(null);
			void touchProject(target.projectId)
				.then(() => notifyProjectsChanged())
				.catch((error) =>
					console.error("Failed to update recent project", error),
				);
		},
		[],
	);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void listenForDesktopNotificationActions(openNotificationSession)
			.then((cleanup) => {
				if (disposed) cleanup();
				else unlisten = cleanup;
			})
			.catch((error) =>
				console.warn("Failed to listen for notification actions", error),
			);
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [openNotificationSession]);

	const handleAddProject = useCallback(
		async (connectionId?: string) => {
			const connection =
				connectionCatalog.find((item) => item.id === connectionId) ??
				projects.find((project) => project.connection.id === connectionId)
					?.connection ??
				null;
			if (!connection) return;

			if (connection.kind.type !== "local") {
				setAddProjectConnectionId(connection.id);
				setAddProjectOpen(true);
				return;
			}

			if (localProjectPickerPendingRef.current) return;
			localProjectPickerPendingRef.current = true;
			try {
				const selectedPath = await pickLocalProjectDirectory();
				if (!selectedPath) return;
				const project = await addProject(connection.id, selectedPath);
				void refreshProjectPiModels(project.id).catch((error) => {
					console.warn(
						"Failed to refresh Pi models after adding project",
						error,
					);
				});
				notifyProjectsChanged();
				toast.success(`已添加 ${project.name}`, {
					description: `${project.connection.name} · ${project.metadata.cwd}`,
				});
			} catch (error) {
				toast.error("添加项目失败", { description: String(error) });
			} finally {
				localProjectPickerPendingRef.current = false;
			}
		},
		[connectionCatalog, projects],
	);

	const updateSession = async (
		sessionId: string,
		update: { title?: string },
	) => {
		await updateIndexedSession(sessionId, update);
	};

	const deleteSession = async (sessionId: string) => {
		const session = indexedSessions.find(
			(candidate) => candidate.piSessionId === sessionId,
		);
		if (!session) return;
		try {
			await stopChatSession(session.projectId, sessionId);
			const deleted = await removeIndexedSession(sessionId);
			if (!deleted) return;
			setOpenedChats((current) =>
				current.filter(
					(entry) =>
						entry.session.id !== sessionId && entry.piSessionId !== sessionId,
				),
			);
			setSelectedSessionId((current) =>
				current === sessionId ? null : current,
			);
			toast.success(
				deleted.result.method === "trash" ? "会话已移到回收站" : "会话已删除",
			);
		} catch (error) {
			toast.error("删除会话失败", { description: String(error) });
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
					onDeleteSession={(sessionId) => {
						void deleteSession(sessionId);
					}}
					onNewChat={() => startNewChat()}
					onNewChatInProject={(projectId) => startNewChat(projectId)}
					onAddProject={(connectionId) => void handleAddProject(connectionId)}
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
													uiStateKey={entry.uiStateKey}
													readUiState={readChatUiState}
													writeUiState={writeChatUiState}
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
												onOpenChanges={
													RIGHT_SIDEBAR_ENABLED
														? () => rightPanelRef.current?.expand()
														: undefined
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
									projectAvailable={
										projectsReady ? Boolean(activeProject) : true
									}
									project={activeProject}
									onStartSession={(prompt, model, thinkingLevel) => {
										if (!projectsReady) {
											pendingLandingSubmissionRef.current = {
												prompt,
												model,
												thinkingLevel,
											};
											return;
										}
										if (!activeProject) {
											toast.info("请先新增项目");
											return;
										}
										startDraftSession(
											activeProject,
											prompt,
											model,
											thinkingLevel,
										);
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

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

import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { AddProjectDialog } from "@/components/sidebar/add-project-dialog";
import type { SidebarSession } from "@/components/sidebar/types";
import type { ChatSession } from "@/components/chat/chat-page";
import { NewChatLanding } from "@/components/new-chat-landing";
import { SidebarFooter } from "@/components/sidebar-footer";
import { CUSTOM_TITLEBAR, IS_MACOS, TitleBar } from "@/components/title-bar";
import type { EditorOpenRequest } from "@/components/project-editor";
import {
	listenRuntimeEvents,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/pi-runtime";
import {
	listSessions,
	listenSessionWatchEvents,
	reconcileSessions,
	startSessionWatch,
	stopSessionWatch,
	updateSessionUiState,
	type SessionIndexEntry,
} from "@/lib/sessions";
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

let draftSessionSequence = 0;
let editorRequestSequence = 0;

function sessionDate(session: SessionIndexEntry) {
	if (session.fileMtimeNs > 0) {
		return new Date(session.fileMtimeNs / 1_000_000);
	}
	const value = session.lastMessageAt ?? session.updatedAt ?? session.createdAt;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? new Date(session.indexedAtMs) : date;
}

function toSidebarSession(session: SessionIndexEntry): SidebarSession {
	return {
		id: session.piSessionId,
		title:
			session.titleOverride ??
			session.name ??
			session.firstUserMessagePreview ??
			"新对话",
		preview:
			session.titleOverride || session.name
				? session.firstUserMessagePreview
				: null,
		sessionPath: session.sessionPath,
		projectId: session.projectId,
		latestMessageAt: sessionDate(session),
		pinned: session.pinned,
		archived: session.archived,
	};
}

function createDraftSessionId() {
	draftSessionSequence += 1;
	return `draft-session-${Date.now()}-${draftSessionSequence}`;
}

function projectRelativePath(project: Project, candidate: string) {
	const root = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
	const path = candidate.trim().replace(/\\/g, "/");
	if (!path || path === root) return null;
	if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
	if (path.startsWith("./")) return path.slice(2);
	if (path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return null;
	if (path.split("/").some((part) => part === "..")) return null;
	return path;
}

type OpenChat = {
	session: ChatSession;
	initialMessage?: string;
	piSessionId?: string;
};

function indexedChatSession(
	session: SessionIndexEntry,
	project: Project,
): ChatSession {
	return {
		id: session.piSessionId,
		title:
			session.titleOverride ??
			session.name ??
			session.firstUserMessagePreview ??
			"新对话",
		projectRecord: project,
		sessionPath: session.sessionPath,
		historyFileSize: session.fileSize,
		historyFileMtimeNs: session.fileMtimeNs,
	};
}

function upsertOpenedChat(
	current: OpenChat[],
	session: ChatSession,
	initialMessage?: string,
): OpenChat[] {
	const index = current.findIndex(
		(entry) =>
			entry.session.projectRecord.id === session.projectRecord.id &&
			(entry.session.id === session.id || entry.piSessionId === session.id),
	);
	if (index < 0) return [...current, { session, initialMessage }];

	const existing = current[index];
	const nextInitialMessage = existing.initialMessage ?? initialMessage;
	const sessionChanged =
		existing.session.title !== session.title ||
		existing.session.projectRecord !== session.projectRecord ||
		existing.session.sessionPath !== session.sessionPath ||
		existing.session.historyFileSize !== session.historyFileSize ||
		existing.session.historyFileMtimeNs !== session.historyFileMtimeNs;
	if (!sessionChanged && nextInitialMessage === existing.initialMessage)
		return current;

	const next = current.slice();
	next[index] = {
		...existing,
		initialMessage: nextInitialMessage,
		session: sessionChanged
			? {
					...existing.session,
					...session,
				}
			: existing.session,
	};
	return next;
}

function App() {
	const rightPanelRef = useRef<PanelImperativeHandle>(null);
	const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
	const [isResizing, setIsResizing] = useState(false);
	const [projects, setProjects] = useState<Project[]>([]);
	const [openedChats, setOpenedChats] = useState<OpenChat[]>([]);
	const [indexedSessions, setIndexedSessions] = useState<SessionIndexEntry[]>(
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

	const replaceProjectSessions = useCallback(
		(projectId: string, sessions: SessionIndexEntry[]) => {
			setIndexedSessions((current) => [
				...current.filter((session) => session.projectId !== projectId),
				...sessions,
			]);
		},
		[],
	);

	const refreshProjectSessions = useCallback(
		async (projectId: string) => {
			const result = await reconcileSessions(projectId);
			replaceProjectSessions(projectId, result.sessions);
		},
		[replaceProjectSessions],
	);

	useEffect(() => {
		if (!activeProjectId) return;
		let disposed = false;
		let refreshTimer: number | undefined;
		let unlistenRuntime: (() => void) | undefined;
		let unlistenSessionWatch: (() => void) | undefined;

		const refresh = () => {
			void refreshProjectSessions(activeProjectId).catch((error) =>
				console.error("Failed to reconcile sessions", error),
			);
		};
		const queueRefresh = () => {
			if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(refresh, 120);
		};
		const hydrateThenRefresh = async () => {
			try {
				const cached = await listSessions(activeProjectId);
				if (!disposed) replaceProjectSessions(activeProjectId, cached);
			} catch (error) {
				console.error("Failed to load cached sessions", error);
			}
			if (!disposed) refresh();
		};

		void hydrateThenRefresh();
		window.addEventListener("focus", queueRefresh);
		void listenRuntimeEvents((event) => {
			if (event.projectId && event.projectId !== activeProjectId) {
				if (event.type === "assistant_message_end") {
					void refreshProjectSessions(event.projectId).catch((error) =>
						console.error("Failed to refresh background sessions", error),
					);
				}
				return;
			}
			if (
				event.type === "assistant_message_end" ||
				(event.type === "process_state" && event.state === "running")
			) {
				queueRefresh();
			}
		})
			.then((unlisten) => {
				if (disposed) unlisten();
				else unlistenRuntime = unlisten;
			})
			.catch((error) =>
				console.error("Failed to listen for runtime events", error),
			);
		void listenSessionWatchEvents((event) => {
			if (event.projectId !== activeProjectId) return;
			if (event.type === "changed") queueRefresh();
			if (event.type === "indexed") {
				void listSessions(activeProjectId)
					.then((sessions) => {
						if (!disposed) replaceProjectSessions(activeProjectId, sessions);
					})
					.catch((error) =>
						console.error("Failed to load background-indexed sessions", error),
					);
			}
			if (event.type === "error") {
				console.warn("Session watcher fallback active", event.message);
			}
		})
			.then(async (unlisten) => {
				if (disposed) {
					unlisten();
					return;
				}
				unlistenSessionWatch = unlisten;
				await startSessionWatch(activeProjectId);
			})
			.catch((error) =>
				console.error("Failed to start session watcher", error),
			);
		return () => {
			disposed = true;
			if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
			window.removeEventListener("focus", queueRefresh);
			unlistenRuntime?.();
			unlistenSessionWatch?.();
			void stopSessionWatch(activeProjectId).catch(() => undefined);
		};
	}, [activeProjectId, refreshProjectSessions, replaceProjectSessions]);

	const sidebarSessions = useMemo(
		() => indexedSessions.map(toSidebarSession),
		[indexedSessions],
	);

	const selectedIndexedSession =
		indexedSessions.find(
			(session) => session.piSessionId === selectedSessionId,
		) ?? null;
	const selectedProject = selectedIndexedSession
		? (projects.find(
				(project) => project.id === selectedIndexedSession.projectId,
			) ?? null)
		: null;
	const chatSession = useMemo<ChatSession | null>(
		() =>
			selectedIndexedSession && selectedProject
				? indexedChatSession(selectedIndexedSession, selectedProject)
				: activeProject && draftSessionStarted
					? {
							id: draftSessionId,
							title: "新对话",
							projectRecord: activeProject,
							initialModel: draftSessionModel ?? undefined,
							initialThinkingLevel: draftSessionThinkingLevel ?? undefined,
						}
					: null,
		[
			selectedIndexedSession,
			selectedProject,
			activeProject,
			draftSessionStarted,
			draftSessionId,
			draftSessionModel,
			draftSessionThinkingLevel,
		],
	);
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
		const session = indexedSessions.find(
			(candidate) => candidate.piSessionId === sessionId,
		);
		if (!session) return;
		const project = projects.find(
			(candidate) => candidate.id === session.projectId,
		);
		if (project) {
			const nextChat = indexedChatSession(session, project);
			setOpenedChats((current) => upsertOpenedChat(current, nextChat));
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
		const session = indexedSessions.find(
			(candidate) => candidate.piSessionId === sessionId,
		);
		if (!session) return;
		try {
			const next = await updateSessionUiState(session.sessionPath, {
				pinned: update.pinned ?? session.pinned,
				archived: update.archived ?? session.archived,
				titleOverride:
					update.title === undefined ? session.titleOverride : update.title,
			});
			setIndexedSessions((current) =>
				current.map((candidate) =>
					candidate.sessionPath === next.sessionPath ? next : candidate,
				),
			);
			if (next.archived && selectedSessionId === next.piSessionId) {
				setSelectedSessionId(null);
			}
		} catch (error) {
			console.error("Failed to update session UI state", error);
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
										key={`${entry.session.projectRecord.id}:${entry.session.id}`}
										className={visible ? "h-full min-h-0" : "hidden"}
									>
										<Suspense
											fallback={<div className="h-full bg-background" />}
										>
											<ChatPage
												session={entry.session}
												active={visible}
												initialMessage={entry.initialMessage}
												onSessionIdentified={(piSessionId) => {
													setOpenedChats((current) =>
														current.map((chat) =>
															chat.session.id === entry.session.id &&
															chat.session.projectRecord.id ===
																entry.session.projectRecord.id &&
															chat.piSessionId !== piSessionId
																? { ...chat, piSessionId }
																: chat,
														),
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
											upsertOpenedChat(current, nextChat, prompt),
										);
										setDraftProjectId(activeProject.id);
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

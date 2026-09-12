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
import { AddWorkspaceDialog } from "@/components/sidebar/add-workspace-dialog";
import type { SidebarSession } from "@/components/sidebar/types";
import type { ChatSession } from "@/components/chat/chat-page";
import { NewChatLanding } from "@/components/new-chat-landing";
import { SidebarFooter } from "@/components/sidebar-footer";
import { CUSTOM_TITLEBAR, IS_MACOS, TitleBar } from "@/components/title-bar";
import type { EditorOpenRequest } from "@/components/workspace-editor";
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
	listWorkspaces,
	notifyWorkspacesChanged,
	touchWorkspace,
	WORKSPACES_CHANGED_EVENT,
	type Workspace,
} from "@/lib/workspaces";
import { TooltipProvider } from "@/ui";

const ChatPage = lazy(() =>
	import("@/components/chat/chat-page").then((module) => ({
		default: module.ChatPage,
	})),
);
const WorkspaceEditor = lazy(() =>
	import("@/components/workspace-editor").then((module) => ({
		default: module.WorkspaceEditor,
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
		workspaceId: session.workspaceId,
		latestMessageAt: sessionDate(session),
		pinned: session.pinned,
		archived: session.archived,
	};
}

function createDraftSessionId() {
	draftSessionSequence += 1;
	return `draft-session-${Date.now()}-${draftSessionSequence}`;
}

function workspaceRelativePath(workspace: Workspace, candidate: string) {
	const root = workspace.path.replace(/\\/g, "/").replace(/\/+$/, "");
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
	workspace: Workspace,
): ChatSession {
	return {
		id: session.piSessionId,
		title:
			session.titleOverride ??
			session.name ??
			session.firstUserMessagePreview ??
			"新对话",
		workspaceRecord: workspace,
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
			entry.session.workspaceRecord.id === session.workspaceRecord.id &&
			(entry.session.id === session.id || entry.piSessionId === session.id),
	);
	if (index < 0) return [...current, { session, initialMessage }];

	const existing = current[index];
	const nextInitialMessage = existing.initialMessage ?? initialMessage;
	const sessionChanged =
		existing.session.title !== session.title ||
		existing.session.workspaceRecord !== session.workspaceRecord ||
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
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
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
	const [draftWorkspaceId, setDraftWorkspaceId] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);
	const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
	const [addWorkspaceConnectionId, setAddWorkspaceConnectionId] = useState<
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
				const next = await listWorkspaces();
				if (active) {
					setWorkspaces(next);
					setOpenedChats((current) =>
						current.filter((entry) =>
							next.some(
								(workspace) =>
									workspace.id === entry.session.workspaceRecord.id,
							),
						),
					);
				}
			} catch (error) {
				console.error("Failed to load workspaces", error);
			}
		};
		void load();
		const handleChanged = () => void load();
		window.addEventListener(WORKSPACES_CHANGED_EVENT, handleChanged);
		return () => {
			active = false;
			window.removeEventListener(WORKSPACES_CHANGED_EVENT, handleChanged);
		};
	}, []);

	const envs = useMemo(() => {
		const seen = new Set<string>();
		return workspaces.flatMap((workspace) => {
			if (seen.has(workspace.connection.id)) return [];
			seen.add(workspace.connection.id);
			return [
				{
					id: workspace.connection.id,
					name: connectionLabel(workspace.connection),
				},
			];
		});
	}, [workspaces]);

	const sidebarWorkspaces = useMemo(
		() =>
			workspaces.map((workspace) => ({
				id: workspace.id,
				name: workspace.name,
				path: workspace.metadata.cwd,
				envId: workspace.connection.id,
			})),
		[workspaces],
	);

	const firstWorkspace = workspaces[0] ?? null;
	const activeWorkspace =
		workspaces.find((workspace) => workspace.id === draftWorkspaceId) ??
		firstWorkspace;
	const activeWorkspaceId = activeWorkspace?.id ?? null;
	const openEditorFile = useCallback(
		(candidate: string) => {
			if (!activeWorkspace) return;
			const path = workspaceRelativePath(activeWorkspace, candidate);
			if (!path) return;
			editorRequestSequence += 1;
			setEditorRequest({
				id: editorRequestSequence,
				workspaceId: activeWorkspace.id,
				path,
			});
			setEditorVisible(true);
		},
		[activeWorkspace],
	);

	const replaceWorkspaceSessions = useCallback(
		(workspaceId: string, sessions: SessionIndexEntry[]) => {
			setIndexedSessions((current) => [
				...current.filter((session) => session.workspaceId !== workspaceId),
				...sessions,
			]);
		},
		[],
	);

	const refreshWorkspaceSessions = useCallback(
		async (workspaceId: string) => {
			const result = await reconcileSessions(workspaceId);
			replaceWorkspaceSessions(workspaceId, result.sessions);
		},
		[replaceWorkspaceSessions],
	);

	useEffect(() => {
		if (!activeWorkspaceId) return;
		let disposed = false;
		let refreshTimer: number | undefined;
		let unlistenRuntime: (() => void) | undefined;
		let unlistenSessionWatch: (() => void) | undefined;

		const refresh = () => {
			void refreshWorkspaceSessions(activeWorkspaceId).catch((error) =>
				console.error("Failed to reconcile sessions", error),
			);
		};
		const queueRefresh = () => {
			if (refreshTimer !== undefined) window.clearTimeout(refreshTimer);
			refreshTimer = window.setTimeout(refresh, 120);
		};
		const hydrateThenRefresh = async () => {
			try {
				const cached = await listSessions(activeWorkspaceId);
				if (!disposed) replaceWorkspaceSessions(activeWorkspaceId, cached);
			} catch (error) {
				console.error("Failed to load cached sessions", error);
			}
			if (!disposed) refresh();
		};

		void hydrateThenRefresh();
		window.addEventListener("focus", queueRefresh);
		void listenRuntimeEvents((event) => {
			if (event.workspaceId && event.workspaceId !== activeWorkspaceId) {
				if (event.type === "assistant_message_end") {
					void refreshWorkspaceSessions(event.workspaceId).catch((error) =>
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
			if (event.workspaceId !== activeWorkspaceId) return;
			if (event.type === "changed") queueRefresh();
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
				await startSessionWatch(activeWorkspaceId);
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
			void stopSessionWatch(activeWorkspaceId).catch(() => undefined);
		};
	}, [activeWorkspaceId, refreshWorkspaceSessions, replaceWorkspaceSessions]);

	const sidebarSessions = useMemo(
		() => indexedSessions.map(toSidebarSession),
		[indexedSessions],
	);

	const selectedIndexedSession =
		indexedSessions.find(
			(session) => session.piSessionId === selectedSessionId,
		) ?? null;
	const selectedWorkspace = selectedIndexedSession
		? (workspaces.find(
				(workspace) => workspace.id === selectedIndexedSession.workspaceId,
			) ?? null)
		: null;
	const chatSession = useMemo<ChatSession | null>(
		() =>
			selectedIndexedSession && selectedWorkspace
				? indexedChatSession(selectedIndexedSession, selectedWorkspace)
				: activeWorkspace && draftSessionStarted
					? {
							id: draftSessionId,
							title: "新对话",
							workspaceRecord: activeWorkspace,
							initialModel: draftSessionModel ?? undefined,
							initialThinkingLevel: draftSessionThinkingLevel ?? undefined,
						}
					: null,
		[
			selectedIndexedSession,
			selectedWorkspace,
			activeWorkspace,
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

	const startNewChat = (workspaceId?: string) => {
		const targetWorkspaceId = workspaceId ?? firstWorkspace?.id ?? null;
		setDraftSessionStarted(false);
		setDraftSessionPrompt(null);
		setDraftSessionModel(null);
		setDraftSessionThinkingLevel(null);
		setDraftSessionId(createDraftSessionId());
		setDraftWorkspaceId(targetWorkspaceId);
		setSelectedSessionId(null);
		if (targetWorkspaceId) {
			void touchWorkspace(targetWorkspaceId)
				.then(() => notifyWorkspacesChanged())
				.catch((error) =>
					console.error("Failed to update recent workspace", error),
				);
		}
	};

	const selectSession = (sessionId: string) => {
		const session = indexedSessions.find(
			(candidate) => candidate.piSessionId === sessionId,
		);
		if (!session) return;
		const workspace = workspaces.find(
			(candidate) => candidate.id === session.workspaceId,
		);
		if (workspace) {
			const nextChat = indexedChatSession(session, workspace);
			setOpenedChats((current) => upsertOpenedChat(current, nextChat));
		}
		setSelectedSessionId(sessionId);
		setDraftSessionStarted(false);
		setDraftSessionPrompt(null);
		setDraftSessionModel(null);
		setDraftSessionThinkingLevel(null);
		setDraftWorkspaceId(session.workspaceId);
		void touchWorkspace(session.workspaceId)
			.then(() => notifyWorkspacesChanged())
			.catch((error) =>
				console.error("Failed to update recent workspace", error),
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
					workspaces={sidebarWorkspaces}
					sessions={sidebarSessions}
					selectedSessionId={selectedSessionId}
					onSelectSession={selectSession}
					onUpdateSession={(sessionId, update) => {
						void updateSession(sessionId, update);
					}}
					onArchiveWorkspaceSessions={(sessionIds) => {
						for (const sessionId of sessionIds) {
							void updateSession(sessionId, { archived: true });
						}
					}}
					onNewChat={() => startNewChat()}
					onNewChatInWorkspace={(workspaceId) => startNewChat(workspaceId)}
					onAddWorkspace={(connectionId) => {
						setAddWorkspaceConnectionId(connectionId ?? null);
						setAddWorkspaceOpen(true);
					}}
					onRefreshWorkspaceSessions={(workspaceId) => {
						void refreshWorkspaceSessions(workspaceId).catch((error) =>
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
									entry.session.workspaceRecord.id ===
										chatSession.workspaceRecord.id &&
									(entry.session.id === chatSession.id ||
										entry.piSessionId === chatSession.id);
								return (
									<div
										key={`${entry.session.workspaceRecord.id}:${entry.session.id}`}
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
															chat.session.workspaceRecord.id ===
																entry.session.workspaceRecord.id &&
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
													void refreshWorkspaceSessions(
														entry.session.workspaceRecord.id,
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
									key={`landing:${activeWorkspace?.id ?? "no-workspace"}:${draftSessionId}`}
									workspaceAvailable={Boolean(activeWorkspace)}
									workspace={activeWorkspace}
									onStartSession={(prompt, model, thinkingLevel) => {
										if (!activeWorkspace) return;
										const nextChat: ChatSession = {
											id: draftSessionId,
											title: "新对话",
											workspaceRecord: activeWorkspace,
											initialModel: model ?? undefined,
											initialThinkingLevel: thinkingLevel ?? undefined,
										};
										setOpenedChats((current) =>
											upsertOpenedChat(current, nextChat, prompt),
										);
										setDraftWorkspaceId(activeWorkspace.id);
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
							{activeWorkspace && editorRequest ? (
								<Suspense fallback={null}>
									<WorkspaceEditor
										key={`editor:${activeWorkspace.id}`}
										workspace={activeWorkspace}
										request={
											editorRequest?.workspaceId === activeWorkspace.id
												? editorRequest
												: undefined
										}
										visible={
											editorVisible &&
											editorRequest?.workspaceId === activeWorkspace.id
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
								workspace={activeWorkspace ?? undefined}
								onOpenFile={openEditorFile}
							/>
						</Suspense>
					</Group>
				</main>
			</div>
			{addWorkspaceOpen ? (
				<AddWorkspaceDialog
					open
					onOpenChange={setAddWorkspaceOpen}
					initialConnectionId={addWorkspaceConnectionId}
				/>
			) : null}
		</TooltipProvider>
	);
}

export default App;

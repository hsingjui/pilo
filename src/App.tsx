import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Group,
	Panel,
	Separator as ResizeSeparator,
	type PanelImperativeHandle,
} from "react-resizable-panels";

import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { AddWorkspaceDialog } from "@/components/sidebar/add-workspace-dialog";
import type { SidebarSession } from "@/components/sidebar/types";
import { ChatPage, type ChatSession } from "@/components/chat/chat-page";
import { NewChatLanding } from "@/components/new-chat-landing";
import { RightSidebar } from "@/components/right-sidebar";
import { SidebarFooter } from "@/components/sidebar-footer";
import { CUSTOM_TITLEBAR, TitleBar } from "@/components/title-bar";
import { listenRuntimeEvents } from "@/lib/pi-runtime";
import {
	listSessions,
	reconcileSessions,
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

let draftSessionSequence = 0;

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

function App() {
	const rightPanelRef = useRef<PanelImperativeHandle>(null);
	const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
	const [isResizing, setIsResizing] = useState(false);
	const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
	const [indexedSessions, setIndexedSessions] = useState<SessionIndexEntry[]>(
		[],
	);
	const [draftSessionPrompt, setDraftSessionPrompt] = useState<string | null>(
		null,
	);
	const [draftSessionId, setDraftSessionId] = useState(createDraftSessionId);
	const [draftWorkspaceId, setDraftWorkspaceId] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);
	const [addWorkspaceOpen, setAddWorkspaceOpen] = useState(false);
	const [addWorkspaceConnectionId, setAddWorkspaceConnectionId] = useState<
		string | null
	>(null);

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const next = await listWorkspaces();
				if (active) setWorkspaces(next);
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
		let unlistenRuntime: (() => void) | undefined;

		const refresh = () => {
			void refreshWorkspaceSessions(activeWorkspaceId).catch((error) =>
				console.error("Failed to reconcile sessions", error),
			);
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
		window.addEventListener("focus", refresh);
		void listenRuntimeEvents((event) => {
			if (
				event.type === "assistant_message_end" ||
				(event.type === "process_state" && event.state === "running")
			) {
				refresh();
			}
		})
			.then((unlisten) => {
				if (disposed) unlisten();
				else unlistenRuntime = unlisten;
			})
			.catch((error) =>
				console.error("Failed to listen for runtime events", error),
			);
		return () => {
			disposed = true;
			window.removeEventListener("focus", refresh);
			unlistenRuntime?.();
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
	const chatSession: ChatSession | null =
		selectedIndexedSession && selectedWorkspace
			? {
					id: selectedIndexedSession.piSessionId,
					title:
						selectedIndexedSession.titleOverride ??
						selectedIndexedSession.name ??
						selectedIndexedSession.firstUserMessagePreview ??
						"新对话",
					workspaceRecord: selectedWorkspace,
					sessionPath: selectedIndexedSession.sessionPath,
				}
			: activeWorkspace && draftSessionPrompt !== null
				? {
						id: draftSessionId,
						title: "新对话",
						workspaceRecord: activeWorkspace,
					}
				: null;

	const startNewChat = (workspaceId?: string) => {
		const targetWorkspaceId = workspaceId ?? firstWorkspace?.id ?? null;
		setDraftSessionPrompt(null);
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
		setSelectedSessionId(sessionId);
		setDraftSessionPrompt(null);
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
						<Panel defaultSize={560} minSize={400} className="min-w-0">
							{chatSession ? (
								<ChatPage
									session={chatSession}
									initialMessage={draftSessionPrompt ?? undefined}
									onOpenChanges={() => rightPanelRef.current?.expand()}
									onExpandSidebar={() => setLeftSidebarCollapsed(false)}
									reserveWindowControls={CUSTOM_TITLEBAR}
									sidebarCollapsed={leftSidebarCollapsed}
								/>
							) : (
								<NewChatLanding
									workspaceAvailable={Boolean(activeWorkspace)}
									onStartSession={(prompt) => {
										if (!activeWorkspace) return;
										setDraftWorkspaceId(activeWorkspace.id);
										setDraftSessionPrompt(prompt);
									}}
									onExpandSidebar={() => setLeftSidebarCollapsed(false)}
									reserveWindowControls={CUSTOM_TITLEBAR}
									sidebarCollapsed={leftSidebarCollapsed}
								/>
							)}
						</Panel>
						<ResizeSeparator
							className="w-1 bg-transparent transition-colors hover:bg-sidebar-border"
							onPointerDown={() => setIsResizing(true)}
							onPointerUp={() => setIsResizing(false)}
							onPointerCancel={() => setIsResizing(false)}
						/>
						<RightSidebar panelRef={rightPanelRef} resizing={isResizing} />
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

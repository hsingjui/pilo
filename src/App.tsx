import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	Group,
	Panel,
	Separator as ResizeSeparator,
	type PanelImperativeHandle,
} from "react-resizable-panels";

import { AppSidebar } from "@/components/sidebar/app-sidebar";
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
		title: session.name ?? session.firstUserMessagePreview ?? "新对话",
		workspaceId: session.workspaceId,
		latestMessageAt: sessionDate(session),
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

	const chatSession: ChatSession | null =
		activeWorkspace && draftSessionPrompt !== null
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
		if (targetWorkspaceId) {
			void touchWorkspace(targetWorkspaceId)
				.then(() => notifyWorkspacesChanged())
				.catch((error) =>
					console.error("Failed to update recent workspace", error),
				);
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
					onNewChat={() => startNewChat()}
					onNewChatInWorkspace={(workspaceId) => startNewChat(workspaceId)}
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
		</TooltipProvider>
	);
}

export default App;

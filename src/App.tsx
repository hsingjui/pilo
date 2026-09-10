import { useRef, useState } from "react";
import {
	Group,
	Panel,
	Separator as ResizeSeparator,
	type PanelImperativeHandle,
} from "react-resizable-panels";

import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { ChatPage, type ChatSession } from "@/components/chat/chat-page";
import { NewChatLanding } from "@/components/new-chat-landing";
import { RightSidebar } from "@/components/right-sidebar";
import { SidebarFooter } from "@/components/sidebar-footer";
import { CUSTOM_TITLEBAR, TitleBar } from "@/components/title-bar";
import { TooltipProvider } from "@/ui";

const HOUR = 60 * 60 * 1000;

// 模板占位数据：接入 Pi RPC 后由真实 session / workspace 状态替换。
const PLACEHOLDER_ENVS = [{ id: "local", name: "本地" }];
const PLACEHOLDER_WORKSPACES = [
	{ id: "pilo", name: "pilo", path: "/root/code/pilo", envId: "local" },
];
const INITIAL_PLACEHOLDER_SESSIONS = [
	{
		id: "s1",
		title: "初始化前端风格体系",
		workspaceId: "pilo",
		latestMessageAt: new Date(Date.now() - 1 * HOUR),
		active: true,
	},
	{
		id: "s2",
		title: "连接管理实现讨论",
		workspaceId: "pilo",
		latestMessageAt: new Date(Date.now() - 3 * HOUR),
		active: true,
	},
	{
		id: "s3",
		title: "Pi RPC 接入方案",
		workspaceId: "pilo",
		latestMessageAt: new Date(Date.now() - 21 * HOUR),
	},
	{
		id: "s4",
		title: "Workspace 索引设计",
		workspaceId: "pilo",
		latestMessageAt: new Date(Date.now() - 2 * 24 * HOUR),
	},
	{
		id: "s5",
		title: "远程开发环境调研",
		workspaceId: "pilo",
		latestMessageAt: new Date(Date.now() - 4 * 24 * HOUR),
	},
	{
		id: "s6",
		title: "会话列表持久化",
		workspaceId: "pilo",
		latestMessageAt: new Date(Date.now() - 6 * 24 * HOUR),
	},
];

function Sidebar({
	collapsed,
	onToggle,
	selectedSessionId,
	onSelectSession,
	onNewChat,
}: {
	collapsed: boolean;
	onToggle: () => void;
	selectedSessionId: string | null;
	onSelectSession: (sessionId: string) => void;
	onNewChat: () => void;
}) {
	const [sessions, setSessions] = useState(INITIAL_PLACEHOLDER_SESSIONS);
	return (
		<AppSidebar
			collapsed={collapsed}
			onCollapse={onToggle}
			envs={PLACEHOLDER_ENVS}
			workspaces={PLACEHOLDER_WORKSPACES}
			sessions={sessions}
			selectedSessionId={selectedSessionId}
			onSelectSession={onSelectSession}
			onNewChat={onNewChat}
			onNewChatInWorkspace={onNewChat}
			onArchiveSession={(sessionId) =>
				setSessions((prev) =>
					prev.filter((session) => session.id !== sessionId),
				)
			}
			onArchiveWorkspaceSessions={(sessionIds) =>
				setSessions((prev) =>
					prev.filter((session) => !sessionIds.includes(session.id)),
				)
			}
			footer={<SidebarFooter />}
		/>
	);
}

function App() {
	const rightPanelRef = useRef<PanelImperativeHandle>(null);
	const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
	const [isResizing, setIsResizing] = useState(false);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		"s1",
	);
	const [draftSessionPrompt, setDraftSessionPrompt] = useState<string | null>(
		null,
	);

	const selectedSession = INITIAL_PLACEHOLDER_SESSIONS.find(
		(session) => session.id === selectedSessionId,
	);
	const chatSession: ChatSession | null = selectedSession
		? {
				id: selectedSession.id,
				title: selectedSession.title,
				workspace: "pilo",
				workspacePath: ".",
				environment: "本地",
				branch: "main",
			}
		: draftSessionPrompt !== null
			? {
					id: "draft-session",
					title: "新对话",
					workspace: "pilo",
					workspacePath: ".",
					environment: "本地",
					branch: "main",
				}
			: null;

	return (
		<TooltipProvider>
			<div className="flex h-full bg-background text-foreground">
				<Sidebar
					collapsed={leftSidebarCollapsed}
					onToggle={() => setLeftSidebarCollapsed(true)}
					selectedSessionId={selectedSessionId}
					onSelectSession={(sessionId) => {
						setDraftSessionPrompt(null);
						setSelectedSessionId(sessionId);
					}}
					onNewChat={() => {
						setSelectedSessionId(null);
						setDraftSessionPrompt(null);
					}}
				/>
				<main className="relative flex min-w-0 flex-1 flex-col">
					{CUSTOM_TITLEBAR && <TitleBar />}
					<Group orientation="horizontal" className="min-h-0 flex-1">
						<Panel defaultSize={560} minSize={400} className="min-w-0">
							{chatSession ? (
								<ChatPage
									session={chatSession}
									initialMessage={
										selectedSession
											? undefined
											: (draftSessionPrompt ?? undefined)
									}
									onOpenChanges={() => rightPanelRef.current?.expand()}
									onExpandSidebar={() => setLeftSidebarCollapsed(false)}
									reserveWindowControls={CUSTOM_TITLEBAR}
									sidebarCollapsed={leftSidebarCollapsed}
								/>
							) : (
								<NewChatLanding
									onStartSession={(prompt) => setDraftSessionPrompt(prompt)}
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

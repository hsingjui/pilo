import type { ReactNode } from "react";

export type SidebarEnv = { id: string; name: string };

export type SidebarWorkspace = {
	id: string;
	name: string;
	path: string;
	envId: string;
};

export type SidebarSession = {
	id: string;
	title: string;
	preview: string | null;
	sessionPath: string;
	workspaceId: string;
	latestMessageAt: Date;
	pinned: boolean;
	archived: boolean;
	/** Agent 正在运行 / 有未读消息时在行尾显示状态点。 */
	active?: boolean;
};

export type AppSidebarProps = {
	envs: SidebarEnv[];
	workspaces: SidebarWorkspace[];
	sessions: SidebarSession[];
	/** 由 App 控制的整体收起（宽度过渡动画）。 */
	collapsed?: boolean;
	onCollapse?: () => void;
	onUpdateSession?: (
		sessionId: string,
		update: { pinned?: boolean; archived?: boolean; title?: string },
	) => void;
	onArchiveWorkspaceSessions?: (sessionIds: string[]) => void;
	onRefreshWorkspaceSessions?: (workspaceId: string) => void;
	selectedSessionId?: string | null;
	onSelectSession?: (sessionId: string) => void;
	onNewChat?: () => void;
	onNewChatInWorkspace?: (workspaceId: string) => void;
	onAddWorkspace?: (connectionId?: string) => void;
	/** 底部操作区（设置 / 帮助 / 主题等），由 App 组合。 */
	footer?: ReactNode;
};

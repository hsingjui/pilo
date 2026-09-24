import type { ReactNode } from "react";

export type SidebarEnv = { id: string; name: string };

/** 侧栏组织模式：按连接分组的“项目”树，或平铺的“最近会话”会话列表。 */
export type SidebarEnvView = "projects" | "recent";

export type SidebarProject = {
	id: string;
	name: string;
	path: string;
	envId: string;
	connectionType: "local" | "wsl" | "ssh";
};

export type SidebarSession = {
	id: string;
	title: string;
	preview: string | null;
	sessionPath: string;
	projectId: string;
	latestMessageAt: Date;
	/** Agent 正在运行时在行尾显示加载状态。 */
	active?: boolean;
	externalActive?: boolean;
};

export type AppSidebarProps = {
	envs: SidebarEnv[];
	projects: SidebarProject[];
	sessions: SidebarSession[];
	/** 由 App 控制的整体收起（宽度过渡动画）。 */
	collapsed?: boolean;
	onCollapse?: () => void;
	onUpdateSession?: (sessionId: string, update: { title?: string }) => void;
	onDeleteSession?: (sessionId: string) => void;
	onRefreshProjectSessions?: (projectId: string) => void;
	refreshingProjectIds?: ReadonlySet<string>;
	/** 重新获取连接、项目与会话。 */
	onRefresh?: () => void;
	/** 整体刷新进行中：显示骨架动画。 */
	refreshing?: boolean;
	selectedProjectId?: string | null;
	selectedSessionId?: string | null;
	/** 侧栏组织模式：按项目分组（默认）或“最近会话”平铺列表。 */
	organizeMode?: SidebarEnvView;
	onOrganizeModeChange?: (mode: SidebarEnvView) => void;
	/** “最近会话”模式下会话行是否显示所属项目名。 */
	showProjectsInRecents?: boolean;
	onShowProjectsInRecentsChange?: (showProjects: boolean) => void;
	onSelectSession?: (sessionId: string) => void;
	onOpenSearchSession?: (target: {
		sessionId: string;
		projectId: string;
		sessionPath: string;
		title: string;
	}) => void;
	onNewChat?: () => void;
	onNewChatInProject?: (projectId: string) => void;
	onFocusProject?: (projectId: string) => void;
	onReorderProjects?: (connectionId: string, projectIds: string[]) => void;
	onDeleteProject?: (projectId: string) => void;
	onDeleteConnection?: (connectionId: string) => void;
	onAddProject?: (connectionId?: string) => void;
	/** 底部操作区（设置 / 帮助 / 主题等），由 App 组合。 */
	footer?: ReactNode;
};

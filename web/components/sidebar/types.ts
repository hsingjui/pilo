import type { ReactNode } from "react";

import type { PiloClient } from "@shared/api/pilo-client";

import type {
	SidebarEnv,
	SidebarEnvView,
	SidebarProject,
	SidebarSession,
} from "@shared/sidebar/sidebar-types";

export type {
	SidebarEnv,
	SidebarEnvView,
	SidebarProject,
	SidebarSession,
} from "@shared/sidebar/sidebar-types";

export type AppSidebarProps = {
	/** Session search in the command palette; the palette is hidden without it. */
	client?: PiloClient | null;
	envs: SidebarEnv[];
	projects: SidebarProject[];
	sessions: SidebarSession[];
	/** 由 App 控制的整体收起（宽度过渡动画）。 */
	collapsed?: boolean;
	onCollapse?: () => void;
	onUpdateSession?: (
		sessionId: string,
		update: { title?: string },
		projectId: string,
	) => void;
	onDeleteSession?: (sessionId: string, projectId: string) => void;
	onRefreshSession?: (sessionId: string, projectId: string) => Promise<void>;
	onRefreshProjectSessions?: (projectId: string) => void;
	refreshingProjectIds?: ReadonlySet<string>;
	selectedProjectId?: string | null;
	selectedSessionId?: string | null;
	/** 侧栏组织模式：按项目分组（默认）或“最近会话”平铺列表。 */
	organizeMode?: SidebarEnvView;
	onOrganizeModeChange?: (mode: SidebarEnvView) => void;
	/** “最近会话”模式下会话行是否显示所属项目名。 */
	showProjectsInRecents?: boolean;
	onShowProjectsInRecentsChange?: (showProjects: boolean) => void;
	onSelectSession?: (sessionId: string, projectId: string) => void;
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

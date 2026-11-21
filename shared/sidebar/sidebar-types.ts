export type SidebarEnv = {
	id: string;
	name: string;
	onConfigureLocalPiResources?: () => void;
};

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
	/** Agent 运行完成但用户尚未打开该会话时显示未读标记，点进去即清除。 */
	unread?: boolean;
	/** 进入运行状态的时刻；运行中的会话用它在组内保持稳定排序，避免随消息流来回跳动。 */
	runningSince?: Date;
};

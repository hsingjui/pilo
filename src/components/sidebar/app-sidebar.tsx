/* oxlint-disable jsx-a11y/prefer-tag-over-role -- 宽度拖拽手柄是垂直分割线，role=separator 语义正确，无对应语义 HTML 元素 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { PanelLeft, RefreshCw, Search, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePreferences } from "@/lib/preferences-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { IS_MACOS } from "@/components/title-bar";
import { CommandPalette } from "@/components/command-palette";
import { ProjectSessionsToolbar } from "./project-sessions-toolbar";
import { SidebarTree } from "./sidebar-tree";
import {
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
	useSidebarLayout,
} from "./use-sidebar-layout";
import {
	sortSidebarSessionsActiveFirst,
	sortSidebarSessionsByRecency,
} from "./session-list";
import type {
	AppSidebarProps,
	SidebarEnv,
	SidebarEnvView,
	SidebarSession,
	SidebarProject,
} from "./types";

export type { AppSidebarProps, SidebarEnv, SidebarSession, SidebarProject };

// ---- 侧边栏 ---------------------------------------------------------------

/** 环境/项目折叠状态持久化 key。 */
const COLLAPSED_SECTIONS_STORAGE_KEY = "pilo.collapsedSections";

/** 侧栏组织模式持久化 key（Lody 的 sidebarOrganizeModeAtom 等价实现）。 */
const ORGANIZE_MODE_STORAGE_KEY = "pilo.sidebarOrganizeMode";

/** “最近会话”视图是否在会话行下展示项目名。 */
const SHOW_PROJECTS_IN_RECENTS_STORAGE_KEY =
	"pilo.sidebarShowProjectsInRecents";

/** “最近会话”视图最多展示的会话数。 */
const ENV_RECENT_SESSION_LIMIT = 50;
const EMPTY_REFRESHING_PROJECT_IDS: ReadonlySet<string> = new Set();

function readCollapsedSections(): Record<string, boolean> {
	try {
		const stored = window.localStorage.getItem(COLLAPSED_SECTIONS_STORAGE_KEY);
		return stored ? (JSON.parse(stored) as Record<string, boolean>) : {};
	} catch {
		return {};
	}
}

function readOrganizeMode(): SidebarEnvView {
	try {
		const stored = window.localStorage.getItem(ORGANIZE_MODE_STORAGE_KEY);
		return stored === "recent" ? "recent" : "projects";
	} catch {
		return "projects";
	}
}

function readShowProjectsInRecents(): boolean {
	return (
		window.localStorage.getItem(SHOW_PROJECTS_IN_RECENTS_STORAGE_KEY) === "1"
	);
}

export function AppSidebar({
	envs,
	projects,
	sessions,
	collapsed = false,
	onCollapse,
	onUpdateSession,
	onDeleteSession,
	onRefreshProjectSessions,
	refreshingProjectIds = EMPTY_REFRESHING_PROJECT_IDS,
	onRefresh,
	refreshing = false,
	selectedProjectId,
	selectedSessionId,
	onSelectSession,
	onOpenSearchSession,
	onNewChat,
	onNewChatInProject,
	onFocusProject,
	onReorderProjects,
	onDeleteProject,
	onDeleteConnection,
	onAddProject,
	footer,
}: AppSidebarProps) {
	const [paletteOpen, setPaletteOpen] = useState(false);
	const { t } = useTranslation();
	const [projectSessionsViewId, setProjectSessionsViewId] = useState<
		string | null
	>(null);
	const { keyboardShortcuts } = usePreferences();
	useKeyboardShortcut(keyboardShortcuts["open-command-palette"], () =>
		setPaletteOpen((open) => !open),
	);
	const [collapsedSections, setCollapsedSections] = useState<
		Record<string, boolean>
	>(readCollapsedSections);
	const [organizeMode, setOrganizeMode] =
		useState<SidebarEnvView>(readOrganizeMode);
	const [showProjectsInRecents, setShowProjectsInRecents] = useState(
		readShowProjectsInRecents,
	);
	const [internalSelectedSessionId, setInternalSelectedSessionId] = useState<
		string | null
	>(null);
	const activeSessionId =
		selectedSessionId === undefined
			? internalSelectedSessionId
			: selectedSessionId;
	const onSelectSessionRef = useRef(onSelectSession);
	const onUpdateSessionRef = useRef(onUpdateSession);
	const onDeleteSessionRef = useRef(onDeleteSession);
	useEffect(() => {
		onSelectSessionRef.current = onSelectSession;
		onUpdateSessionRef.current = onUpdateSession;
		onDeleteSessionRef.current = onDeleteSession;
	}, [onDeleteSession, onSelectSession, onUpdateSession]);

	// 拖拽右边缘调整宽度；拖到最小宽度以下即折叠。
	const {
		asideRef,
		settledCollapsed,
		sidebarWidth,
		resizing,
		startResize,
		handleResizeKeyDown,
	} = useSidebarLayout({ collapsed, onCollapse });
	const scrollViewportRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const viewport = scrollViewportRef.current;
		if (!viewport) return;

		const stopBoundaryBounce = (event: WheelEvent) => {
			if (event.ctrlKey || event.deltaY === 0) return;
			const maxScrollTop = Math.max(
				0,
				viewport.scrollHeight - viewport.clientHeight,
			);
			if (maxScrollTop <= 0) {
				event.preventDefault();
				return;
			}

			const atTop = viewport.scrollTop <= 0.5;
			const atBottom = viewport.scrollTop >= maxScrollTop - 0.5;
			if ((event.deltaY < 0 && atTop) || (event.deltaY > 0 && atBottom)) {
				event.preventDefault();
			}
		};

		viewport.addEventListener("wheel", stopBoundaryBounce, { passive: false });
		return () => viewport.removeEventListener("wheel", stopBoundaryBounce);
	}, []);

	useEffect(() => {
		window.localStorage.setItem(
			COLLAPSED_SECTIONS_STORAGE_KEY,
			JSON.stringify(collapsedSections),
		);
	}, [collapsedSections]);

	useEffect(() => {
		window.localStorage.setItem(ORGANIZE_MODE_STORAGE_KEY, organizeMode);
	}, [organizeMode]);

	useEffect(() => {
		window.localStorage.setItem(
			SHOW_PROJECTS_IN_RECENTS_STORAGE_KEY,
			showProjectsInRecents ? "1" : "0",
		);
	}, [showProjectsInRecents]);

	/** 切换组织模式；切回“项目”时清掉二级视图，避免残留旧状态。 */
	const changeOrganizeMode = useCallback((mode: SidebarEnvView) => {
		setOrganizeMode(mode);
		if (mode === "projects") {
			setProjectSessionsViewId(null);
		}
		if (mode === "recent") {
			setProjectSessionsViewId(null);
		}
	}, []);

	const toggleSection = useCallback((key: string, defaultCollapsed = false) => {
		setCollapsedSections((prev) => ({
			...prev,
			[key]: !(prev[key] ?? defaultCollapsed),
		}));
	}, []);

	const projectsByEnv = useMemo(() => {
		const grouped = new Map<string, SidebarProject[]>();
		for (const project of projects) {
			const items = grouped.get(project.envId);
			if (items) items.push(project);
			else grouped.set(project.envId, [project]);
		}
		return grouped;
	}, [projects]);

	// “最近会话”视图：全部连接的会话合并为一条平铺列表，按更新时间排序。
	const recentSessions = useMemo(() => {
		if (organizeMode !== "recent") return [];
		return sortSidebarSessionsActiveFirst(sessions).slice(
			0,
			ENV_RECENT_SESSION_LIMIT,
		);
	}, [organizeMode, sessions]);

	const sessionsByProject = useMemo(() => {
		const grouped = new Map<string, SidebarSession[]>();
		for (const session of sessions) {
			const items = grouped.get(session.projectId);
			if (items) items.push(session);
			else grouped.set(session.projectId, [session]);
		}
		return grouped;
	}, [sessions]);
	const projectById = useMemo(
		() => new Map(projects.map((project) => [project.id, project.name])),
		[projects],
	);
	const projectSessionsViewProject = useMemo(
		() =>
			projectSessionsViewId
				? (projects.find((project) => project.id === projectSessionsViewId) ??
					null)
				: null,
		[projectSessionsViewId, projects],
	);
	const projectSessionsViewSessions = useMemo(() => {
		if (!projectSessionsViewId) return [];
		return sortSidebarSessionsByRecency(
			sessionsByProject.get(projectSessionsViewId) ?? [],
		);
	}, [projectSessionsViewId, sessionsByProject]);

	const resetSidebarScroll = useCallback(() => {
		window.requestAnimationFrame(() => {
			if (scrollViewportRef.current) scrollViewportRef.current.scrollTop = 0;
		});
	}, []);
	const openProjectSessionsView = useCallback(
		(projectId: string) => {
			setProjectSessionsViewId(projectId);
			resetSidebarScroll();
			onRefreshProjectSessions?.(projectId);
		},
		[onRefreshProjectSessions, resetSidebarScroll],
	);
	const closeProjectSessionsView = useCallback(() => {
		setProjectSessionsViewId(null);
		resetSidebarScroll();
	}, [resetSidebarScroll]);

	const handleSelectSession = useCallback(
		(sessionId: string) => {
			if (selectedSessionId === undefined) {
				setInternalSelectedSessionId(sessionId);
			}
			onSelectSessionRef.current?.(sessionId);
		},
		[selectedSessionId],
	);
	const handleRenameSession = useCallback(
		(id: string, title: string) => onUpdateSessionRef.current?.(id, { title }),
		[],
	);
	const handleDeleteSession = useCallback(
		(id: string) => onDeleteSessionRef.current?.(id),
		[],
	);

	return (
		<>
			<aside
				ref={asideRef}
				style={collapsed ? undefined : { width: sidebarWidth }}
				className={cn(
					"relative h-full shrink-0 transition-[width,opacity] duration-200 ease-out motion-reduce:transition-none",
					// 拖拽时关闭宽度过渡，避免动画跟不上指针（与右侧 Panel 一致）
					resizing && "transition-none",
					collapsed
						? "w-0 overflow-hidden opacity-0"
						: "overflow-visible opacity-100",
				)}
			>
				<div className="relative mb-2 ml-2 mr-1 mt-2 flex h-[calc(100%_-_1rem)] w-[calc(100%-12px)] flex-col overflow-hidden rounded-xl border border-sidebar-border/80 bg-sidebar p-[2px] text-sidebar-foreground shadow-sm">
					<header
						data-tauri-drag-region="deep"
						className={cn(
							"group/sidebar-header relative flex shrink-0 items-center px-1.5",
							IS_MACOS ? "h-[72px] pt-7" : "h-11",
						)}
					>
						<div className="flex min-w-0 items-center gap-1.5 px-2">
							<span className="min-w-0 select-none truncate text-lg font-semibold tracking-tight text-sidebar-foreground">
								Pilo
							</span>
							{import.meta.env.DEV ? (
								<span className="inline-flex shrink-0 select-none items-center gap-1 rounded-full bg-primary/10 px-1.5 py-[1px] text-[10px] font-semibold uppercase leading-4 tracking-wide text-primary">
									<span className="size-1.5 animate-pulse rounded-full bg-primary motion-reduce:animate-none" />
									DEV
								</span>
							) : null}
						</div>
						{!collapsed && !settledCollapsed ? (
							<div
								className={cn(
									"absolute right-1.5 flex items-center gap-0.5",
									// 与 TRAFFIC_LIGHT_ALIGNED_HEADER 同一红绿灯圆心：11 - 2 + 14 = 23
									IS_MACOS ? "-top-0.5" : "top-2",
								)}
							>
								<button
									type="button"
									className="flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
									aria-label={t("sidebar.searchSessions")}
									onClick={() => setPaletteOpen(true)}
								>
									<Search className="h-4 w-4" />
								</button>
								<button
									type="button"
									className="flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
									aria-label={t("sidebar.collapseSidebar")}
									onClick={() => onCollapse?.()}
								>
									<PanelLeft className="h-4 w-4" />
								</button>
							</div>
						) : null}
					</header>
					<div className="-mt-1 flex shrink-0 flex-col gap-1 px-1.5">
						{projectSessionsViewProject ? (
							<ProjectSessionsToolbar
								project={projectSessionsViewProject}
								onBack={closeProjectSessionsView}
								onNewChat={onNewChatInProject}
							/>
						) : (
							<div className="flex items-center gap-1">
								<button
									type="button"
									className="group flex min-w-0 flex-1 select-none items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-sm text-sidebar-foreground outline-hidden transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring dark:text-sidebar-foreground/75"
									onClick={() => onNewChat?.()}
								>
									<span className="flex h-4 w-4 shrink-0 items-center justify-center text-current">
										<SquarePen className="h-4 w-4" />
									</span>
									<span className="truncate">{t("sidebar.newSession")}</span>
								</button>
								<button
									type="button"
									className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring disabled:opacity-50"
									aria-label={t("sidebar.refreshSidebar")}
									onClick={() => onRefresh?.()}
									disabled={refreshing}
								>
									<RefreshCw
										className={cn("h-4 w-4", refreshing && "animate-spin")}
									/>
								</button>
							</div>
						)}
					</div>
					<SidebarTree
						scrollViewportRef={scrollViewportRef}
						refreshing={refreshing}
						organizeMode={organizeMode}
						onOrganizeModeChange={changeOrganizeMode}
						collapsedSections={collapsedSections}
						onToggleSection={toggleSection}
						showProjectsInRecents={showProjectsInRecents}
						onShowProjectsInRecentsChange={setShowProjectsInRecents}
						recentSessions={recentSessions}
						projectSessionsViewProject={projectSessionsViewProject}
						projectSessionsViewSessions={projectSessionsViewSessions}
						onOpenProjectSessionsView={openProjectSessionsView}
						projectById={projectById}
						activeSessionId={activeSessionId}
						selectedProjectId={selectedProjectId}
						envs={envs}
						projectsByEnv={projectsByEnv}
						sessionsByProject={sessionsByProject}
						refreshingProjectIds={refreshingProjectIds}
						onFocusProject={onFocusProject}
						onNewChatInProject={onNewChatInProject}
						onDeleteProject={onDeleteProject}
						onAddProject={onAddProject}
						onDeleteConnection={onDeleteConnection}
						onRefreshProjectSessions={onRefreshProjectSessions}
						onReorderProjects={onReorderProjects}
						onSelectSession={handleSelectSession}
						onRenameSession={handleRenameSession}
						onDeleteSession={handleDeleteSession}
					/>
					<footer className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-1.5 py-1">
						{footer}
					</footer>
				</div>
				{/* 折叠时侧栏宽为 0，手柄没有可拖的内容，也不该出现在 Tab 顺序里。 */}
				{collapsed ? null : (
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label={t("sidebar.adjustSidebar")}
						tabIndex={0}
						aria-valuemin={MIN_SIDEBAR_WIDTH}
						aria-valuemax={MAX_SIDEBAR_WIDTH}
						aria-valuenow={Math.round(sidebarWidth)}
						onPointerDown={startResize}
						onKeyDown={handleResizeKeyDown}
						className={cn(
							"absolute -right-0.5 top-2 z-20 h-[calc(100%-1rem)] w-3 cursor-col-resize bg-transparent",
							"focus-visible:outline-hidden",
							"after:absolute after:right-[5px] after:top-3 after:bottom-3 after:w-[2px] after:rounded-full after:bg-transparent",
							resizing
								? "after:bg-sidebar-ring/70"
								: "hover:after:bg-sidebar-ring/50 focus-visible:after:bg-sidebar-ring",
						)}
					/>
				)}
			</aside>
			{paletteOpen ? (
				<CommandPalette
					open
					onOpenChange={setPaletteOpen}
					projects={projects}
					sessions={sessions}
					onSelectProject={(projectId) => onNewChatInProject?.(projectId)}
					onSelectSession={(target) =>
						onOpenSearchSession
							? onOpenSearchSession(target)
							: handleSelectSession(target.sessionId)
					}
				/>
			) : null}
		</>
	);
}

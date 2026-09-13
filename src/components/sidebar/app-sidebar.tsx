/* oxlint-disable jsx-a11y/prefer-tag-over-role -- 宽度拖拽手柄是垂直分割线，role=separator 语义正确，无对应语义 HTML 元素 */
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { Archive, PanelLeft, Search, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, ScrollArea } from "@/ui";
import { IS_MACOS } from "@/components/title-bar";
import { EnvRow, SessionRow, ProjectRow } from "./rows";
import {
	AppSidebarProps,
	SidebarEnv,
	SidebarSession,
	SidebarProject,
} from "./types";

export type { AppSidebarProps, SidebarEnv, SidebarSession, SidebarProject };

// ---- 侧边栏 ---------------------------------------------------------------

/** 侧栏最小宽度：低于该值拖拽视为折叠（拖到 MIN 后调用 onCollapse）。 */
const MIN_SIDEBAR_WIDTH = 240;

/** 侧栏最大宽度。 */
const MAX_SIDEBAR_WIDTH = 480;

/** 侧栏默认宽度。 */
const DEFAULT_SIDEBAR_WIDTH = 292;

/** 侧栏宽度持久化 key。 */
const SIDEBAR_WIDTH_STORAGE_KEY = "pilo.sidebarWidth";

const VirtualSessionRows = lazy(() =>
	import("./virtual-session-rows").then((module) => ({
		default: module.VirtualSessionRows,
	})),
);

export function AppSidebar({
	envs,
	projects,
	sessions,
	collapsed = false,
	onCollapse,
	onUpdateSession,
	onArchiveProjectSessions,
	onRefreshProjectSessions,
	selectedSessionId,
	onSelectSession,
	onNewChat,
	onNewChatInProject,
	onAddProject,
	footer,
}: AppSidebarProps) {
	const [searchQuery, setSearchQuery] = useState("");
	const [showArchived, setShowArchived] = useState(false);
	const [collapsedSections, setCollapsedSections] = useState<
		Record<string, boolean>
	>({});
	const [internalSelectedSessionId, setInternalSelectedSessionId] = useState<
		string | null
	>(null);
	const activeSessionId =
		selectedSessionId === undefined
			? internalSelectedSessionId
			: selectedSessionId;
	// 相对时间标签共享一个低频时钟，避免每行各自定时刷新。
	const [now, setNow] = useState(() => new Date());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(new Date()), 60_000);
		return () => window.clearInterval(timer);
	}, []);

	// 拖拽右边缘调整宽度；拖到最小宽度以下即折叠。
	const asideRef = useRef<HTMLElement>(null);
	const scrollViewportRef = useRef<HTMLDivElement>(null);
	const [sidebarWidth, setSidebarWidth] = useState(() => {
		const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
		if (!stored) return DEFAULT_SIDEBAR_WIDTH;
		const parsed = Number.parseInt(stored, 10);
		if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH;
		return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, parsed));
	});
	const [resizing, setResizing] = useState(false);

	useEffect(() => {
		window.localStorage.setItem(
			SIDEBAR_WIDTH_STORAGE_KEY,
			String(sidebarWidth),
		);
	}, [sidebarWidth]);

	const startResize = useCallback(
		(event: ReactPointerEvent) => {
			event.preventDefault();
			const aside = asideRef.current;
			if (!aside) return;
			const startX = event.clientX;
			const startWidth = aside.getBoundingClientRect().width;
			// 折叠需要比最小宽度再小一截才触发（滞后带），
			// 避免在最小宽度时按下/轻微抖动就误折叠、无法向外拖。
			const collapseAt = MIN_SIDEBAR_WIDTH - 8;
			const handleMove = (moveEvent: PointerEvent) => {
				const rawWidth = startWidth + (moveEvent.clientX - startX);
				if (rawWidth <= collapseAt) {
					setSidebarWidth(MIN_SIDEBAR_WIDTH);
					onCollapse?.();
					cleanup();
					return;
				}
				setSidebarWidth(
					Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, rawWidth)),
				);
			};
			const cleanup = () => {
				window.removeEventListener("pointermove", handleMove);
				window.removeEventListener("pointerup", cleanup);
				window.removeEventListener("pointercancel", cleanup);
				document.body.classList.remove("select-none");
				setResizing(false);
			};
			window.addEventListener("pointermove", handleMove);
			window.addEventListener("pointerup", cleanup);
			window.addEventListener("pointercancel", cleanup);
			document.body.classList.add("select-none");
			setResizing(true);
		},
		[onCollapse],
	);

	const toggleSection = useCallback((key: string) => {
		setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
	}, []);

	const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
	const searchableSessions = useMemo(
		() =>
			sessions.map((session) => ({
				session,
				searchText: [session.title, session.preview ?? "", session.sessionPath]
					.join("\n")
					.toLocaleLowerCase(),
			})),
		[sessions],
	);
	const visibleSessions = useMemo(
		() =>
			searchableSessions.flatMap(({ session, searchText }) => {
				if (session.archived !== showArchived) return [];
				if (normalizedSearch && !searchText.includes(normalizedSearch))
					return [];
				return [session];
			}),
		[normalizedSearch, searchableSessions, showArchived],
	);
	const projectsByEnv = useMemo(() => {
		const grouped = new Map<string, SidebarProject[]>();
		for (const project of projects) {
			const items = grouped.get(project.envId);
			if (items) items.push(project);
			else grouped.set(project.envId, [project]);
		}
		return grouped;
	}, [projects]);
	const sessionsByProject = useMemo(() => {
		const grouped = new Map<string, SidebarSession[]>();
		for (const session of visibleSessions) {
			const items = grouped.get(session.projectId);
			if (items) items.push(session);
			else grouped.set(session.projectId, [session]);
		}
		return grouped;
	}, [visibleSessions]);

	const handleSelectSession = useCallback(
		(sessionId: string) => {
			if (selectedSessionId === undefined) {
				setInternalSelectedSessionId(sessionId);
			}
			onSelectSession?.(sessionId);
		},
		[onSelectSession, selectedSessionId],
	);
	const handleToggleSessionPin = useCallback(
		(id: string, pinned: boolean) => onUpdateSession?.(id, { pinned }),
		[onUpdateSession],
	);
	const handleArchiveSession = useCallback(
		(id: string) => onUpdateSession?.(id, { archived: true }),
		[onUpdateSession],
	);
	const handleRestoreSession = useCallback(
		(id: string) => onUpdateSession?.(id, { archived: false }),
		[onUpdateSession],
	);
	const handleRenameSession = useCallback(
		(id: string, title: string) => onUpdateSession?.(id, { title }),
		[onUpdateSession],
	);
	const renderSession = useCallback(
		(session: SidebarSession, project: SidebarProject, env: SidebarEnv) => (
			<SessionRow
				key={session.id}
				session={session}
				project={project}
				env={env}
				now={now}
				selected={activeSessionId === session.id}
				onSelect={handleSelectSession}
				onTogglePin={handleToggleSessionPin}
				onArchive={handleArchiveSession}
				onRestore={handleRestoreSession}
				onRename={handleRenameSession}
			/>
		),
		[
			activeSessionId,
			handleArchiveSession,
			handleRenameSession,
			handleRestoreSession,
			handleSelectSession,
			handleToggleSessionPin,
			now,
		],
	);

	const renderSessionList = (
		projectSessions: SidebarSession[],
		project: SidebarProject,
		env: SidebarEnv,
	) => {
		const pinned = projectSessions.filter((session) => session.pinned);
		const unpinned = projectSessions.filter((session) => !session.pinned);
		const orderedSessions = [...pinned, ...unpinned];

		const renderRow = (session: SidebarSession) =>
			renderSession(session, project, env);
		if (orderedSessions.length < 40) {
			return <>{orderedSessions.map(renderRow)}</>;
		}

		return (
			<Suspense fallback={<>{orderedSessions.slice(0, 40).map(renderRow)}</>}>
				<VirtualSessionRows
					sessions={orderedSessions}
					scrollViewportRef={scrollViewportRef}
					renderSession={renderRow}
				/>
			</Suspense>
		);
	};

	return (
		<aside
			ref={asideRef}
			style={collapsed ? undefined : { width: sidebarWidth }}
			className={cn(
				"relative h-full shrink-0 transition-[width,opacity] duration-200 ease-out",
				// 拖拽时关闭宽度过渡，避免动画跟不上指针（与右侧 Panel 一致）
				resizing && "transition-none",
				collapsed
					? "w-0 overflow-hidden opacity-0"
					: "overflow-visible opacity-100",
			)}
		>
			<div className="relative mb-2 ml-2 mr-1 mt-2 flex h-[calc(100%_-_1rem)] w-[calc(100%-12px)] flex-col overflow-hidden rounded-xl border border-sidebar-border/80 bg-sidebar p-[2px] text-sidebar-foreground shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]">
				<header
					data-tauri-drag-region="deep"
					className={cn(
						"group/sidebar-header relative flex shrink-0 items-center justify-between gap-2 px-1.5",
						IS_MACOS ? "h-[72px] pt-7" : "h-11",
					)}
				>
					<div className="grid h-8 w-full min-w-0 select-none grid-cols-[20px_1fr_16px] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-sidebar-foreground dark:text-sidebar-foreground/75">
						<Avatar className="h-5 w-5 rounded-md text-[10px]">
							<AvatarFallback className="rounded-md bg-sidebar-hover/60 text-[10px] font-semibold text-sidebar-foreground">
								P
							</AvatarFallback>
						</Avatar>
						<span className="min-w-0 flex-1 truncate font-medium">Pilo</span>
						<span aria-hidden="true" />
					</div>
					<button
						type="button"
						className={cn(
							"absolute right-1.5 flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-sidebar-ring/40",
							IS_MACOS ? "-top-0.5" : "top-2",
						)}
						aria-label="收起侧边栏"
						onClick={() => onCollapse?.()}
					>
						<PanelLeft className="h-4 w-4" />
					</button>
				</header>
				<div className="-mt-1 flex shrink-0 flex-col gap-px px-1.5">
					<button
						type="button"
						className="group flex w-full select-none items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-sidebar-foreground outline-hidden transition hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:ring-1 focus-visible:ring-sidebar-ring/30 dark:text-sidebar-foreground/75"
						onClick={() => onNewChat?.()}
					>
						<span className="flex h-5 w-5 shrink-0 items-center justify-center text-current">
							<SquarePen className="h-4 w-4" />
						</span>
						<span className="truncate">新对话</span>
					</button>
					<div className="mt-1 flex items-center gap-1">
						<label className="relative min-w-0 flex-1">
							<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-sidebar-foreground-muted" />
							<input
								value={searchQuery}
								onChange={(event) => setSearchQuery(event.target.value)}
								placeholder="搜索会话"
								className="h-7 w-full rounded-md border border-sidebar-border/70 bg-transparent pl-7 pr-2 text-xs outline-none placeholder:text-sidebar-foreground-muted focus:border-sidebar-ring/50"
							/>
						</label>
						<button
							type="button"
							aria-label={showArchived ? "显示活动会话" : "显示已归档会话"}
							aria-pressed={showArchived}
							onClick={() => setShowArchived((value) => !value)}
							className={cn(
								"flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground",
								showArchived &&
									"bg-sidebar-hover text-sidebar-hover-foreground",
							)}
						>
							<Archive className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
				<ScrollArea
					className="mt-2 min-h-0 min-w-0 flex-1 overflow-x-hidden"
					viewportRef={scrollViewportRef}
					viewportClassName="min-w-0 overflow-x-hidden pl-1.5 pr-2.5 pb-3"
					scrollbarClassName="w-2 p-px"
					scrollbarThumbClassName="bg-[hsl(var(--muted-foreground)/0.35)] hover:bg-[hsl(var(--muted-foreground)/0.45)] active:bg-[hsl(var(--muted-foreground)/0.55)]"
				>
					<div className="relative w-full min-w-0 overflow-x-hidden pt-1">
						{envs.map((env) => {
							const envCollapsed = collapsedSections[`env:${env.id}`] ?? false;
							const envProjects = projectsByEnv.get(env.id) ?? [];
							return (
								<section
									key={env.id}
									className="mb-3 w-full min-w-0 space-y-0.5 overflow-hidden last:mb-0"
								>
									<EnvRow
										env={env}
										collapsed={envCollapsed}
										onToggle={() => toggleSection(`env:${env.id}`)}
										onAddProject={onAddProject}
									/>
									{!envCollapsed &&
										envProjects.map((project) => {
											const projectCollapsed =
												collapsedSections[`ws:${project.id}`] ?? false;
											const projectSessions =
												sessionsByProject.get(project.id) ?? [];
											return (
												<div
													key={project.id}
													className="grid w-full min-w-0 gap-px overflow-hidden"
												>
													<ProjectRow
														project={project}
														env={env}
														collapsed={projectCollapsed}
														onToggle={() => {
															const key = `ws:${project.id}`;
															toggleSection(key);
															if (projectCollapsed)
																onRefreshProjectSessions?.(project.id);
														}}
														onNewChat={onNewChatInProject}
														onArchiveSessions={
															onArchiveProjectSessions
																? () =>
																		onArchiveProjectSessions(
																			projectSessions.map(
																				(session) => session.id,
																			),
																		)
																: undefined
														}
														onRefreshSessions={
															onRefreshProjectSessions
																? () => onRefreshProjectSessions(project.id)
																: undefined
														}
														hasSessions={projectSessions.length > 0}
													/>
													{!projectCollapsed &&
														renderSessionList(projectSessions, project, env)}
												</div>
											);
										})}
								</section>
							);
						})}
					</div>
				</ScrollArea>
				<footer className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-1.5 py-1">
					{footer}
				</footer>
			</div>
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="调整侧边栏宽度"
				onPointerDown={startResize}
				className={cn(
					"absolute -right-0.5 top-2 z-20 h-[calc(100%-1rem)] w-3 cursor-col-resize bg-transparent",
					"after:absolute after:right-[5px] after:top-3 after:bottom-3 after:w-[2px] after:rounded-full after:bg-transparent after:transition-colors after:duration-150",
					resizing
						? "after:bg-sidebar-ring/70"
						: "hover:after:bg-sidebar-ring/50 hover:after:delay-150",
				)}
			/>
		</aside>
	);
}

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- 宽度拖拽手柄是垂直分割线，role=separator 语义正确，无对应语义 HTML 元素 */
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";
import {
	closestCenter,
	DndContext,
	PointerSensor,
	type DragEndEvent,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { PanelLeft, Search, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";
import { usePreferences } from "@/lib/preferences-provider";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { ScrollArea } from "@/ui";
import { IS_MACOS } from "@/components/title-bar";
import { CommandPalette } from "@/components/command-palette";
import { ProjectSessionsToolbar } from "./project-sessions-toolbar";
import { EnvRow, SessionRow, ProjectRow } from "./rows";
import {
	filterProjectSessions,
	summarizeProjectSessions,
} from "./session-list";
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

/** 方向键每次调整的宽度。 */
const RESIZE_STEP = 16;

/** 侧栏宽度持久化 key。 */
const SIDEBAR_WIDTH_STORAGE_KEY = "pilo.sidebarWidth";

/** 环境/项目折叠状态持久化 key。 */
const COLLAPSED_SECTIONS_STORAGE_KEY = "pilo.collapsedSections";
const EMPTY_REFRESHING_PROJECT_IDS: ReadonlySet<string> = new Set();

function readCollapsedSections(): Record<string, boolean> {
	try {
		const stored = window.localStorage.getItem(COLLAPSED_SECTIONS_STORAGE_KEY);
		return stored ? (JSON.parse(stored) as Record<string, boolean>) : {};
	} catch {
		return {};
	}
}

const VirtualSessionRows = lazy(() =>
	import("./virtual-session-rows").then((module) => ({
		default: module.VirtualSessionRows,
	})),
);

function SortableProjectBlock({
	id,
	disabled,
	row,
	children,
}: {
	id: string;
	disabled: boolean;
	row: ReactNode;
	children?: ReactNode;
}) {
	const {
		isDragging,
		listeners,
		setActivatorNodeRef,
		setNodeRef,
		transform,
		transition,
	} = useSortable({
		id,
		disabled,
		transition: {
			duration: 180,
			easing: "cubic-bezier(0.2, 0, 0, 1)",
		},
	});
	const pointerDown = listeners?.onPointerDown;

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Transform.toString(transform),
				transition,
				position: "relative",
				zIndex: isDragging ? 20 : undefined,
			}}
			className="grid w-full min-w-0 gap-px overflow-visible rounded-md"
		>
			<div
				ref={setActivatorNodeRef}
				{...listeners}
				onPointerDown={(event) => {
					const target = event.target as HTMLElement;
					if (
						target.closest(
							"button, input, textarea, select, a, [role='menuitem']",
						)
					) {
						return;
					}
					pointerDown?.(event);
				}}
				className={cn(
					"rounded-md touch-none",
					disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing",
				)}
			>
				<div
					className={cn(
						"rounded-md transition-[transform,opacity,box-shadow] duration-150 ease-out",
						isDragging && "scale-[0.99] opacity-80 shadow-sm",
					)}
				>
					{row}
				</div>
			</div>
			{children}
		</div>
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
	const [projectSessionsViewId, setProjectSessionsViewId] = useState<
		string | null
	>(null);
	const [projectSessionsQuery, setProjectSessionsQuery] = useState("");
	const { keyboardShortcuts } = usePreferences();
	useKeyboardShortcut(keyboardShortcuts["open-command-palette"], () =>
		setPaletteOpen((open) => !open),
	);
	const [collapsedSections, setCollapsedSections] = useState<
		Record<string, boolean>
	>(readCollapsedSections);
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
	const asideRef = useRef<HTMLElement>(null);
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
	const [sidebarWidth, setSidebarWidth] = useState(() => {
		const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
		if (!stored) return DEFAULT_SIDEBAR_WIDTH;
		const parsed = Number.parseInt(stored, 10);
		if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH;
		return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, parsed));
	});
	const [resizing, setResizing] = useState(false);
	const suppressProjectClickRef = useRef(false);
	const projectDragSensors = useSensors(
		useSensor(PointerSensor, {
			activationConstraint: { distance: 6 },
		}),
	);

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

	// 键盘路径：←/→ 每次调 16px；已到最小宽度时继续 ← 则折叠，与拖拽一致。
	const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		if (event.key === "ArrowLeft" && sidebarWidth <= MIN_SIDEBAR_WIDTH) {
			onCollapse?.();
			return;
		}
		const delta = event.key === "ArrowRight" ? RESIZE_STEP : -RESIZE_STEP;
		setSidebarWidth(
			Math.min(
				MAX_SIDEBAR_WIDTH,
				Math.max(MIN_SIDEBAR_WIDTH, sidebarWidth + delta),
			),
		);
	};

	useEffect(() => {
		window.localStorage.setItem(
			COLLAPSED_SECTIONS_STORAGE_KEY,
			JSON.stringify(collapsedSections),
		);
	}, [collapsedSections]);

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

	const handleProjectDragEnd = useCallback(
		(envId: string, event: DragEndEvent) => {
			const { active, over } = event;
			if (!over || active.id === over.id) return;
			const order = (projectsByEnv.get(envId) ?? []).map(
				(project) => project.id,
			);
			const fromIndex = order.indexOf(String(active.id));
			const toIndex = order.indexOf(String(over.id));
			if (fromIndex < 0 || toIndex < 0) return;
			onReorderProjects?.(envId, arrayMove(order, fromIndex, toIndex));
		},
		[onReorderProjects, projectsByEnv],
	);
	const sessionsByProject = useMemo(() => {
		const grouped = new Map<string, SidebarSession[]>();
		for (const session of sessions) {
			const items = grouped.get(session.projectId);
			if (items) items.push(session);
			else grouped.set(session.projectId, [session]);
		}
		return grouped;
	}, [sessions]);
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
		return filterProjectSessions(
			sessionsByProject.get(projectSessionsViewId) ?? [],
			projectSessionsQuery,
		);
	}, [projectSessionsQuery, projectSessionsViewId, sessionsByProject]);
	const projectSessionsViewTotal = projectSessionsViewId
		? (sessionsByProject.get(projectSessionsViewId)?.length ?? 0)
		: 0;

	const resetSidebarScroll = useCallback(() => {
		window.requestAnimationFrame(() => {
			if (scrollViewportRef.current) scrollViewportRef.current.scrollTop = 0;
		});
	}, []);
	const openProjectSessionsView = useCallback(
		(projectId: string) => {
			setProjectSessionsViewId(projectId);
			setProjectSessionsQuery("");
			resetSidebarScroll();
			onRefreshProjectSessions?.(projectId);
		},
		[onRefreshProjectSessions, resetSidebarScroll],
	);
	const closeProjectSessionsView = useCallback(() => {
		setProjectSessionsViewId(null);
		setProjectSessionsQuery("");
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
	const renderSession = useCallback(
		(session: SidebarSession) => (
			<SessionRow
				key={session.id}
				session={session}
				selected={activeSessionId === session.id}
				onSelect={handleSelectSession}
				onDelete={session.sessionPath ? handleDeleteSession : undefined}
				onRename={handleRenameSession}
			/>
		),
		[
			activeSessionId,
			handleDeleteSession,
			handleRenameSession,
			handleSelectSession,
		],
	);

	const renderSessionList = (projectSessions: SidebarSession[]) => {
		if (projectSessions.length < 40) {
			return <>{projectSessions.map(renderSession)}</>;
		}

		return (
			<Suspense
				fallback={<>{projectSessions.slice(0, 40).map(renderSession)}</>}
			>
				<VirtualSessionRows
					sessions={projectSessions}
					scrollViewportRef={scrollViewportRef}
					renderSession={renderSession}
				/>
			</Suspense>
		);
	};

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
						<span className="min-w-0 select-none truncate px-2 text-lg font-semibold tracking-tight text-sidebar-foreground">
							Pilo
						</span>
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
								aria-label="搜索会话"
								onClick={() => setPaletteOpen(true)}
							>
								<Search className="h-4 w-4" />
							</button>
							<button
								type="button"
								className="flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring"
								aria-label="收起侧边栏"
								onClick={() => onCollapse?.()}
							>
								<PanelLeft className="h-4 w-4" />
							</button>
						</div>
					</header>
					<div className="-mt-1 flex shrink-0 flex-col gap-1 px-1.5">
						{projectSessionsViewProject ? (
							<ProjectSessionsToolbar
								project={projectSessionsViewProject}
								totalCount={projectSessionsViewTotal}
								query={projectSessionsQuery}
								onQueryChange={setProjectSessionsQuery}
								onBack={closeProjectSessionsView}
								onNewChat={onNewChatInProject}
							/>
						) : (
							<button
								type="button"
								className="group flex w-full select-none items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-sidebar-foreground outline-hidden transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring dark:text-sidebar-foreground/75"
								onClick={() => onNewChat?.()}
							>
								<span className="flex h-5 w-5 shrink-0 items-center justify-center text-current">
									<SquarePen className="h-4 w-4" />
								</span>
								<span className="truncate">新对话</span>
							</button>
						)}
					</div>
					<ScrollArea
						className="mt-2 min-h-0 min-w-0 flex-1 overflow-x-hidden"
						viewportRef={scrollViewportRef}
						viewportClassName="min-w-0 overflow-x-hidden overscroll-y-none pl-1.5 pr-2.5 pb-3"
						scrollbarClassName="w-2 p-px"
						scrollbarThumbClassName="bg-[hsl(var(--muted-foreground)/0.35)] hover:bg-[hsl(var(--muted-foreground)/0.45)] active:bg-[hsl(var(--muted-foreground)/0.55)]"
					>
						<div className="relative w-full min-w-0 overflow-x-hidden pt-1">
							{projectSessionsViewProject ? (
								projectSessionsViewSessions.length > 0 ? (
									renderSessionList(projectSessionsViewSessions)
								) : (
									<div className="px-3 py-8 text-center text-xs text-sidebar-foreground-muted">
										{projectSessionsQuery.trim()
											? "没有匹配的会话"
											: "暂无会话"}
									</div>
								)
							) : (
								envs.map((env) => {
									const envCollapsed =
										collapsedSections[`env:${env.id}`] ?? false;
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
												onDeleteConnection={onDeleteConnection}
											/>
											{!envCollapsed && (
												<DndContext
													sensors={projectDragSensors}
													collisionDetection={closestCenter}
													onDragStart={() => {
														suppressProjectClickRef.current = true;
													}}
													onDragCancel={() => {
														window.setTimeout(() => {
															suppressProjectClickRef.current = false;
														}, 0);
													}}
													onDragEnd={(event) => {
														handleProjectDragEnd(env.id, event);
														window.setTimeout(() => {
															suppressProjectClickRef.current = false;
														}, 0);
													}}
												>
													<SortableContext
														items={envProjects.map((project) => project.id)}
														strategy={verticalListSortingStrategy}
													>
														{envProjects.map((project) => {
															const projectCollapsed =
																collapsedSections[`ws:${project.id}`] ?? true;
															const projectSessions =
																sessionsByProject.get(project.id) ?? [];
															const projectSessionSummary = projectCollapsed
																? null
																: summarizeProjectSessions(
																		projectSessions,
																		activeSessionId,
																	);
															return (
																<SortableProjectBlock
																	key={project.id}
																	id={project.id}
																	disabled={
																		refreshingProjectIds.has(project.id) ||
																		envProjects.length < 2
																	}
																	row={
																		<ProjectRow
																			project={project}
																			env={env}
																			collapsed={projectCollapsed}
																			selected={
																				activeSessionId === null &&
																				selectedProjectId === project.id
																			}
																			refreshing={refreshingProjectIds.has(
																				project.id,
																			)}
																			onSelect={() => {
																				if (suppressProjectClickRef.current)
																					return;
																				onFocusProject?.(project.id);
																				onNewChatInProject?.(project.id);
																			}}
																			onToggle={() => {
																				const key = `ws:${project.id}`;
																				toggleSection(key, true);
																				if (projectCollapsed)
																					onRefreshProjectSessions?.(
																						project.id,
																					);
																			}}
																			onNewChat={onNewChatInProject}
																			onDelete={onDeleteProject}
																			onRefreshSessions={
																				onRefreshProjectSessions
																					? () =>
																							onRefreshProjectSessions(
																								project.id,
																							)
																					: undefined
																			}
																		/>
																	}
																>
																	{projectSessionSummary ? (
																		<>
																			{projectSessionSummary.visible.map(
																				renderSession,
																			)}
																			{projectSessionSummary.hiddenCount > 0 ? (
																				<button
																					type="button"
																					className="flex w-full items-center rounded-md py-1 pl-8 pr-2 text-left text-xs text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring"
																					onClick={() =>
																						openProjectSessionsView(project.id)
																					}
																				>
																					<span className="min-w-0 flex-1 truncate">
																						查看全部
																					</span>
																					<span className="ml-2 shrink-0 tabular-nums">
																						{projectSessionSummary.totalCount}
																					</span>
																				</button>
																			) : null}
																		</>
																	) : null}
																</SortableProjectBlock>
															);
														})}
													</SortableContext>
												</DndContext>
											)}
										</section>
									);
								})
							)}
						</div>
					</ScrollArea>
					<footer className="flex shrink-0 items-center gap-1 border-t border-sidebar-border px-1.5 py-1">
						{footer}
					</footer>
				</div>
				{/* 折叠时侧栏宽为 0，手柄没有可拖的内容，也不该出现在 Tab 顺序里。 */}
				{collapsed ? null : (
					<div
						role="separator"
						aria-orientation="vertical"
						aria-label="调整侧边栏宽度"
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

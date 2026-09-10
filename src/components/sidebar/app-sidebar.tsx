/* oxlint-disable jsx-a11y/prefer-tag-over-role -- 宽度拖拽手柄是垂直分割线，role=separator 语义正确，无对应语义 HTML 元素 */
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { PanelLeft, SquarePen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar, AvatarFallback, ScrollArea } from "@/ui";
import { EnvRow, SessionRow, WorkspaceRow } from "./rows";
import {
	AppSidebarProps,
	SidebarEnv,
	SidebarSession,
	SidebarWorkspace,
} from "./types";

export type { AppSidebarProps, SidebarEnv, SidebarSession, SidebarWorkspace };

// ---- 侧边栏 ---------------------------------------------------------------

/** 侧栏最小宽度：低于该值拖拽视为折叠（拖到 MIN 后调用 onCollapse）。 */
const MIN_SIDEBAR_WIDTH = 240;

/** 侧栏最大宽度。 */
const MAX_SIDEBAR_WIDTH = 480;

/** 侧栏默认宽度。 */
const DEFAULT_SIDEBAR_WIDTH = 292;

/** 侧栏宽度持久化 key。 */
const SIDEBAR_WIDTH_STORAGE_KEY = "pilo.sidebarWidth";

export function AppSidebar({
	envs,
	workspaces,
	sessions,
	collapsed = false,
	onCollapse,
	onArchiveSession,
	onArchiveWorkspaceSessions,
	onRefreshWorkspaceSessions,
	selectedSessionId,
	onSelectSession,
	onNewChat,
	onNewChatInWorkspace,
	footer,
}: AppSidebarProps) {
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

	return (
		<aside
			ref={asideRef}
			style={collapsed ? undefined : { width: sidebarWidth }}
			className={cn(
				"relative h-full shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-out",
				// 拖拽时关闭宽度过渡，避免动画跟不上指针（与右侧 Panel 一致）
				resizing && "transition-none",
				collapsed ? "w-0 opacity-0" : "opacity-100",
			)}
		>
			<div className="relative mb-2 ml-2 mr-1 mt-2 flex h-[calc(100%_-_1rem)] w-[calc(100%-12px)] flex-col overflow-hidden rounded-xl border border-sidebar-border/80 bg-sidebar text-sidebar-foreground shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]">
				<header
					data-tauri-drag-region="deep"
					className="group/sidebar-header relative flex h-11 shrink-0 items-center justify-between gap-2 px-1.5"
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
						className="absolute right-1.5 top-2 flex h-7 w-7 items-center justify-center rounded-md text-sidebar-foreground-muted transition-colors hover:bg-sidebar-hover hover:text-sidebar-hover-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-sidebar-ring/40"
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
				</div>
				<ScrollArea
					className="mt-2 min-h-0 flex-1"
					viewportClassName="pl-1.5 pr-2.5 pb-3"
					scrollbarClassName="w-2 p-px"
					scrollbarThumbClassName="bg-[hsl(var(--muted-foreground)/0.35)] hover:bg-[hsl(var(--muted-foreground)/0.45)] active:bg-[hsl(var(--muted-foreground)/0.55)]"
				>
					<div className="relative pt-1">
						{envs.map((env) => {
							const envCollapsed = collapsedSections[`env:${env.id}`] ?? false;
							const envWorkspaces = workspaces.filter(
								(workspace) => workspace.envId === env.id,
							);
							return (
								<section key={env.id} className="mb-3 space-y-0.5 last:mb-0">
									<EnvRow
										env={env}
										collapsed={envCollapsed}
										onToggle={() => toggleSection(`env:${env.id}`)}
									/>
									{!envCollapsed &&
										envWorkspaces.map((workspace) => {
											const workspaceCollapsed =
												collapsedSections[`ws:${workspace.id}`] ?? false;
											const workspaceSessions = sessions.filter(
												(session) => session.workspaceId === workspace.id,
											);
											return (
												<div key={workspace.id} className="grid gap-px">
													<WorkspaceRow
														workspace={workspace}
														env={env}
														collapsed={workspaceCollapsed}
														onToggle={() => toggleSection(`ws:${workspace.id}`)}
														onNewChat={onNewChatInWorkspace}
														onArchiveSessions={
															onArchiveWorkspaceSessions
																? () =>
																		onArchiveWorkspaceSessions(
																			workspaceSessions.map(
																				(session) => session.id,
																			),
																		)
																: undefined
														}
														onRefreshSessions={
															onRefreshWorkspaceSessions
																? () => onRefreshWorkspaceSessions(workspace.id)
																: undefined
														}
														hasSessions={workspaceSessions.length > 0}
													/>
													{!workspaceCollapsed &&
														workspaceSessions.map((session) => (
															<SessionRow
																key={session.id}
																session={session}
																workspace={workspace}
																env={env}
																now={now}
																selected={activeSessionId === session.id}
																onSelect={() => {
																	if (selectedSessionId === undefined) {
																		setInternalSelectedSessionId(session.id);
																	}
																	onSelectSession?.(session.id);
																}}
																onArchive={onArchiveSession}
															/>
														))}
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
			{/* 拖拽手柄：占用内层面板右侧 mr-1 的空隙，横向拖动调整宽度 */}
			<div
				role="separator"
				aria-orientation="vertical"
				aria-label="调整侧边栏宽度"
				onPointerDown={startResize}
				className={cn(
					"absolute right-0 top-0 z-10 h-full w-1 cursor-col-resize",
					"transition-colors duration-150 hover:bg-sidebar-border",
					resizing && "bg-sidebar-border",
				)}
			/>
		</aside>
	);
}

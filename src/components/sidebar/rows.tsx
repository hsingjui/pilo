/* oxlint-disable jsx-a11y/prefer-tag-over-role -- sidebar rows contain independent action buttons; native outer buttons would create invalid nested interactive controls. */
import {
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import {
	Check,
	ChevronDown,
	Clock,
	Folder,
	LoaderCircle,
	Monitor,
	MoreHorizontal,
	Pencil,
	Plus,
	RefreshCw,
	SquarePen,
	Trash2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProjectPiRuntime } from "@/lib/projects";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";
import { menuItemIconClassName } from "@/ui/menu-styles";
import type {
	SidebarEnv,
	SidebarEnvView,
	SidebarSession,
	SidebarProject,
} from "./types";

// 悬浮时才出现的行内操作按钮（Lody loro-app-sidebar 的 hoverActionClassName）。
const HOVER_ACTION = cn(
	"inline-flex h-5 w-5 items-center justify-center rounded-sm",
	"text-muted-foreground transition-[opacity,background-color,color] duration-100",
	"opacity-0 pointer-events-none",
	"group-hover:opacity-100 group-hover:pointer-events-auto",
	"group-data-[menu-open]:opacity-100 group-data-[menu-open]:pointer-events-auto",
	"focus-visible:opacity-100 focus-visible:pointer-events-auto",
	"hover:text-foreground hover:bg-muted/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
	// 不可见时用伪元素把命中区补到 24×24，视觉尺寸保持不变
	"relative after:absolute after:-inset-0.5 after:content-['']",
);

/** 菜单内的迷你开关（比标准 Switch 小一号，适合行内展示）。 */
function MiniSwitch({ checked }: { checked: boolean }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors",
				checked ? "bg-primary" : "bg-switch-track",
			)}
		>
			<span
				className={cn(
					"absolute left-0.5 h-3 w-3 rounded-full bg-background shadow-sm transition-transform",
					checked && "translate-x-3",
				)}
			/>
		</span>
	);
}

/** 「视图」分组的单选项：图标 + 文字 + 选中勾。 */
function ViewMenuItem({
	icon: Icon,
	label,
	selected,
	onSelect,
}: {
	icon: typeof Folder;
	label: string;
	selected: boolean;
	onSelect: () => void;
}) {
	return (
		<DropdownMenuItem onSelect={onSelect}>
			<Icon className={menuItemIconClassName} />
			<span className="min-w-0 flex-1 whitespace-nowrap">{label}</span>
			{selected ? (
				<Check
					className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
					aria-hidden="true"
				/>
			) : null}
		</DropdownMenuItem>
	);
}

/**
 * 两步确认的删除按钮：
 * 第一次点击进入 Confirm 状态，再次点击才执行，失焦 / 移出 / Esc 复位。
 */
function ConfirmDeleteButton({
	label,
	confirmLabel,
	className,
	onConfirm,
}: {
	label: string;
	confirmLabel: string;
	className?: string;
	onConfirm: () => void;
}) {
	const [confirming, setConfirming] = useState(false);
	const resetTimer = useRef<number | null>(null);

	const reset = useCallback(() => {
		if (resetTimer.current !== null) {
			window.clearTimeout(resetTimer.current);
			resetTimer.current = null;
		}
		setConfirming(false);
	}, []);

	useEffect(() => reset, [reset]);

	return (
		<button
			type="button"
			aria-label={confirming ? `确认${label}` : label}
			className={cn(
				"relative inline-flex items-center justify-center rounded-sm",
				// 折叠态只有 20px，用伪元素补到 24×24
				"after:absolute after:-inset-0.5 after:content-['']",
				"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring",
				confirming
					? "relative z-10 h-5 min-w-10 overflow-hidden whitespace-nowrap rounded-full border border-destructive/20 bg-sidebar px-2 text-2xs font-medium leading-none text-destructive shadow-xs transition-none hover:bg-sidebar hover:text-destructive"
					: "h-5 w-5 text-sidebar-foreground-muted transition-[opacity,color,background-color] duration-100 hover:text-sidebar-foreground",
				className,
			)}
			onClick={(event) => {
				event.preventDefault();
				event.stopPropagation();
				if (!confirming) {
					if (resetTimer.current !== null)
						window.clearTimeout(resetTimer.current);
					setConfirming(true);
					resetTimer.current = window.setTimeout(() => {
						resetTimer.current = null;
						setConfirming(false);
					}, 3500);
					return;
				}
				reset();
				onConfirm();
			}}
			onKeyDown={(event) => {
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					reset();
				}
			}}
			onBlur={reset}
			onMouseLeave={() => {
				if (confirming) reset();
			}}
		>
			{confirming ? (
				<>
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-0 rounded-full bg-destructive/12 dark:bg-destructive/35"
					/>
					<span className="relative z-10">{confirmLabel}</span>
				</>
			) : (
				<Trash2 className="h-3.5 w-3.5" />
			)}
		</button>
	);
}

// ---- 环境行 ---------------------------------------------------------------

export function EnvRow({
	env,
	collapsed,
	onToggle,
	view,
	onViewChange,
	showProjects,
	onShowProjectsChange,
	onAddProject,
	onDeleteConnection,
}: {
	env: SidebarEnv;
	collapsed: boolean;
	onToggle: () => void;
	/** 侧栏组织模式（全局）。 */
	view: SidebarEnvView;
	onViewChange?: (view: SidebarEnvView) => void;
	/** 「展示项目」开关（“最近会话”模式下控制会话行是否带项目名）。 */
	showProjects: boolean;
	onShowProjectsChange?: (showProjects: boolean) => void;
	onAddProject?: (connectionId: string) => void;
	onDeleteConnection?: (connectionId: string) => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const toggleLabel = collapsed ? "展开环境" : "折叠环境";
	return (
		<div className="group flex h-7 items-center gap-1 rounded-md pr-2">
			<button
				type="button"
				aria-label={toggleLabel}
				aria-expanded={!collapsed}
				onClick={onToggle}
				className={cn(
					"relative flex h-7 min-w-0 flex-1 select-none items-center gap-2 rounded-md border border-transparent bg-transparent px-2 text-left",
					"text-sm font-medium text-sidebar-foreground-muted transition-colors hover:text-sidebar-foreground",
					"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring",
				)}
			>
				<Monitor className="h-3.5 w-3.5 shrink-0 opacity-80" />
				<span className="min-w-0 truncate">{env.name}</span>
				<ChevronDown
					className={cn(
						"h-3.5 w-3.5 shrink-0 text-current transition-[opacity,transform] duration-150 ease-out",
						collapsed
							? "-rotate-90 opacity-100"
							: "opacity-0 group-hover:opacity-100",
					)}
				/>
			</button>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
						aria-label={`在 ${env.name} 添加项目`}
						onClick={(event) => {
							event.stopPropagation();
							onAddProject?.(env.id);
						}}
					>
						<Plus className="h-3.5 w-3.5" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="right">添加项目</TooltipContent>
			</Tooltip>
			<DropdownMenu
				open={menuOpen}
				onOpenChange={(open) => {
					setMenuOpen(open);
					if (!open) setConfirmingDelete(false);
				}}
			>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
						aria-label="连接菜单"
						onClick={(event) => event.stopPropagation()}
					>
						<MoreHorizontal className="h-3.5 w-3.5" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-0 w-40">
					{onViewChange ? (
						<>
							<DropdownMenuLabel>视图</DropdownMenuLabel>
							<ViewMenuItem
								icon={Folder}
								label="项目"
								selected={view === "projects"}
								onSelect={() => onViewChange("projects")}
							/>
							<ViewMenuItem
								icon={Clock}
								label="最近会话"
								selected={view === "recent"}
								onSelect={() => onViewChange("recent")}
							/>
							<DropdownMenuItem
								data-show-projects={showProjects || undefined}
								onSelect={() => onShowProjectsChange?.(!showProjects)}
							>
								<Folder className={menuItemIconClassName} />
								<span className="min-w-0 flex-1 whitespace-nowrap">
									展示项目
								</span>
								<MiniSwitch checked={showProjects} />
							</DropdownMenuItem>
							<DropdownMenuSeparator />
						</>
					) : null}
					{onDeleteConnection ? (
						<DropdownMenuItem
							variant="destructive"
							onSelect={(event) => {
								if (!confirmingDelete) {
									event.preventDefault();
									setConfirmingDelete(true);
									return;
								}
								onDeleteConnection(env.id);
							}}
						>
							<Trash2 className={menuItemIconClassName} />
							{confirmingDelete ? "确认删除" : "删除连接"}
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

// ---- 项目行 -------------------------------------------------------------

/**
 * “最近会话”视图的分区标题（参考 Lody SidebarSectionHeader）：
 * 可折叠/展开；操作菜单融进标题行的 MoreHorizontal——连接和项目树
 * 隐藏后，这里是用户切回“项目”视图的入口。
 */
export function RecentSectionHeader({
	collapsed,
	onToggle,
	view,
	onViewChange,
	showProjects,
	onShowProjectsChange,
}: {
	collapsed: boolean;
	onToggle: () => void;
	/** 侧栏组织模式（全局）。 */
	view: SidebarEnvView;
	onViewChange?: (view: SidebarEnvView) => void;
	/** 「展示项目」开关（“最近会话”模式下控制会话行是否带项目名）。 */
	showProjects: boolean;
	onShowProjectsChange?: (showProjects: boolean) => void;
}) {
	const toggleLabel = collapsed ? "展开最近会话" : "折叠最近会话";
	return (
		<div className="group flex h-7 items-center gap-1 rounded-md">
			<button
				type="button"
				aria-label={toggleLabel}
				aria-expanded={!collapsed}
				onClick={onToggle}
				className={cn(
					"relative flex h-7 min-w-0 flex-1 select-none items-center gap-2 rounded-md border border-transparent bg-transparent px-2 text-left",
					"text-sm font-medium text-sidebar-foreground-muted transition-colors hover:text-sidebar-foreground",
					"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring",
				)}
			>
				<Clock className="h-3.5 w-3.5 shrink-0 opacity-80" />
				<span className="min-w-0 truncate">最近会话</span>
				<ChevronDown
					className={cn(
						"h-3.5 w-3.5 shrink-0 text-current transition-[opacity,transform] duration-150 ease-out",
						collapsed
							? "-rotate-90 opacity-100"
							: "opacity-0 group-hover:opacity-100",
					)}
				/>
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
						aria-label="最近会话菜单"
					>
						<MoreHorizontal className="h-3.5 w-3.5" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start" className="min-w-0 w-40">
					{onViewChange ? (
						<>
							<DropdownMenuLabel>视图</DropdownMenuLabel>
							<ViewMenuItem
								icon={Folder}
								label="项目"
								selected={view === "projects"}
								onSelect={() => onViewChange("projects")}
							/>
							<ViewMenuItem
								icon={Clock}
								label="最近会话"
								selected={view === "recent"}
								onSelect={() => onViewChange("recent")}
							/>
							<DropdownMenuItem
								data-show-projects={showProjects || undefined}
								onSelect={() => onShowProjectsChange?.(!showProjects)}
							>
								<Folder className={menuItemIconClassName} />
								<span className="min-w-0 flex-1 whitespace-nowrap">
									展示项目
								</span>
								<MiniSwitch checked={showProjects} />
							</DropdownMenuItem>
						</>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

export function ProjectRow({
	project,
	env,
	collapsed,
	selected,
	refreshing,
	onSelect,
	onToggle,
	onNewChat,
	onDelete,
	onSetPiRuntime,
	onRefreshSessions,
}: {
	project: SidebarProject;
	env: SidebarEnv;
	collapsed: boolean;
	selected: boolean;
	refreshing: boolean;
	onSelect: () => void;
	onToggle: () => void;
	onNewChat?: (projectId: string) => void;
	onDelete?: (projectId: string) => void;
	onSetPiRuntime?: (projectId: string, piRuntime: ProjectPiRuntime) => void;
	onRefreshSessions?: () => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	const toggleLabel = collapsed ? "展开项目" : "折叠项目";
	return (
		<Tooltip delayDuration={600}>
			<TooltipTrigger asChild>
				{/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 内嵌图标按钮，不能用原生 button */}
				<div
					role="button"
					tabIndex={0}
					aria-label={refreshing ? `${project.name} 正在刷新` : project.name}
					aria-current={selected ? "page" : undefined}
					aria-disabled={refreshing || undefined}
					data-menu-open={menuOpen || undefined}
					onClick={() => {
						if (refreshing) return;
						onSelect();
					}}
					onKeyDown={(event) => {
						if (event.target !== event.currentTarget) return;
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						if (refreshing) return;
						onSelect();
					}}
					className={cn(
						"group relative flex min-w-0 w-full cursor-pointer select-none items-center gap-2 rounded-md border border-transparent bg-transparent py-1 pl-2 pr-3 text-left text-xs font-semibold transition-colors",
						"text-sidebar-foreground dark:text-sidebar-foreground/75",
						"hover:bg-sidebar-hover hover:text-sidebar-hover-foreground data-[menu-open]:bg-sidebar-hover data-[menu-open]:text-sidebar-hover-foreground",
						"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring",
						selected &&
							"border-sidebar-foreground/10 bg-sidebar-foreground/10 text-sidebar-foreground hover:bg-sidebar-foreground/10",
						refreshing &&
							"cursor-default text-sidebar-foreground-muted hover:bg-transparent hover:text-sidebar-foreground-muted",
					)}
				>
					<button
						type="button"
						className="relative -mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center"
						aria-label={toggleLabel}
						aria-expanded={!collapsed}
						disabled={refreshing}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							onToggle();
						}}
					>
						<Folder className="absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-current opacity-80 transition-opacity duration-100 group-hover:opacity-0" />
						<ChevronDown
							className={cn(
								"absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-current transition-[opacity,transform] duration-150 ease-out",
								"opacity-0 group-hover:opacity-100",
								collapsed ? "-rotate-90" : "rotate-0",
							)}
						/>
					</button>
					<span className="min-w-0 flex-1 truncate text-left">
						{project.name}
					</span>
					<div className="flex shrink-0 items-center gap-0.5">
						{refreshing ? (
							<span
								className="flex h-5 w-5 items-center justify-center text-muted-foreground"
								aria-label="正在刷新会话"
							>
								<LoaderCircle className="h-3.5 w-3.5 animate-spin" />
							</span>
						) : null}
						<DropdownMenu
							open={menuOpen}
							onOpenChange={(open) => {
								setMenuOpen(open);
								if (!open) setConfirmingDelete(false);
							}}
						>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label="项目菜单"
									className={HOVER_ACTION}
									onClick={(event) => event.stopPropagation()}
								>
									<MoreHorizontal className="h-3.5 w-3.5" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start" className="min-w-0 w-32">
								<DropdownMenuItem
									disabled={refreshing}
									onSelect={() => onRefreshSessions?.()}
								>
									<RefreshCw className={menuItemIconClassName} />
									刷新会话
								</DropdownMenuItem>
								{project.connectionType === "ssh" && onSetPiRuntime ? (
									<DropdownMenuItem
										disabled={refreshing}
										onSelect={() =>
											onSetPiRuntime(
												project.id,
												project.piRuntime === "local" ? "workspace" : "local",
											)
										}
									>
										<Monitor className={menuItemIconClassName} />
										{project.piRuntime === "local"
											? "使用远程 Pi"
											: "使用本地 Pi"}
									</DropdownMenuItem>
								) : null}
								{onDelete ? (
									<DropdownMenuItem
										variant="destructive"
										disabled={refreshing}
										onSelect={(event) => {
											if (!confirmingDelete) {
												event.preventDefault();
												setConfirmingDelete(true);
												return;
											}
											onDelete(project.id);
										}}
									>
										<Trash2 className={menuItemIconClassName} />
										{confirmingDelete ? "确认删除" : "删除项目"}
									</DropdownMenuItem>
								) : null}
							</DropdownMenuContent>
						</DropdownMenu>
						<button
							type="button"
							aria-label="新建会话"
							className={HOVER_ACTION}
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
								onNewChat?.(project.id);
							}}
						>
							<SquarePen className="h-3.5 w-3.5" />
						</button>
					</div>
				</div>
			</TooltipTrigger>
			<TooltipContent side="right" align="start" className="max-w-[420px]">
				<div className="flex flex-col gap-0.5 text-xs">
					<span>{env.name}</span>
					<span className="break-all font-mono text-2xs leading-snug">
						{project.path}
					</span>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

// ---- 会话行 ---------------------------------------------------------------

// 会话列表的悬浮高亮：用一个高亮块在行之间平滑滑动，
// 比每行各自 transition background-color 更跟手（参考 GlideMenu）。
type SessionRowHighlight = { top: number; height: number };

/** 滑动高亮的共享逻辑：算出悬浮行相对容器的高亮块位置。 */
export function useSessionRowGlide() {
	const containerRef = useRef<HTMLDivElement>(null);
	const lastRowRef = useRef<HTMLElement | null>(null);
	const [highlight, setHighlight] = useState<SessionRowHighlight | null>(null);

	const onPointerOver = (event: ReactPointerEvent<HTMLDivElement>) => {
		const row = (event.target as HTMLElement).closest<HTMLElement>(
			"[data-session-row]",
		);
		const container = containerRef.current;
		if (!row || !container?.contains(row)) return;
		// 同一行内扫过子元素时不重复读取布局。
		if (lastRowRef.current === row) return;
		lastRowRef.current = row;
		const rowRect = row.getBoundingClientRect();
		const containerRect = container.getBoundingClientRect();
		const next = {
			top: rowRect.top - containerRect.top,
			height: rowRect.height,
		};
		setHighlight((current) =>
			current &&
			Math.abs(current.top - next.top) < 0.5 &&
			Math.abs(current.height - next.height) < 0.5
				? current
				: next,
		);
	};

	const onPointerLeave = () => {
		lastRowRef.current = null;
		setHighlight(null);
	};

	return { containerRef, highlight, onPointerOver, onPointerLeave };
}

/** 滑动高亮块；放在容器内、会话行之前。 */
export function SessionRowHighlightBlock({
	highlight,
}: {
	highlight: SessionRowHighlight | null;
}) {
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute inset-x-0 top-0 z-0 rounded-md bg-sidebar-hover transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none"
			style={{
				transform: `translateY(${highlight?.top ?? 0}px)`,
				height: highlight?.height ?? 0,
				opacity: highlight ? 1 : 0,
			}}
		/>
	);
}

export function SessionRowGlide({
	className,
	children,
}: {
	className?: string;
	children: ReactNode;
}) {
	const { containerRef, highlight, onPointerOver, onPointerLeave } =
		useSessionRowGlide();

	return (
		<div
			ref={containerRef}
			className={cn(
				"group/glide relative flex w-full min-w-0 flex-col gap-0.5",
				className,
			)}
			onPointerOver={onPointerOver}
			onPointerLeave={onPointerLeave}
		>
			<SessionRowHighlightBlock highlight={highlight} />
			{children}
		</div>
	);
}

export const SessionRow = memo(function SessionRow({
	session,
	selected,
	onSelect,
	onDelete,
	onRename,
	projectName,
}: {
	session: SidebarSession;
	selected: boolean;
	onSelect: (sessionId: string) => void;
	onDelete?: (sessionId: string) => void;
	onRename?: (sessionId: string, title: string) => void;
	/** 所属项目名；仅在“最近会话”且开启「展示项目」时传入（两行式展示）。 */
	projectName?: string;
}) {
	const projectContext = Boolean(projectName);
	const [menuOpen, setMenuOpen] = useState(false);
	const [confirmingDeleteMenu, setConfirmingDeleteMenu] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(session.title);
	const renameInputRef = useRef<HTMLInputElement>(null);
	const suppressSelectRef = useRef(false);
	useEffect(() => {
		if (renaming) renameInputRef.current?.focus();
	}, [renaming]);
	const submitRename = () => {
		const title = renameValue.trim();
		if (title && title !== session.title) onRename?.(session.id, title);
		setRenaming(false);
	};
	return (
		<Tooltip delayDuration={600} open={renaming ? false : undefined}>
			<TooltipTrigger asChild>
				{/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 内嵌图标按钮，不能用原生 button */}
				<div
					role="button"
					tabIndex={0}
					aria-label={session.title}
					aria-current={selected ? "page" : undefined}
					data-menu-open={menuOpen || undefined}
					data-session-row=""
					onClick={() => {
						if (!renaming && !suppressSelectRef.current) onSelect(session.id);
					}}
					onKeyDown={(event) => {
						if (renaming || event.target !== event.currentTarget) return;
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						onSelect(session.id);
					}}
					className={cn(
						"group relative w-full min-w-0 cursor-pointer select-none rounded-md border border-transparent bg-transparent px-2 text-left transition-colors",
						// 在滑动的悬浮高亮列表里，让高亮块而不是行自身承载 hover 背景。
						"group-hover/glide:hover:bg-transparent",
						projectContext ? "py-1.5" : "py-1",
						"hover:bg-sidebar-hover hover:text-sidebar-hover-foreground data-[menu-open]:bg-sidebar-hover",
						"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring",
						selected &&
							"border-sidebar-foreground/10 bg-sidebar-foreground/10 text-sidebar-foreground hover:bg-sidebar-foreground/10",
					)}
				>
					<div
						className={cn(
							"flex w-full min-w-0 gap-1.5",
							projectContext ? "items-start" : "items-center",
						)}
					>
						{/* 图标槽 16px：让会话标题与项目标题共享同一条 30px 起始边 */}
						<div className="relative flex h-4 w-4 shrink-0 items-center justify-center">
							<DropdownMenu
								open={menuOpen}
								onOpenChange={(open) => {
									setMenuOpen(open);
									if (!open) setConfirmingDeleteMenu(false);
								}}
							>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										aria-label="更多操作"
										onClick={(event) => event.stopPropagation()}
										className={cn(
											"absolute left-1/2 top-1/2 z-20 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md opacity-0 pointer-events-none",
											"group-hover:pointer-events-auto group-hover:opacity-100 group-data-[menu-open]:pointer-events-auto group-data-[menu-open]:opacity-100",
											"focus-visible:pointer-events-auto focus-visible:opacity-100",
											"after:absolute after:-inset-0.5 after:content-['']",
											"text-sidebar-foreground-muted transition-[opacity,color,background-color] duration-100",
											"hover:bg-sidebar-foreground/15 hover:text-sidebar-foreground",
											"group-data-[menu-open]:bg-sidebar-foreground/15 group-data-[menu-open]:text-sidebar-foreground",
										)}
									>
										<MoreHorizontal className="h-3.5 w-3.5" />
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="start" className="min-w-0 w-32">
									<DropdownMenuItem
										onSelect={() => {
											setRenameValue(session.title);
											setRenaming(true);
										}}
									>
										<Pencil className={menuItemIconClassName} />
										重命名
									</DropdownMenuItem>
									{onDelete ? (
										<DropdownMenuItem
											className="text-destructive focus:text-destructive"
											onSelect={(event) => {
												if (!confirmingDeleteMenu) {
													event.preventDefault();
													setConfirmingDeleteMenu(true);
													return;
												}
												onDelete(session.id);
											}}
										>
											<Trash2 className={menuItemIconClassName} />
											{confirmingDeleteMenu ? "确认删除" : "删除"}
										</DropdownMenuItem>
									) : null}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
						<div className="min-w-0 flex-1">
							{renaming ? (
								<input
									ref={renameInputRef}
									value={renameValue}
									aria-label="修改会话标题"
									onClick={(event) => event.stopPropagation()}
									onChange={(event) => setRenameValue(event.target.value)}
									onBlur={() => {
										suppressSelectRef.current = true;
										window.setTimeout(() => {
											suppressSelectRef.current = false;
										}, 0);
										submitRename();
									}}
									onKeyDown={(event) => {
										event.stopPropagation();
										if (event.key === "Enter") submitRename();
										if (event.key === "Escape") {
											setRenameValue(session.title);
											setRenaming(false);
										}
									}}
									className="min-w-0 w-full rounded-sm bg-transparent px-1 text-sm outline-hidden ring-1 ring-sidebar-ring"
								/>
							) : (
								<div className="flex h-5 min-w-0 items-center">
									<span
										className={cn(
											"block min-w-0 flex-1 truncate text-sm",
											selected
												? "text-sidebar-selection-foreground"
												: "text-sidebar-foreground dark:text-sidebar-foreground/75",
										)}
									>
										{session.title}
									</span>
								</div>
							)}
							{projectContext && projectName ? (
								<div
									data-sidebar-project-context={projectName}
									className="flex h-4 min-w-0 items-center gap-1 text-[11px] leading-tight text-sidebar-foreground-muted"
								>
									<Folder
										className="h-3 w-3 shrink-0 opacity-80"
										strokeWidth={1.75}
										aria-hidden="true"
									/>
									<span className="min-w-0 truncate">{projectName}</span>
								</div>
							) : null}
						</div>
						<div className="relative flex h-5 min-w-5 shrink-0 items-center justify-center pointer-events-none">
							<span
								aria-hidden="true"
								className="flex items-center justify-center transition-opacity duration-100 group-hover:opacity-0 group-data-[menu-open]:opacity-0"
							>
								{session.active ? (
									<LoaderCircle
										className={cn(
											"size-3.5 animate-spin",
											session.externalActive
												? "text-muted-foreground"
												: "text-sidebar-primary",
										)}
									/>
								) : null}
							</span>
							{onDelete ? (
								<ConfirmDeleteButton
									label="删除"
									confirmLabel="确认删除"
									className={cn(
										"absolute right-0 top-0 z-20",
										"opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100",
										"group-data-[menu-open]:pointer-events-auto group-data-[menu-open]:opacity-100",
										"focus-visible:pointer-events-auto focus-visible:opacity-100",
									)}
									onConfirm={() => onDelete(session.id)}
								/>
							) : null}
						</div>
					</div>
				</div>
			</TooltipTrigger>
			<TooltipContent side="right" align="start" className="max-w-[420px]">
				{session.title}
			</TooltipContent>
		</Tooltip>
	);
});

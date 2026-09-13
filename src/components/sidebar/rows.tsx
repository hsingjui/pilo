/* oxlint-disable jsx-a11y/prefer-tag-over-role -- sidebar rows contain independent action buttons; native outer buttons would create invalid nested interactive controls. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	Folder,
	Monitor,
	MoreHorizontal,
	Pencil,
	Pin,
	PinOff,
	Plus,
	RefreshCw,
	SlidersHorizontal,
	SquarePen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";
import { menuItemIconClassName } from "@/ui/menu-styles";
import type { SidebarEnv, SidebarSession, SidebarProject } from "./types";
import { SessionInfoHoverCard } from "./session-info-hover-card";

// 悬浮时才出现的行内操作按钮（Lody loro-app-sidebar 的 hoverActionClassName）。
const HOVER_ACTION = cn(
	"inline-flex h-5 w-5 items-center justify-center rounded-sm",
	"text-muted-foreground/70 transition-[opacity,background-color,color] duration-100",
	"opacity-0 pointer-events-none",
	"group-hover:opacity-100 group-hover:pointer-events-auto",
	"group-data-[menu-open]:opacity-100 group-data-[menu-open]:pointer-events-auto",
	"hover:text-foreground hover:bg-muted/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60",
);

/**
 * 两步确认的归档按钮（移植自 Lody sidebar-confirm-archive-button）：
 * 第一次点击进入 Confirm 状态，再次点击才执行，失焦 / 移出 / Esc 复位。
 */
function ConfirmArchiveButton({
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
				"inline-flex items-center justify-center rounded-sm",
				"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-sidebar-ring/40",
				confirming
					? "relative z-10 h-5 min-w-10 overflow-hidden whitespace-nowrap rounded-full border border-destructive/20 bg-sidebar px-2 text-[11px] font-medium leading-none text-destructive shadow-xs transition-none hover:bg-sidebar hover:text-destructive"
					: "h-5 w-5 text-sidebar-foreground-muted/80 transition-[opacity,color,background-color] duration-100 hover:text-sidebar-foreground",
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
				<Archive className="h-3.5 w-3.5" />
			)}
		</button>
	);
}

// ---- 环境行 ---------------------------------------------------------------

export function EnvRow({
	env,
	collapsed,
	onToggle,
	onAddProject,
}: {
	env: SidebarEnv;
	collapsed: boolean;
	onToggle: () => void;
	onAddProject?: (connectionId: string) => void;
}) {
	const toggleLabel = collapsed ? "展开环境" : "折叠环境";
	return (
		<div className="group flex h-7 items-center gap-1 rounded-md pr-2">
			<button
				type="button"
				aria-label={toggleLabel}
				aria-expanded={!collapsed}
				onClick={onToggle}
				className={cn(
					"relative flex h-7 min-w-0 flex-1 select-none items-center gap-1.5 rounded-md border border-transparent bg-transparent px-2 text-left",
					"text-[13px] font-medium text-sidebar-foreground-muted transition-colors hover:text-sidebar-foreground",
					"focus-visible:outline-hidden focus-visible:shadow-none",
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
						className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/80 transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
						aria-label={`在 ${env.name} 添加工作区`}
						onClick={(event) => {
							event.stopPropagation();
							onAddProject?.(env.id);
						}}
					>
						<Plus className="h-3.5 w-3.5" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="right">添加工作区</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground/80 transition-colors hover:bg-muted/30 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60"
						aria-label="连接设置"
						onClick={(event) => event.stopPropagation()}
					>
						<SlidersHorizontal className="h-3.5 w-3.5" />
					</button>
				</TooltipTrigger>
				<TooltipContent side="right">连接设置</TooltipContent>
			</Tooltip>
		</div>
	);
}

// ---- 工作区行 -------------------------------------------------------------

export function ProjectRow({
	project,
	env,
	collapsed,
	onToggle,
	onNewChat,
	onArchiveSessions,
	onRefreshSessions,
	hasSessions,
}: {
	project: SidebarProject;
	env: SidebarEnv;
	collapsed: boolean;
	onToggle: () => void;
	onNewChat?: (projectId: string) => void;
	onArchiveSessions?: () => void;
	onRefreshSessions?: () => void;
	hasSessions: boolean;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const toggleLabel = collapsed ? "展开工作区" : "折叠工作区";
	return (
		<Tooltip delayDuration={600}>
			<TooltipTrigger asChild>
				{/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 内嵌图标按钮，不能用原生 button */}
				<div
					role="button"
					tabIndex={0}
					aria-label={toggleLabel}
					aria-expanded={!collapsed}
					data-menu-open={menuOpen || undefined}
					onClick={onToggle}
					onKeyDown={(event) => {
						if (event.target !== event.currentTarget) return;
						if (event.key !== "Enter" && event.key !== " ") return;
						event.preventDefault();
						onToggle();
					}}
					className={cn(
						"group relative flex min-w-0 w-full cursor-pointer select-none items-center gap-2 rounded-md border border-transparent bg-transparent py-1 pl-2 pr-3 text-left text-xs font-semibold transition-colors",
						"text-sidebar-foreground dark:text-sidebar-foreground/75",
						"hover:bg-sidebar-hover hover:text-sidebar-hover-foreground data-[menu-open]:bg-sidebar-hover data-[menu-open]:text-sidebar-hover-foreground",
						"focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-sidebar-ring/40",
					)}
				>
					<button
						type="button"
						className="relative -mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center"
						aria-label={toggleLabel}
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							onToggle();
						}}
					>
						<Folder className="absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-current opacity-80 transition-opacity duration-100 group-hover:opacity-0" />
						<ChevronDown
							className={cn(
								"absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 text-current transition-[opacity,transform] duration-100",
								"opacity-0 group-hover:opacity-100",
								collapsed ? "-rotate-90" : "rotate-0",
							)}
						/>
					</button>
					<span className="min-w-0 flex-1 truncate text-left">
						{project.name}
					</span>
					<div className="flex shrink-0 items-center gap-0.5">
						<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label="工作区菜单"
									className={HOVER_ACTION}
									onClick={(event) => event.stopPropagation()}
								>
									<MoreHorizontal className="h-3.5 w-3.5" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start">
								<DropdownMenuItem onSelect={() => onRefreshSessions?.()}>
									<RefreshCw className={menuItemIconClassName} />
									刷新对话
								</DropdownMenuItem>
								<DropdownMenuItem
									disabled={!hasSessions}
									onSelect={() => onArchiveSessions?.()}
								>
									<Archive className={menuItemIconClassName} />
									归档对话
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
						<button
							type="button"
							aria-label="新建对话"
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
					<span className="break-all font-mono text-[11px] leading-snug">
						{project.path}
					</span>
				</div>
			</TooltipContent>
		</Tooltip>
	);
}

// ---- 会话行 ---------------------------------------------------------------

export function SessionRow({
	session,
	project,
	env,
	now,
	selected,
	onSelect,
	onTogglePin,
	onArchive,
	onRestore,
	onRename,
}: {
	session: SidebarSession;
	project?: SidebarProject;
	env?: SidebarEnv;
	now: Date;
	selected: boolean;
	onSelect: () => void;
	onTogglePin?: (sessionId: string, pinned: boolean) => void;
	onArchive?: (sessionId: string) => void;
	onRestore?: (sessionId: string) => void;
	onRename?: (sessionId: string, title: string) => void;
}) {
	const [menuOpen, setMenuOpen] = useState(false);
	const [renaming, setRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(session.title);
	const renameInputRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		if (renaming) renameInputRef.current?.focus();
	}, [renaming]);
	const submitRename = () => {
		const title = renameValue.trim();
		if (title && title !== session.title) onRename?.(session.id, title);
		setRenaming(false);
	};
	return (
		<SessionInfoHoverCard
			now={now}
			title={session.title}
			latestMessageAt={session.latestMessageAt}
			projectName={project?.name}
			envName={env?.name}
		>
			{/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- 内嵌图标按钮，不能用原生 button */}
			<div
				role="button"
				tabIndex={0}
				aria-label={session.title}
				aria-current={selected ? "page" : undefined}
				data-menu-open={menuOpen || undefined}
				onClick={onSelect}
				onKeyDown={(event) => {
					if (event.target !== event.currentTarget) return;
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					onSelect();
				}}
				className={cn(
					"group relative w-full min-w-0 cursor-pointer select-none rounded-md border border-transparent bg-transparent px-2 py-1 text-left transition-colors",
					"hover:bg-sidebar-hover hover:text-sidebar-hover-foreground data-[menu-open]:bg-sidebar-hover",
					"focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sidebar-ring/40",
					selected &&
						"border-sidebar-foreground/10 bg-sidebar-foreground/10 text-sidebar-foreground hover:bg-sidebar-foreground/10",
				)}
			>
				<div className="flex w-full min-w-0 items-center gap-1.5">
					<div className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center">
						<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
							<DropdownMenuTrigger asChild>
								<button
									type="button"
									aria-label="更多操作"
									onClick={(event) => event.stopPropagation()}
									className={cn(
										"absolute left-1/2 top-1/2 z-20 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md opacity-0 pointer-events-none",
										"group-hover:pointer-events-auto group-hover:opacity-100 group-data-[menu-open]:pointer-events-auto group-data-[menu-open]:opacity-100",
										"text-sidebar-foreground-muted transition-[opacity,color,background-color] duration-100",
										"hover:bg-sidebar-foreground/15 hover:text-sidebar-foreground",
										"group-data-[menu-open]:bg-sidebar-foreground/15 group-data-[menu-open]:text-sidebar-foreground",
									)}
								>
									<MoreHorizontal className="h-3.5 w-3.5" />
								</button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start">
								<DropdownMenuItem
									onSelect={() => onTogglePin?.(session.id, !session.pinned)}
								>
									{session.pinned ? (
										<PinOff className={menuItemIconClassName} />
									) : (
										<Pin className={menuItemIconClassName} />
									)}
									{session.pinned ? "取消置顶" : "置顶"}
								</DropdownMenuItem>
								<DropdownMenuItem
									onSelect={() => {
										setRenameValue(session.title);
										setRenaming(true);
									}}
								>
									<Pencil className={menuItemIconClassName} />
									重命名
								</DropdownMenuItem>
								{session.archived ? (
									<DropdownMenuItem onSelect={() => onRestore?.(session.id)}>
										<ArchiveRestore className={menuItemIconClassName} />
										恢复
									</DropdownMenuItem>
								) : (
									<DropdownMenuItem onSelect={() => onArchive?.(session.id)}>
										<Archive className={menuItemIconClassName} />
										归档
									</DropdownMenuItem>
								)}
							</DropdownMenuContent>
						</DropdownMenu>
					</div>
					{renaming ? (
						<input
							ref={renameInputRef}
							value={renameValue}
							onClick={(event) => event.stopPropagation()}
							onChange={(event) => setRenameValue(event.target.value)}
							onBlur={submitRename}
							onKeyDown={(event) => {
								event.stopPropagation();
								if (event.key === "Enter") submitRename();
								if (event.key === "Escape") {
									setRenameValue(session.title);
									setRenaming(false);
								}
							}}
							className="min-w-0 flex-1 rounded-sm bg-transparent px-1 text-sm outline-none ring-1 ring-sidebar-ring/50"
						/>
					) : (
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
					)}
					<div className="relative flex h-5 min-w-5 shrink-0 items-center justify-center pointer-events-none">
						<span
							aria-hidden="true"
							className="flex items-center justify-center transition-opacity duration-100 group-hover:opacity-0 group-data-[menu-open]:opacity-0"
						>
							{session.active ? (
								<span className="size-1.5 rounded-full bg-primary" />
							) : null}
						</span>
						{!session.archived ? (
							<ConfirmArchiveButton
								label="归档"
								confirmLabel="确认"
								className={cn(
									"absolute right-0 top-0 z-20",
									"opacity-0 pointer-events-none group-hover:pointer-events-auto group-hover:opacity-100",
									"group-data-[menu-open]:pointer-events-auto group-data-[menu-open]:opacity-100",
								)}
								onConfirm={() => onArchive?.(session.id)}
							/>
						) : null}
					</div>
				</div>
			</div>
		</SessionInfoHoverCard>
	);
}

/* oxlint-disable jsx-a11y/prefer-tag-over-role -- session rows contain independent action buttons; native outer buttons would create invalid nested interactive controls. */
import {
	memo,
	useCallback,
	useEffect,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
	type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Folder, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	ActivityDot,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";
import { menuItemIconClassName } from "@/ui/menu-styles";
import type { SidebarSession } from "./types";

/** 两步确认的删除按钮；失焦、移出或 Esc 时复位。 */
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
			aria-label={confirming ? confirmLabel : label}
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
	const { t } = useTranslation();
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
										aria-label={t("sidebar.moreActions")}
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
										{t("sidebar.rename")}
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
											{confirmingDeleteMenu
												? t("sidebar.confirmDelete")
												: t("sidebar.delete")}
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
									aria-label={t("sidebar.editSessionTitle")}
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
									className="flex h-4 min-w-0 items-center gap-1 text-2xs leading-tight text-sidebar-foreground-muted"
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
									<ActivityDot className="text-sidebar-primary" />
								) : session.unread ? (
									<span
										aria-hidden="true"
										className="inline-block size-1.5 shrink-0 rounded-full bg-sidebar-primary"
									/>
								) : null}
							</span>
							{onDelete ? (
								<ConfirmDeleteButton
									label={t("sidebar.delete")}
									confirmLabel={t("sidebar.confirmDelete")}
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

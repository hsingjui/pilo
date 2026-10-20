import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	ChevronDown,
	Folder,
	Monitor,
	MoreHorizontal,
	RefreshCw,
	SquarePen,
	Trash2,
} from "lucide-react";
import { useSessionRefresh } from "@/components/sidebar/use-session-refresh";
import { menuItemIconClassName } from "@/ui/menu-styles";

import type {
	SidebarEnv,
	SidebarProject,
	SidebarSession,
} from "@/components/sidebar/types";
import { cn } from "@/lib/utils";
import {
	ActivityDot,
	Button,
	Spinner,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui";

/** 触摸端行内按钮：始终可见，且命中区不小于 44×44。 */
export const ROW_ACTION_CLASS =
	"pilo-mobile-row-action flex shrink-0 items-center justify-center rounded-md text-sidebar-foreground-muted transition-colors duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-sidebar-hover hover:text-sidebar-foreground active:bg-sidebar-hover active:text-sidebar-foreground motion-reduce:transition-none";

export function MobileSessionRow({
	session,
	selected,
	projectName,
	confirmingDelete,
	onSelect,
	onRequestDelete,
	onCancelDelete,
	onConfirmDelete,
	onRefresh,
}: {
	session: SidebarSession;
	selected: boolean;
	projectName?: string;
	confirmingDelete: boolean;
	onSelect: (sessionId: string, projectId: string) => void;
	onRequestDelete: (sessionId: string) => void;
	onCancelDelete: () => void;
	onConfirmDelete: () => void;
	onRefresh: (sessionId: string, projectId: string) => Promise<void>;
}) {
	const { t } = useTranslation();
	const { refresh, disabled: refreshDisabled } = useSessionRefresh(
		session,
		onRefresh,
	);
	const timerRef = useRef<number | null>(null);
	const firedRef = useRef(false);
	const sessionButtonRef = useRef<HTMLButtonElement>(null);
	const cancelButtonRef = useRef<HTMLButtonElement>(null);
	const wasConfirmingRef = useRef(false);
	useEffect(() => {
		if (confirmingDelete) cancelButtonRef.current?.focus();
		else if (wasConfirmingRef.current) sessionButtonRef.current?.focus();
		wasConfirmingRef.current = confirmingDelete;
	}, [confirmingDelete]);
	const startRef = useRef<{ x: number; y: number } | null>(null);

	const clearTimer = () => {
		if (timerRef.current !== null) {
			window.clearTimeout(timerRef.current);
			timerRef.current = null;
		}
	};
	useEffect(
		() => () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		},
		[],
	);

	if (confirmingDelete) {
		return (
			<div
				data-project-context={Boolean(projectName) || undefined}
				className={cn(
					"pilo-mobile-session-row pilo-mobile-session-confirm flex w-full min-w-0 items-center gap-2 rounded-md bg-sidebar",
					selected &&
						"bg-(--pilo-mobile-confirm-selected-background) ring-[length:var(--pilo-mobile-selected-ring-width)] ring-inset ring-sidebar-foreground/10 pilo-mobile-selected",
				)}
			>
				<span className="flex h-5 w-4 shrink-0 items-center justify-center">
					{!session.active && session.unread ? (
						<span
							aria-hidden="true"
							className="size-1.5 rounded-full bg-sidebar-primary -translate-y-px"
						/>
					) : null}
				</span>
				<span
					className={cn(
						"min-w-0 flex-1 truncate text-sm",
						selected
							? "text-sidebar-selection-foreground"
							: "text-sidebar-foreground",
					)}
					title={session.title}
				>
					{session.title}
				</span>
				<div className="flex shrink-0 items-center">
					<Button
						type="button"
						variant="ghost"
						className="h-11 px-2 text-sidebar-foreground active:bg-sidebar-hover motion-reduce:transition-none motion-reduce:active:scale-100"
						ref={cancelButtonRef}
						onClick={onCancelDelete}
					>
						{t("common.cancel")}
					</Button>
					<Button
						type="button"
						variant="ghost"
						className="h-11 px-2 text-destructive hover:bg-sidebar-hover/40 hover:text-destructive active:bg-sidebar-hover/60 motion-reduce:transition-none motion-reduce:active:scale-100"
						aria-label={`${t("common.delete")}: ${session.title}`}
						onClick={onConfirmDelete}
					>
						{t("common.delete")}
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"flex min-w-0 items-center rounded-md transition-colors duration-[var(--dur-1)] ease-[var(--ease)] motion-reduce:transition-none",
				selected &&
					"bg-(--pilo-mobile-selected-background) ring-[length:var(--pilo-mobile-selected-ring-width)] ring-inset ring-sidebar-foreground/10 pilo-mobile-selected",
			)}
		>
			<button
				type="button"
				data-session-row=""
				data-project-context={Boolean(projectName) || undefined}
				ref={sessionButtonRef}
				aria-current={selected ? "page" : undefined}
				className={cn(
					// 长按删除与 iOS 的文字选择/长按弹窗冲突，一并关掉。
					"pilo-mobile-session-row flex min-w-0 flex-1 touch-manipulation select-none gap-2 rounded-md text-left transition-colors duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-sidebar-hover active:bg-sidebar-hover motion-reduce:transition-none [-webkit-touch-callout:none]",
					projectName ? "items-start" : "items-center",
					selected
						? "text-sidebar-selection-foreground"
						: "text-sidebar-foreground",
				)}
				onClick={() => {
					if (firedRef.current) {
						firedRef.current = false;
						return;
					}
					onSelect(session.id, session.projectId);
				}}
				onContextMenu={(event) => event.preventDefault()}
				onKeyDown={(event) => {
					if (
						event.key === "ContextMenu" ||
						(event.shiftKey && event.key === "F10")
					) {
						event.preventDefault();
						onRequestDelete(`${session.projectId}:${session.id}`);
					}
				}}
				onPointerDown={(event) => {
					// 鼠标/触控板不做长按，避免桌面误触。
					if (event.pointerType === "mouse") return;
					firedRef.current = false;
					startRef.current = { x: event.clientX, y: event.clientY };
					clearTimer();
					timerRef.current = window.setTimeout(() => {
						timerRef.current = null;
						firedRef.current = true;
						// Android 触觉得到长按已触发的反馈；iOS Safari 不支持，静默忽略。
						navigator.vibrate?.(10);
						onRequestDelete(`${session.projectId}:${session.id}`);
					}, 500);
				}}
				onPointerMove={(event) => {
					const start = startRef.current;
					if (!start || timerRef.current === null) return;
					if (
						Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10
					) {
						clearTimer();
					}
				}}
				onPointerUp={clearTimer}
				onPointerLeave={clearTimer}
				onPointerCancel={() => {
					clearTimer();
					firedRef.current = false;
				}}
			>
				<span className="flex h-5 w-4 shrink-0 items-center justify-center">
					{!session.active && session.unread ? (
						<span
							aria-hidden="true"
							className="size-1.5 rounded-full bg-sidebar-primary -translate-y-px"
						/>
					) : null}
				</span>
				<span className="min-w-0 flex-1">
					<span
						className={cn(
							"block truncate text-sm leading-5",
							(selected || session.unread) && "font-medium",
						)}
						title={session.title}
					>
						{session.title}
					</span>
					{projectName ? (
						<span className="mt-1 flex items-center gap-1.5 text-xs leading-4 text-sidebar-foreground-muted">
							<Folder
								className="size-3 shrink-0 opacity-80"
								aria-hidden="true"
							/>
							<span className="min-w-0 truncate">{projectName}</span>
						</span>
					) : null}
				</span>
				{/* 保留右侧运行状态槽，避免状态变化时标题宽度跳动。 */}
				<span className="flex h-5 w-4 shrink-0 items-center justify-center">
					{session.active ? (
						<ActivityDot className="text-sidebar-primary -translate-y-px" />
					) : null}
				</span>
			</button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<button
						type="button"
						className={ROW_ACTION_CLASS}
						aria-label={t("sidebar.moreActions")}
					>
						<MoreHorizontal className="size-4" />
					</button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-0 w-40">
					<DropdownMenuItem
						disabled={refreshDisabled}
						onSelect={() => void refresh()}
					>
						<RefreshCw className={menuItemIconClassName} />
						{t("chat.refreshSession")}
					</DropdownMenuItem>
					<DropdownMenuItem
						className="text-destructive focus:text-destructive"
						onSelect={() =>
							onRequestDelete(`${session.projectId}:${session.id}`)
						}
					>
						<Trash2 className={menuItemIconClassName} />
						{t("common.delete")}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}

export function MobileProjectRow({
	project,
	expanded,
	selected,
	sessionCount,
	refreshing,
	onToggle,
	onNewChat,
}: {
	project: SidebarProject;
	expanded: boolean;
	selected: boolean;
	sessionCount: number;
	refreshing: boolean;
	onToggle: () => void;
	onNewChat: (projectId: string) => void;
}) {
	const { t } = useTranslation();
	return (
		<div
			className={cn(
				"pilo-mobile-project-group flex min-w-0 items-center rounded-md",
				selected &&
					"bg-(--pilo-mobile-selected-background) ring-[length:var(--pilo-mobile-selected-ring-width)] ring-inset ring-sidebar-foreground/10 pilo-mobile-selected",
			)}
		>
			<button
				type="button"
				aria-expanded={expanded}
				className="pilo-mobile-project-row flex min-w-0 flex-1 items-center gap-2 rounded-md text-left transition-colors duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-sidebar-hover active:bg-sidebar-hover motion-reduce:transition-none"
				onClick={onToggle}
			>
				<Folder
					className="size-4 shrink-0 text-sidebar-foreground-muted"
					aria-hidden="true"
				/>
				<span
					className={cn(
						"min-w-0 flex-1 truncate text-sm",
						selected ? "font-semibold" : "font-medium",
					)}
					title={project.name}
				>
					{project.name}
				</span>
				{refreshing ? (
					<Spinner className="size-3.5 shrink-0 text-sidebar-foreground-muted" />
				) : sessionCount > 0 ? (
					<span className="shrink-0 text-xs tabular-nums text-sidebar-foreground-muted">
						{sessionCount}
					</span>
				) : null}
				<span className="flex h-5 w-4 shrink-0 items-center justify-center">
					<ChevronDown
						aria-hidden="true"
						className={cn(
							"size-3.5 text-sidebar-foreground-muted transition-transform duration-[var(--dur-1)] ease-[var(--ease)] motion-reduce:transition-none",
							!expanded && "-rotate-90",
						)}
					/>
				</span>
			</button>
			<button
				type="button"
				className={ROW_ACTION_CLASS}
				aria-label={t("sidebar.newSession")}
				onClick={() => onNewChat(project.id)}
			>
				<SquarePen className="size-4" aria-hidden="true" />
			</button>
		</div>
	);
}

export function MobileEnvRow({
	env,
	expanded,
	onToggle,
}: {
	env: SidebarEnv;
	expanded: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			aria-expanded={expanded}
			className="pilo-mobile-env-row flex w-full min-w-0 items-center gap-2 rounded-md text-left text-sidebar-foreground-muted transition-colors duration-[var(--dur-1)] ease-[var(--ease)] hover:bg-sidebar-hover active:bg-sidebar-hover motion-reduce:transition-none"
			onClick={onToggle}
		>
			<Monitor className="size-4 shrink-0" aria-hidden="true" />
			<span
				className="min-w-0 flex-1 truncate text-xs font-medium"
				title={env.name}
			>
				{env.name}
			</span>
			<span className="flex h-5 w-4 shrink-0 items-center justify-center">
				<ChevronDown
					aria-hidden="true"
					className={cn(
						"size-3.5 transition-transform duration-[var(--dur-1)] ease-[var(--ease)] motion-reduce:transition-none",
						!expanded && "-rotate-90",
					)}
				/>
			</span>
		</button>
	);
}

import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Folder, Monitor, SquarePen } from "lucide-react";

import type {
	SidebarEnv,
	SidebarProject,
	SidebarSession,
} from "@/components/sidebar/types";
import { cn } from "@/lib/utils";
import { ActivityDot, Spinner } from "@/ui";

/** 触摸端行内按钮：始终可见，且命中区不小于 36×36。 */
export const ROW_ACTION_CLASS =
	"flex size-9 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground-muted transition-colors active:bg-sidebar-hover";

export function MobileSessionRow({
	session,
	selected,
	projectName,
	confirmingDelete,
	onSelect,
	onRequestDelete,
	onCancelDelete,
	onConfirmDelete,
}: {
	session: SidebarSession;
	selected: boolean;
	projectName?: string;
	confirmingDelete: boolean;
	onSelect: (sessionId: string) => void;
	onRequestDelete: (sessionId: string) => void;
	onCancelDelete: () => void;
	onConfirmDelete: () => void;
}) {
	const { t } = useTranslation();
	const timerRef = useRef<number | null>(null);
	const firedRef = useRef(false);
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
			<div className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg bg-destructive/10 px-3 py-1.5">
				<span className="min-w-0 flex-1 truncate text-sm text-destructive">
					{session.title}
				</span>
				<button
					type="button"
					className="shrink-0 rounded-md px-2.5 py-1.5 text-xs text-sidebar-foreground-muted active:bg-sidebar-hover"
					onClick={onCancelDelete}
				>
					{t("common.cancel")}
				</button>
				<button
					type="button"
					className="shrink-0 rounded-md bg-destructive px-2.5 py-1.5 text-xs font-medium text-destructive-foreground active:opacity-90"
					onClick={onConfirmDelete}
				>
					{t("common.delete")}
				</button>
			</div>
		);
	}

	return (
		<button
			type="button"
			data-session-row=""
			aria-current={selected ? "page" : undefined}
			className={cn(
				// 长按删除与 iOS 的文字选择/长按弹窗冲突，一并关掉。
				"flex min-h-11 w-full min-w-0 touch-manipulation select-none items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors [-webkit-touch-callout:none]",
				selected
					? "bg-sidebar-foreground/10 text-sidebar-foreground"
					: "text-sidebar-foreground/85 active:bg-sidebar-hover",
			)}
			onClick={() => {
				if (firedRef.current) {
					firedRef.current = false;
					return;
				}
				onSelect(session.id);
			}}
			onContextMenu={(event) => event.preventDefault()}
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
					onRequestDelete(session.id);
				}, 500);
			}}
			onPointerMove={(event) => {
				const start = startRef.current;
				if (!start || timerRef.current === null) return;
				if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
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
			{/* 左侧固定槽：未读标记，与桌面侧栏保持一致（左未读 / 右运行）。 */}
			<span className="flex size-4 shrink-0 items-center justify-center">
				{!session.active && session.unread ? (
					<span
						aria-hidden="true"
						className="size-1.5 rounded-full bg-sidebar-primary"
					/>
				) : null}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-sm">{session.title}</span>
				{projectName ? (
					<span className="mt-0.5 flex items-center gap-1 text-2xs text-sidebar-foreground-muted">
						<Folder className="size-3 shrink-0 opacity-80" aria-hidden="true" />
						<span className="min-w-0 truncate">{projectName}</span>
					</span>
				) : null}
			</span>
			{/* 右侧固定槽：运行状态，与左侧未读槽共同预留宽度，标题不再占满整行。 */}
			<span className="flex size-4 shrink-0 items-center justify-center">
				{session.active ? (
					<ActivityDot className="text-sidebar-primary" />
				) : null}
			</span>
		</button>
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
				"flex min-h-11 items-center gap-0.5 rounded-lg pr-1",
				selected && "bg-sidebar-foreground/10",
			)}
		>
			<button
				type="button"
				aria-expanded={expanded}
				className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg px-3 text-left active:bg-sidebar-hover"
				onClick={onToggle}
			>
				<Folder className="size-4 shrink-0 opacity-80" aria-hidden="true" />
				<span className="min-w-0 flex-1 truncate text-sm font-medium">
					{project.name}
				</span>
				{refreshing ? (
					<Spinner className="size-3.5 shrink-0 text-sidebar-foreground-muted" />
				) : sessionCount > 0 ? (
					<span className="shrink-0 text-2xs text-sidebar-foreground-muted">
						{sessionCount}
					</span>
				) : null}
				<ChevronDown
					aria-hidden="true"
					className={cn(
						"size-4 shrink-0 text-sidebar-foreground-muted transition-transform duration-150 ease-out",
						!expanded && "-rotate-90",
					)}
				/>
			</button>
			<button
				type="button"
				className={ROW_ACTION_CLASS}
				aria-label={t("sidebar.newSession")}
				onClick={() => onNewChat(project.id)}
			>
				<SquarePen className="size-4" />
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
			className="flex min-h-9 w-full items-center gap-2 rounded-lg px-3 text-left text-sidebar-foreground-muted"
			onClick={onToggle}
		>
			<Monitor className="size-3.5 shrink-0 opacity-80" aria-hidden="true" />
			<span className="min-w-0 flex-1 truncate text-xs font-medium uppercase tracking-wide">
				{env.name}
			</span>
			<ChevronDown
				aria-hidden="true"
				className={cn(
					"size-3.5 shrink-0 transition-transform duration-150 ease-out",
					!expanded && "-rotate-90",
				)}
			/>
		</button>
	);
}

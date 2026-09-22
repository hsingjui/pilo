import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 聊天列里短暂出现的状态提示：本身不是内容，所以用 `muted` 一步、一条 hairline，
 * 不带阴影、不抢 accent。列表形态由调用方补 `overflow-hidden`，单块形态补 `px-3 py-2`。
 */
const NOTICE_SURFACE_CLASS =
	"mb-1 block min-w-0 rounded-xl border border-border/60 bg-muted text-xs";

export type NoticeTone = "info" | "success" | "warning" | "danger";

const NOTICE_TONE_CLASS: Record<NoticeTone, string> = {
	info: "text-muted-foreground",
	success: "text-status-success",
	warning: "text-status-warning",
	danger: "text-status-danger",
};

export function NoticeCard({
	children,
	className: classNameProp,
	announce,
	ariaLive,
}: {
	children: ReactNode;
	className?: string;
	/** 无障碍播报语义；`status` 落到原生 `<output>`，`alert` 用带隐式 role 的 `<div>`。 */
	announce?: "status" | "alert";
	ariaLive?: "polite" | "assertive";
}) {
	const className = cn(NOTICE_SURFACE_CLASS, classNameProp);

	if (announce === "status") {
		return (
			<output aria-live={ariaLive} className={className}>
				{children}
			</output>
		);
	}

	if (announce === "alert") {
		return (
			<div role="alert" aria-live={ariaLive} className={className}>
				{children}
			</div>
		);
	}

	return <div className={className}>{children}</div>;
}

/** 状态图标：14px，与首行文字光学对齐。语气只改颜色，不引入新色相。 */
export function NoticeIcon({
	icon: Icon,
	tone = "info",
	className,
}: {
	icon: ComponentType<{ className?: string }>;
	tone?: NoticeTone;
	className?: string;
}) {
	return (
		<Icon
			aria-hidden="true"
			className={cn(
				"mt-0.5 size-3.5 shrink-0",
				NOTICE_TONE_CLASS[tone],
				className,
			)}
		/>
	);
}

/** 列表形态的表头：标题在左，条目数在右。 */
export function NoticeCardHeader({
	title,
	count,
}: {
	title: ReactNode;
	count?: number;
}) {
	return (
		<div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
			<span className="font-medium text-foreground/80">{title}</span>
			{count === undefined ? null : (
				<span className="tabular-nums">{count}</span>
			)}
		</div>
	);
}

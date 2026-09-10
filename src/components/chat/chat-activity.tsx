import { useState, type ReactNode } from "react";
import { Brain, ChevronRight, FileCode2, LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

export type ChatActivityStatus = "complete" | "running";

export type ThinkingActivity = {
	summary: string;
	detail?: string;
	duration?: string;
	status?: ChatActivityStatus;
};

export type ToolCallActivity = {
	label: string;
	items: string[];
	duration?: string;
	status?: ChatActivityStatus;
};

function ActivityDisclosure({
	label,
	duration,
	status = "complete",
	icon,
	children,
	defaultOpen = false,
}: {
	label: string;
	duration?: string;
	status?: ChatActivityStatus;
	icon: ReactNode;
	children?: ReactNode;
	defaultOpen?: boolean;
}) {
	const [open, setOpen] = useState(defaultOpen || status === "running");
	const running = status === "running";
	const expandable = Boolean(children);

	return (
		<div className="my-2.5 w-full text-xs text-muted-foreground">
			<button
				type="button"
				className={cn(
					"group/activity flex max-w-full items-center gap-1.5 rounded-md py-1 text-left transition-colors duration-100",
					expandable ? "hover:text-foreground" : "cursor-default",
				)}
				onClick={() => expandable && setOpen((value) => !value)}
				aria-expanded={expandable ? open : undefined}
			>
				{running ? (
					<LoaderCircle className="size-3.5 shrink-0 animate-spin" />
				) : expandable ? (
					<ChevronRight
						className={cn(
							"size-3.5 shrink-0 transition-transform duration-150",
							open && "rotate-90",
						)}
					/>
				) : (
					<span className="flex size-3.5 shrink-0 items-center justify-center">
						{icon}
					</span>
				)}
				{expandable ? (
					<span className="flex size-3.5 shrink-0 items-center justify-center opacity-75">
						{icon}
					</span>
				) : null}
				<span className="truncate">{label}</span>
				{duration ? (
					<span className="shrink-0 text-muted-foreground/60">
						· {duration}
					</span>
				) : null}
			</button>
			{expandable && open ? (
				<div className="ml-1.5 mt-1 border-l border-border/80 pl-4">
					{children}
				</div>
			) : null}
		</div>
	);
}

export function ThinkingActivityView({
	activity,
}: {
	activity: ThinkingActivity;
}) {
	return (
		<ActivityDisclosure
			label={activity.summary}
			duration={activity.duration}
			status={activity.status}
			icon={<Brain className="size-3.5" />}
		>
			{activity.detail ? (
				<p className="max-w-prose py-1 text-xs leading-5 text-muted-foreground">
					{activity.detail}
				</p>
			) : null}
		</ActivityDisclosure>
	);
}

export function ToolCallActivityView({
	activity,
}: {
	activity: ToolCallActivity;
}) {
	return (
		<ActivityDisclosure
			label={activity.label}
			duration={activity.duration}
			status={activity.status}
			icon={<FileCode2 className="size-3.5" />}
		>
			<div className="grid gap-0.5 py-0.5">
				{activity.items.map((item) => (
					<div
						key={item}
						className="flex items-center gap-2 py-1 font-mono text-[11px]"
					>
						<FileCode2 className="size-3.5 shrink-0 opacity-70" />
						<span className="truncate">{item}</span>
					</div>
				))}
			</div>
		</ActivityDisclosure>
	);
}

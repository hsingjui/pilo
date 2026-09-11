import { useState, type ReactNode } from "react";
import {
	BookOpen,
	ChevronRight,
	CircleAlert,
	FileText,
	LoaderCircle,
	PencilLine,
	Search,
	Sparkles,
	Terminal,
	Wrench,
} from "lucide-react";

import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { formatWorkDuration } from "@/lib/format-duration";
import { usePreferences } from "@/lib/preferences-provider";
import { cn } from "@/lib/utils";

export type ChatActivityStatus = "complete" | "running";

export type ThinkingActivity = {
	id: string;
	type: "thinking";
	text: string;
	status: ChatActivityStatus;
};

export type ToolCallActivity = {
	id: string;
	type: "tool";
	toolName: string;
	args?: unknown;
	result?: unknown;
	status: ChatActivityStatus;
	isError?: boolean;
};

export type AssistantActivity = ThinkingActivity | ToolCallActivity;

const PROCESS_TEXT_CLASS =
	"text-[12.5px] font-medium leading-snug text-muted-foreground";
const PROCESS_ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground";

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function formatUnknown(value: unknown) {
	if (typeof value === "string") return value;
	try {
		const serialized = JSON.stringify(value, null, 2);
		return serialized ?? String(value);
	} catch {
		return String(value);
	}
}

function extractResultText(value: unknown): string | null {
	if (!isRecord(value) || !Array.isArray(value.content)) return null;
	const text = value.content
		.map((block) => {
			if (!isRecord(block) || block.type !== "text") return null;
			return typeof block.text === "string" ? block.text : null;
		})
		.filter((part): part is string => Boolean(part))
		.join("\n");
	return text || null;
}

function ToolIcon({
	toolName,
	className,
}: {
	toolName: string;
	className?: string;
}) {
	switch (toolName.toLowerCase()) {
		case "bash":
		case "execute":
			return <Terminal className={className} />;
		case "read":
			return <BookOpen className={className} />;
		case "write":
			return <FileText className={className} />;
		case "edit":
			return <PencilLine className={className} />;
		case "search":
		case "grep":
		case "find":
			return <Search className={className} />;
		default:
			return <Wrench className={className} />;
	}
}

function toolPreview(activity: ToolCallActivity) {
	if (!isRecord(activity.args)) return null;
	for (const key of [
		"command",
		"path",
		"filePath",
		"query",
		"pattern",
		"url",
	]) {
		const value = activity.args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function toolFilePath(activity: ToolCallActivity) {
	if (!isRecord(activity.args)) return null;
	for (const key of ["path", "filePath"]) {
		const value = activity.args[key];
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return null;
}

function ActivityProcessStep({
	icon,
	children,
}: {
	icon: ReactNode;
	children: ReactNode;
}) {
	return (
		<div
			className={cn(
				"flex min-h-7 w-full items-start gap-1.5 py-1",
				PROCESS_TEXT_CLASS,
			)}
		>
			<span className="inline-flex shrink-0 pt-0.5">{icon}</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

function ThinkingActivityView({ activity }: { activity: ThinkingActivity }) {
	const running = activity.status === "running";
	const expandable = running || Boolean(activity.text);
	const [open, setOpen] = useState(running);

	return (
		<div className="w-full">
			<button
				type="button"
				className={cn(
					"group/thinking -mx-1 flex min-h-7 w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors",
					PROCESS_TEXT_CLASS,
					expandable
						? "hover:bg-muted/40 hover:text-foreground"
						: "cursor-default",
				)}
				onClick={() => expandable && setOpen((value) => !value)}
				aria-expanded={expandable ? open : undefined}
			>
				{expandable ? (
					<ChevronRight
						className={cn(
							PROCESS_ICON_CLASS,
							"transition-transform duration-150",
							open && "rotate-90",
						)}
					/>
				) : (
					<span className={PROCESS_ICON_CLASS} />
				)}
				<span className="min-w-0 flex-1 truncate">思考过程</span>
			</button>
			{expandable && open ? (
				<ActivityProcessStep icon={<Sparkles className={PROCESS_ICON_CLASS} />}>
					{activity.text ? (
						<ChatMarkdown
							text={activity.text}
							isStreaming={running}
							className={cn(
								"!text-[12.5px] !leading-[1.55] !text-muted-foreground",
								"[&_p]:!mb-1.5 [&_li:not(:first-child)]:!mt-0.5",
								"[&_:is(h1,h2,h3)]:!my-1 [&_:is(h1,h2,h3)]:!text-[12.5px] [&_:is(h1,h2,h3)]:!font-medium",
								"[&_[data-streamdown='code-block']]:!my-2",
							)}
						/>
					) : (
						<span>思考中…</span>
					)}
				</ActivityProcessStep>
			) : null}
		</div>
	);
}

function ToolDetail({ activity }: { activity: ToolCallActivity }) {
	const hasArgs = activity.args !== undefined && activity.args !== null;
	const hasResult = activity.result !== undefined && activity.result !== null;
	const resultText = hasResult
		? (extractResultText(activity.result) ?? formatUnknown(activity.result))
		: null;

	if (!hasArgs && !hasResult) return null;

	return (
		<div className="w-full pb-1 pt-0.5 text-[11px] font-normal text-muted-foreground/85">
			<div className="overflow-hidden rounded-md border border-border/60 bg-muted/20">
				{hasArgs ? (
					<pre className="scrollbar-pro max-h-44 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[10.5px] leading-4 [overflow-wrap:anywhere]">
						{formatUnknown(activity.args)}
					</pre>
				) : null}
				{resultText ? (
					<pre
						className={cn(
							"scrollbar-pro max-h-56 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[10.5px] leading-4 [overflow-wrap:anywhere]",
							hasArgs && "border-t border-border/50",
						)}
					>
						{resultText}
					</pre>
				) : null}
			</div>
		</div>
	);
}

function ToolCallActivityView({
	activity,
	onOpenPath,
}: {
	activity: ToolCallActivity;
	onOpenPath?: (path: string) => void;
}) {
	const running = activity.status === "running";
	// 详情默认收起（含运行中），点击行切换；key 含 status，完成后 remount 自动收起
	const [open, setOpen] = useState(false);
	const preview = toolPreview(activity);
	const filePath = toolFilePath(activity);
	const hasDetails =
		(activity.args !== undefined && activity.args !== null) ||
		(activity.result !== undefined && activity.result !== null);

	return (
		<div className="w-full">
			<button
				type="button"
				className={cn(
					"group/tool -mx-1 flex min-h-7 w-[calc(100%+0.5rem)] items-start gap-1.5 rounded-md px-1 py-1 text-left transition-colors",
					PROCESS_TEXT_CLASS,
					hasDetails
						? "hover:bg-muted/40 hover:text-foreground"
						: "cursor-default",
					activity.isError && "text-destructive",
				)}
				onClick={() => hasDetails && setOpen((value) => !value)}
				onDoubleClick={() => filePath && onOpenPath?.(filePath)}
				title={filePath && onOpenPath ? "双击打开文件" : undefined}
				aria-expanded={hasDetails ? open : undefined}
			>
				<ToolIcon
					toolName={activity.toolName}
					className={cn(
						PROCESS_ICON_CLASS,
						"mt-0.5",
						activity.isError && "text-destructive",
					)}
				/>
				<span className="min-w-0 flex-1 truncate">
					<span>{activity.toolName}</span>
					{preview ? (
						<span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground/70">
							{preview}
						</span>
					) : null}
				</span>
				{activity.isError ? (
					<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
				) : running ? (
					<LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" />
				) : hasDetails ? (
					<ChevronRight
						className={cn(
							"mt-0.5 size-3.5 shrink-0 transition-transform duration-150",
							open && "rotate-90",
						)}
					/>
				) : null}
			</button>
			{hasDetails && open ? <ToolDetail activity={activity} /> : null}
		</div>
	);
}

function activityLabel(
	activity: AssistantActivity[],
	running: boolean,
	durationMs?: number,
) {
	const toolCount = activity.filter((item) => item.type === "tool").length;
	if (running) {
		let current: AssistantActivity | undefined;
		for (let index = activity.length - 1; index >= 0; index -= 1) {
			if (activity[index].status === "running") {
				current = activity[index];
				break;
			}
		}
		if (current?.type === "tool") return `正在运行 ${current.toolName}…`;
		if (current?.type === "thinking") return "思考中…";
		return "正在处理…";
	}
	if (durationMs !== undefined) {
		const duration = formatWorkDuration(durationMs);
		if (duration) return `工作了 ${duration}`;
	}
	if (toolCount === 0) return "已完成思考";
	return `已完成工作 · ${toolCount} 次工具调用`;
}

export function AssistantActivityView({
	activity,
	streaming,
	durationMs,
	onOpenPath,
}: {
	activity: AssistantActivity[];
	streaming: boolean;
	durationMs?: number;
	onOpenPath?: (path: string) => void;
}) {
	const { collapseCompletedActivity, showWorkDuration } = usePreferences();
	const [open, setOpen] = useState(streaming || !collapseCompletedActivity);
	const running = activity.some((item) => item.status === "running");
	if (activity.length === 0) return null;

	return (
		<div className="mb-2 mt-0.5 w-full text-muted-foreground">
			<button
				type="button"
				className={cn(
					"group/activity flex w-full items-center gap-1.5 rounded-md py-1 pr-1 text-left transition-colors hover:bg-muted/40 hover:text-foreground",
					PROCESS_TEXT_CLASS,
				)}
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
			>
				<ChevronRight
					className={cn(
						PROCESS_ICON_CLASS,
						"transition-transform duration-200",
						open && "rotate-90",
					)}
				/>
				<span className="min-w-0 flex-1 truncate">
					{activityLabel(
						activity,
						running,
						showWorkDuration ? durationMs : undefined,
					)}
				</span>
				{running ? (
					<LoaderCircle className="size-3.5 shrink-0 animate-spin" />
				) : null}
			</button>
			{open ? (
				<div className="space-y-0.5 pt-0.5">
					{activity.map((item) =>
						item.type === "thinking" ? (
							<ThinkingActivityView key={item.id} activity={item} />
						) : (
							<ToolCallActivityView
								key={`${item.id}-${item.status}`}
								activity={item}
								onOpenPath={onOpenPath}
							/>
						),
					)}
				</div>
			) : null}
		</div>
	);
}

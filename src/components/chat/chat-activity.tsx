import type { ReactNode } from "react";
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
import { useChatExpansionState } from "@/components/chat/chat-expansion-state";
import { summarizeAssistantActivity } from "@/lib/chat-activity-state";
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

function resultContent(value: unknown): {
	blocks: unknown[];
	metadata: Record<string, unknown> | null;
	fallback: string | null;
} {
	if (!isRecord(value)) {
		return { blocks: [], metadata: null, fallback: formatUnknown(value) };
	}
	const blocks = Array.isArray(value.content) ? value.content : [];
	const metadata = Object.fromEntries(
		Object.entries(value).filter(([key]) => key !== "content"),
	);
	return {
		blocks,
		metadata: Object.keys(metadata).length > 0 ? metadata : null,
		fallback:
			blocks.length === 0 && Object.keys(metadata).length === 0
				? formatUnknown(value)
				: null,
	};
}

function toolResultBlockKey(block: unknown): string {
	if (typeof block === "string") return `text:${block.slice(0, 96)}`;
	if (
		isRecord(block) &&
		block.type === "text" &&
		typeof block.text === "string"
	) {
		return `text:${block.text.slice(0, 96)}`;
	}
	if (
		isRecord(block) &&
		block.type === "image" &&
		typeof block.data === "string"
	) {
		return `image:${String(block.mimeType)}:${block.data.length}:${block.data.slice(0, 32)}`;
	}
	return `value:${formatUnknown(block).slice(0, 128)}`;
}

function keyedToolResultBlocks(blocks: unknown[]) {
	const occurrences = new Map<string, number>();
	return blocks.map((block) => {
		const baseKey = toolResultBlockKey(block);
		const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
		occurrences.set(baseKey, occurrence);
		return { block, key: `${baseKey}:${occurrence}` };
	});
}

function ToolResultBlock({ block }: { block: unknown }) {
	if (typeof block === "string") {
		return (
			<pre className="scrollbar-pro max-h-56 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[10.5px] leading-4 [overflow-wrap:anywhere]">
				{block}
			</pre>
		);
	}
	if (
		isRecord(block) &&
		block.type === "text" &&
		typeof block.text === "string"
	) {
		return (
			<pre className="scrollbar-pro max-h-56 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[10.5px] leading-4 [overflow-wrap:anywhere]">
				{block.text}
			</pre>
		);
	}
	if (
		isRecord(block) &&
		block.type === "image" &&
		typeof block.data === "string" &&
		typeof block.mimeType === "string" &&
		block.mimeType.startsWith("image/")
	) {
		return (
			<div className="space-y-1.5 p-2.5">
				<img
					src={`data:${block.mimeType};base64,${block.data}`}
					alt="工具结果图像"
					className="max-h-80 max-w-full rounded-md object-contain"
				/>
				<div className="font-mono text-[11px] text-muted-foreground">
					{block.mimeType}
				</div>
			</div>
		);
	}
	return (
		<pre className="scrollbar-pro max-h-56 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[10.5px] leading-4 [overflow-wrap:anywhere]">
			{formatUnknown(block)}
		</pre>
	);
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

function toolLabel(toolName: string) {
	switch (toolName.toLowerCase()) {
		case "bash":
		case "execute":
			return "运行";
		case "read":
			return "读取";
		case "write":
			return "写入";
		case "edit":
			return "编辑";
		case "search":
		case "grep":
		case "find":
			return "搜索";
		default:
			return toolName;
	}
}

function fileBasename(path: string) {
	const normalized = path.replace(/[\\/]+$/, "");
	const parts = normalized.split(/[\\/]/);
	return parts[parts.length - 1] || path;
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
	return (
		<ActivityProcessStep
			icon={<Sparkles className={cn(PROCESS_ICON_CLASS, "mt-0.5")} />}
		>
			{activity.text ? (
				<ChatMarkdown
					text={activity.text}
					isStreaming={running}
					className={cn(
						"!text-[12.5px] !leading-[1.5] !text-muted-foreground",
						"[&_p]:!mb-1 [&_li:not(:first-child)]:!mt-0.5",
						"[&_:is(h1,h2,h3,h4,h5,h6)]:!my-1 [&_:is(h1,h2,h3,h4,h5,h6)]:!text-[12.5px] [&_:is(h1,h2,h3,h4,h5,h6)]:!font-medium",
						"[&_[data-streamdown='code-block']]:!my-2",
					)}
				/>
			) : (
				<span>思考中…</span>
			)}
		</ActivityProcessStep>
	);
}

function ToolDetail({ activity }: { activity: ToolCallActivity }) {
	const hasArgs = activity.args !== undefined && activity.args !== null;
	const hasResult = activity.result !== undefined && activity.result !== null;
	const preview = toolPreview(activity);
	const showArgs = hasArgs && preview === null;
	const result = hasResult ? resultContent(activity.result) : null;

	if (!showArgs && !hasResult) return null;

	return (
		<div className="w-full pb-1 pt-0.5 text-[11px] font-normal text-muted-foreground">
			<div className="overflow-hidden rounded-md border border-border/60 bg-muted/20">
				{showArgs ? (
					<pre className="scrollbar-pro max-h-44 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[10.5px] leading-4 [overflow-wrap:anywhere]">
						{formatUnknown(activity.args)}
					</pre>
				) : null}
				{result ? (
					<div className={cn(showArgs && "border-t border-border/50")}>
						{keyedToolResultBlocks(result.blocks).map(
							({ block, key }, index) => (
								<div
									key={key}
									className={cn(index > 0 && "border-t border-border/40")}
								>
									<ToolResultBlock block={block} />
								</div>
							),
						)}
						{result.metadata ? (
							<pre
								className={cn(
									"scrollbar-pro max-h-44 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[10.5px] leading-4 [overflow-wrap:anywhere]",
									result.blocks.length > 0 && "border-t border-border/40",
								)}
							>
								{formatUnknown(result.metadata)}
							</pre>
						) : null}
						{result.fallback ? (
							<pre className="scrollbar-pro max-h-56 overflow-auto whitespace-pre-wrap px-2.5 py-2 font-mono text-[10.5px] leading-4 [overflow-wrap:anywhere]">
								{result.fallback}
							</pre>
						) : null}
					</div>
				) : null}
			</div>
		</div>
	);
}

function ToolCallActivityView({
	activity,
	expansionKey,
	onOpenPath,
}: {
	activity: ToolCallActivity;
	expansionKey: string;
	onOpenPath?: (path: string) => void;
}) {
	const running = activity.status === "running";
	// 详情默认收起（含运行中），点击行切换；key 含 status，完成后 remount 自动收起
	const [open, setOpen] = useChatExpansionState(expansionKey, false);
	const preview = toolPreview(activity);
	const filePath = toolFilePath(activity);
	const previewLabel = filePath ? fileBasename(filePath) : preview;
	const hasDetails =
		(activity.args !== undefined &&
			activity.args !== null &&
			preview === null) ||
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
					<span>{toolLabel(activity.toolName)}</span>
					{previewLabel ? (
						<span
							className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground"
							title={preview ?? undefined}
						>
							{previewLabel}
						</span>
					) : null}
				</span>
				{activity.isError ? (
					<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
				) : running ? (
					<LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin" />
				) : null}
			</button>
			{hasDetails && open ? <ToolDetail activity={activity} /> : null}
		</div>
	);
}

function activityLabel(activity: AssistantActivity[], running: boolean) {
	if (running) {
		let current: AssistantActivity | undefined;
		for (let index = activity.length - 1; index >= 0; index -= 1) {
			if (activity[index].status === "running") {
				current = activity[index];
				break;
			}
		}
		if (current?.type === "tool") return `正在${toolLabel(current.toolName)}…`;
		if (current?.type === "thinking") return "思考中…";
		return "正在处理…";
	}

	const summary = summarizeAssistantActivity(activity);
	const parts: string[] = [];
	if (summary.hasThought) parts.push("思考过程");
	if (summary.readFileCount > 0) {
		parts.push(`读取了 ${summary.readFileCount} 个文件`);
	}
	if (summary.createFileCount > 0) {
		parts.push(`新增了 ${summary.createFileCount} 个文件`);
	}
	if (summary.editFileCount > 0) {
		parts.push(`修改了 ${summary.editFileCount} 个文件`);
	}
	if (summary.commandCount > 0) {
		parts.push(`调用了 ${summary.commandCount} 个命令`);
	}
	return parts.join(" · ") || "已完成";
}

export function AssistantActivityView({
	activity,
	streaming,
	preserveExpanded = false,
	expansionKey,
	durationMs,
	onOpenPath,
}: {
	activity: AssistantActivity[];
	streaming: boolean;
	preserveExpanded?: boolean;
	expansionKey: string;
	durationMs?: number;
	onOpenPath?: (path: string) => void;
}) {
	const { collapseCompletedActivity, showWorkDuration } = usePreferences();
	const running = activity.some((item) => item.status === "running");
	const durationLabel =
		!running && showWorkDuration && durationMs !== undefined
			? formatWorkDuration(durationMs)
			: "";
	const hasWorkSummary = Boolean(durationLabel);
	const [workOpen, setWorkOpen] = useChatExpansionState(
		`${expansionKey}:work`,
		streaming || preserveExpanded || !collapseCompletedActivity,
	);
	const [groupOpen, setGroupOpen] = useChatExpansionState(
		`${expansionKey}:group`,
		streaming || preserveExpanded,
	);
	if (activity.length === 0) return null;

	const group = (
		<div>
			<button
				type="button"
				className={cn(
					"group/activity flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1 text-left transition-colors hover:bg-muted/40 hover:text-foreground",
					PROCESS_TEXT_CLASS,
				)}
				onClick={() => setGroupOpen((value) => !value)}
				aria-expanded={groupOpen}
			>
				<ChevronRight
					className={cn(
						PROCESS_ICON_CLASS,
						"transition-transform duration-200",
						groupOpen && "rotate-90",
					)}
				/>
				<span className="min-w-0 flex-1 truncate">
					{activityLabel(activity, running)}
				</span>
				{running ? (
					<LoaderCircle className="size-3.5 shrink-0 animate-spin" />
				) : null}
			</button>
			{groupOpen ? (
				<div className="space-y-0 pt-0.5">
					{activity.map((item) =>
						item.type === "thinking" ? (
							<ThinkingActivityView key={item.id} activity={item} />
						) : (
							<ToolCallActivityView
								key={`${item.id}-${item.status}`}
								activity={item}
								expansionKey={`${expansionKey}:tool:${item.id}:${item.status}`}
								onOpenPath={onOpenPath}
							/>
						),
					)}
				</div>
			) : null}
		</div>
	);

	return (
		<div className="mb-1 mt-0.5 w-full text-muted-foreground">
			{hasWorkSummary ? (
				<>
					<button
						type="button"
						className="group flex w-full items-center gap-1.5 rounded-md py-0.5 pr-1 text-left text-[12.5px] font-medium leading-snug text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
						onClick={() => setWorkOpen((value) => !value)}
						aria-expanded={workOpen}
					>
						<ChevronRight
							className={cn(
								PROCESS_ICON_CLASS,
								"transition-transform duration-200",
								workOpen && "rotate-90",
							)}
						/>
						<span className="min-w-0 flex-1 truncate">
							工作了 {durationLabel}
						</span>
					</button>
					{workOpen ? group : null}
				</>
			) : (
				group
			)}
		</div>
	);
}

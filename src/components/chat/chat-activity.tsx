import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
	BookOpen,
	ChevronRight,
	CircleAlert,
	FileText,
	PencilLine,
	Search,
	Sparkles,
	Terminal,
	Wrench,
} from "lucide-react";

import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { toggleChatExpansionWithAnchor } from "@/components/chat/chat-expansion-anchor";
import { useChatExpansionState } from "@/components/chat/chat-expansion-state";
import {
	shouldAutoCollapseAssistantActivity,
	shouldInitiallyOpenAssistantActivity,
	summarizeAssistantActivity,
} from "@/lib/chat-activity-state";
import {
	diffLineStyle,
	fileBasename,
	flattenToolResult,
	formatUnknown,
	keyedDiffLines,
	resultContent,
	toolEditDiff,
	toolFilePath,
	toolPreview,
} from "@/lib/chat-tool-result";
import { formatWorkDuration } from "@/lib/format-duration";
import { usePreferences } from "@/lib/preferences-provider";
import { cn } from "@/lib/utils";
import { Hint, Spinner } from "@/ui";

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
	"text-sm font-medium leading-snug text-muted-foreground";
const PROCESS_ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground";

function ToolDiff({ diff }: { diff: string }) {
	return (
		<pre className="scrollbar-pro max-h-64 overflow-auto py-1 font-mono text-xs leading-[1.4]">
			{keyedDiffLines(diff).map(({ line, key }) => {
				const style = diffLineStyle(line);
				return (
					<span
						key={key}
						className={cn(
							"grid min-h-[1.4em] grid-cols-[12px_minmax(0,1fr)] whitespace-pre-wrap [overflow-wrap:anywhere]",
							style.className,
						)}
					>
						<span
							aria-hidden="true"
							className={cn("select-none text-center", style.markerClassName)}
						>
							{style.marker}
						</span>
						<span className="min-w-0">{style.content || " "}</span>
					</span>
				);
			})}
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

function toolLabel(t: TFunction, toolName: string) {
	switch (toolName.toLowerCase()) {
		case "bash":
		case "execute":
			return t("chat.run");
		case "read":
			return t("chat.read");
		case "write":
			return t("chat.write");
		case "edit":
			return t("chat.edit");
		case "search":
		case "grep":
		case "find":
			return t("chat.search");
		default:
			return toolName;
	}
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
				"flex min-h-6 w-full items-start gap-1.5 py-0.5",
				PROCESS_TEXT_CLASS,
			)}
		>
			<span className="inline-flex shrink-0 pt-0.5">{icon}</span>
			<div className="min-w-0 flex-1">{children}</div>
		</div>
	);
}

function ThinkingActivityView({ activity }: { activity: ThinkingActivity }) {
	const { t } = useTranslation();
	const running = activity.status === "running";
	return (
		<ActivityProcessStep
			icon={
				<Sparkles
					className={cn(
						PROCESS_ICON_CLASS,
						"mt-0.5",
						running && "animate-pulse",
					)}
				/>
			}
		>
			{activity.text ? (
				<ChatMarkdown
					text={activity.text}
					isStreaming={running}
					className={cn(
						"!text-xs !leading-[1.5] !text-muted-foreground",
						"[&_p]:!mb-1 [&_li:not(:first-child)]:!mt-0.5",
						"[&_:is(h1,h2,h3,h4,h5,h6)]:!my-1 [&_:is(h1,h2,h3,h4,h5,h6)]:!text-xs [&_:is(h1,h2,h3,h4,h5,h6)]:!font-medium",
						"[&_[data-streamdown='code-block']]:!my-2",
					)}
				/>
			) : (
				<span>{t("chat.thinking")}</span>
			)}
		</ActivityProcessStep>
	);
}

function ToolDetail({ activity }: { activity: ToolCallActivity }) {
	const { t } = useTranslation();
	const hasArgs = activity.args !== undefined && activity.args !== null;
	const hasResult = activity.result !== undefined && activity.result !== null;
	const diff =
		activity.toolName.toLowerCase() === "edit" && !activity.isError
			? toolEditDiff(activity.result)
			: null;
	const preview = toolPreview(activity);
	const showArgs = hasArgs && preview === null;
	const result = hasResult ? resultContent(activity.result) : null;
	const flattenedResult = result ? flattenToolResult(result) : null;
	const detailText = [
		showArgs ? formatUnknown(activity.args) : null,
		flattenedResult?.text || null,
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");
	const images = flattenedResult?.images ?? [];

	if (!diff && !detailText && images.length === 0) return null;

	return (
		<div className="w-full pb-1 pt-0.5 text-xs font-normal text-muted-foreground">
			{diff ? (
				<ToolDiff diff={diff} />
			) : detailText ? (
				<pre className="scrollbar-pro max-h-56 overflow-auto whitespace-pre-wrap py-0.5 pr-1 font-mono text-xs leading-[1.4] [overflow-wrap:anywhere]">
					{detailText}
				</pre>
			) : null}
			{diff
				? null
				: images.map((image) => (
						<img
							key={image.key}
							src={`data:${image.mimeType};base64,${image.data}`}
							alt={t("chat.toolResultImage")}
							className="max-h-80 max-w-full rounded-md object-contain outline-1 outline-black/10 dark:outline-white/10"
						/>
					))}
		</div>
	);
}

function ToolCallActivityView({
	activity,
	expansionKey,
}: {
	activity: ToolCallActivity;
	expansionKey: string;
}) {
	const running = activity.status === "running";
	const { t } = useTranslation();
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
		<div className="w-full" data-chat-expansion-root>
			<button
				type="button"
				className={cn(
					"group/tool -mx-1 flex min-h-6 w-[calc(100%+0.5rem)] items-start gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors",
					PROCESS_TEXT_CLASS,
					hasDetails
						? "hover:bg-muted/40 hover:text-foreground"
						: "cursor-default",
					open && "bg-muted/35 text-foreground",
					activity.isError && "text-destructive",
				)}
				onClick={(event) =>
					hasDetails &&
					toggleChatExpansionWithAnchor(event.currentTarget, () =>
						setOpen((value) => !value),
					)
				}
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
					<span>{toolLabel(t, activity.toolName)}</span>
					{previewLabel ? (
						<Hint label={preview ?? undefined}>
							<span className="ml-1.5 font-mono text-2xs font-normal text-muted-foreground">
								{previewLabel}
							</span>
						</Hint>
					) : null}
				</span>
				{activity.isError ? (
					<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
				) : running ? (
					<Spinner className="mt-0.5 size-3.5 shrink-0" />
				) : null}
			</button>
			{hasDetails && open ? <ToolDetail activity={activity} /> : null}
		</div>
	);
}

function runningActivityLabel(t: TFunction, activity: AssistantActivity[]) {
	let current: AssistantActivity | undefined;
	for (let index = activity.length - 1; index >= 0; index -= 1) {
		if (activity[index].status === "running") {
			current = activity[index];
			break;
		}
	}
	if (current?.type === "tool")
		return t("chat.workingTool", { tool: toolLabel(t, current.toolName) });
	if (current?.type === "thinking") return t("chat.thinking");
	return t("chat.processing");
}

function activitySummaryLabel(
	t: TFunction,
	summary: ReturnType<typeof summarizeAssistantActivity>,
) {
	const parts: string[] = [];
	if (summary.hasThought) parts.push(t("chat.thoughtProcess"));
	if (summary.readFileCount > 0)
		parts.push(t("chat.readFiles", { count: summary.readFileCount }));
	if (summary.createFileCount > 0)
		parts.push(t("chat.createdFiles", { count: summary.createFileCount }));
	if (summary.editFileCount > 0)
		parts.push(t("chat.editedFiles", { count: summary.editFileCount }));
	if (summary.commandCount > 0)
		parts.push(t("chat.executedCommands", { count: summary.commandCount }));
	return parts.join(" · ") || t("chat.completed");
}

export function AssistantActivityView({
	activity,
	expansionKey,
	followedByText = false,
	durationMs,
}: {
	activity: AssistantActivity[];
	expansionKey: string;
	followedByText?: boolean;
	durationMs?: number;
}) {
	const { t } = useTranslation();
	const { collapseCompletedActivity, showWorkDuration } = usePreferences();
	const running = activity.some((item) => item.status === "running");
	const initiallyOpen = shouldInitiallyOpenAssistantActivity({
		followedByText,
		collapseCompletedActivity,
	});
	const durationLabel =
		!running && showWorkDuration && durationMs !== undefined
			? formatWorkDuration(durationMs, {
					hour: t("common.hour"),
					minute: t("common.minute"),
					second: t("common.second"),
				})
			: "";
	const summary = running ? null : summarizeAssistantActivity(activity);
	const summaryLabel = summary ? activitySummaryLabel(t, summary) : "";
	const [groupOpen, setGroupOpen] = useChatExpansionState(
		`${expansionKey}:group`,
		initiallyOpen,
	);
	const autoCollapseEligible = followedByText && collapseCompletedActivity;
	const previousAutoCollapseEligibleRef = useRef(autoCollapseEligible);
	useLayoutEffect(() => {
		const previousEligible = previousAutoCollapseEligibleRef.current;
		previousAutoCollapseEligibleRef.current = autoCollapseEligible;
		if (
			!shouldAutoCollapseAssistantActivity(
				previousEligible,
				autoCollapseEligible,
			)
		) {
			return;
		}
		setGroupOpen(false);
	}, [autoCollapseEligible, setGroupOpen]);
	if (activity.length === 0) return null;

	return (
		<div
			className="mb-1 mt-0.5 w-full text-muted-foreground"
			data-chat-expansion-root
		>
			<button
				type="button"
				className={cn(
					"group/activity -mx-1 flex min-h-7 w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/40 hover:text-foreground",
					PROCESS_TEXT_CLASS,
				)}
				onClick={(event) =>
					toggleChatExpansionWithAnchor(event.currentTarget, () =>
						setGroupOpen((value) => !value),
					)
				}
				aria-expanded={groupOpen}
			>
				<ChevronRight
					className={cn(
						PROCESS_ICON_CLASS,
						"transition-transform duration-150 ease-out",
						groupOpen && "rotate-90",
					)}
				/>
				<span className="min-w-0 flex-1 truncate">
					{running ? (
						runningActivityLabel(t, activity)
					) : durationLabel ? (
						<>
							<span className="text-foreground/75">
								{t("chat.workDuration", { duration: durationLabel })}
							</span>
							<span className="mx-1 text-muted-foreground/60">·</span>
							<span>{summaryLabel}</span>
						</>
					) : (
						summaryLabel
					)}
				</span>
				{running ? <Spinner className="size-3.5 shrink-0" /> : null}
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
							/>
						),
					)}
				</div>
			) : null}
		</div>
	);
}

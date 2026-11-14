import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
	BookOpen,
	ChevronRight,
	CircleAlert,
	CodeXml,
	FileText,
	ListTodo,
	PencilLine,
	Plug,
	Puzzle,
	Search,
	Sparkles,
	Terminal,
	Wrench,
} from "lucide-react";

import { openChatImageLightbox } from "@/components/chat/chat-image-viewer";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { ChatTodoList } from "@/components/chat/chat-todo-capsule";
import { toggleChatExpansionWithAnchor } from "@/components/chat/chat-expansion-anchor";
import {
	chatToolExpansionKey,
	useChatExpansionState,
	useFindExpandedToolIndex,
} from "@/components/chat/chat-expansion-state";
import { useChatFileOpen } from "@/components/chat/chat-file-open-context";
import {
	shouldAutoCollapseAssistantActivity,
	shouldInitiallyOpenAssistantActivity,
	summarizeAssistantActivity,
} from "@/lib/chat/chat-activity-state";
import {
	diffLineStyle,
	fileBasename,
	flattenToolResult,
	formatUnknown,
	isRecord,
	keyedDiffLines,
	resultContent,
	singleToolResultImage,
	toolEditDiff,
	toolFilePath,
	toolPreview,
	toolResultImageUrl,
} from "@/lib/chat/chat-tool-result";
import {
	countChatTodos,
	isChatTodoTool,
	parseChatTodos,
	type ChatTodoItem,
} from "@/lib/chat/chat-todos";
import { formatWorkDuration } from "@/lib/format-duration";
import { usePreferences } from "@/lib/preferences-provider";
import { cn } from "@/lib/utils";
import { Button, Hint, Spinner } from "@/ui";

export type ChatActivityStatus = "complete" | "running";

export type ThinkingActivity = {
	id: string;
	type: "thinking";
	text: string;
	status: ChatActivityStatus;
	/** 流式开始/结束时刻；历史回放的消息可能没有，因此是可选的。 */
	startedAtMs?: number;
	endedAtMs?: number;
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

const PROCESS_TEXT_CLASS = "font-medium leading-snug text-muted-foreground";
const PROCESS_ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground";
const THINKING_REVEAL_CHARS = 8_000;

function ToolDiff({ diff }: { diff: string }) {
	return (
		<pre className="scrollbar-pro max-h-64 overflow-auto py-1 font-mono text-[length:var(--pilo-code-font-size)] leading-[1.4]">
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
	isSkill,
	className,
}: {
	toolName: string;
	isSkill?: boolean;
	className?: string;
}) {
	if (isSkill) return <Puzzle className={className} />;
	if (toolName.startsWith("mcp__")) return <Plug className={className} />;
	if (isChatTodoTool(toolName)) return <ListTodo className={className} />;

	switch (toolName.toLowerCase()) {
		case "codemode":
			return <CodeXml className={className} />;
		case "list_mcp_resources":
		case "read_mcp_resource":
			return <Plug className={className} />;
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
		case "tool_search":
			return <Search className={className} />;
		default:
			return <Wrench className={className} />;
	}
}

function toolLabel(t: TFunction, toolName: string) {
	const mcpTool = toolName.match(/^mcp__(.+?)__(.+)$/);
	if (mcpTool) return `${mcpTool[1]}/${mcpTool[2]}`;
	if (isChatTodoTool(toolName)) return t("chat.todos");

	switch (toolName.toLowerCase()) {
		case "tool_search":
			return t("chat.findTools");
		case "list_mcp_resources":
			return t("chat.listMcpResources");
		case "read_mcp_resource":
			return t("chat.readMcpResource");
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

function ThinkingActivityView({
	activity,
	expansionKey,
}: {
	activity: ThinkingActivity;
	expansionKey: string;
}) {
	const { t } = useTranslation();
	const { showWorkDuration } = usePreferences();
	const running = activity.status === "running";
	// 思考默认收成单行（与工具调用一致），展开状态按条目记忆，
	// 因此状态从 running 变为 complete 不会把用户展开的内容重新收起。
	const [open, setOpen] = useChatExpansionState(expansionKey, false);
	const [revealedChars, setRevealedChars] = useState(THINKING_REVEAL_CHARS);
	// Bound the initial Markdown/DOM work even for runaway model output.
	let visibleEnd = Math.min(activity.text.length, revealedChars);
	if (
		visibleEnd < activity.text.length &&
		/[\uD800-\uDBFF]/.test(activity.text[visibleEnd - 1])
	) {
		visibleEnd += 1;
	}
	const hasHiddenText = visibleEnd < activity.text.length;
	const visibleText = activity.text.slice(0, visibleEnd);
	const durationMs =
		activity.startedAtMs !== undefined && activity.endedAtMs !== undefined
			? Math.max(0, activity.endedAtMs - activity.startedAtMs)
			: undefined;
	// 只有耗时达到或超过 1 秒才展示持续时长；不足 1 秒或无跨度时间戳显示“思考”，避免出现“思考了0秒”
	const durationLabel =
		!running &&
		showWorkDuration &&
		durationMs !== undefined &&
		durationMs >= 1000
			? formatWorkDuration(durationMs, {
					hour: t("common.hour"),
					minute: t("common.minute"),
					second: t("common.second"),
				})
			: "";
	const label = running
		? t("chat.thinking")
		: durationLabel
			? t("chat.thoughtDuration", { duration: durationLabel })
			: t("chat.thought");

	// Scan from the end so streaming updates do not split the entire thinking body.
	const previewText = useMemo(() => {
		let end = activity.text.length;
		while (end > 0) {
			const start = activity.text.lastIndexOf("\n", end - 1) + 1;
			const line = activity.text.slice(start, end).trim();
			if (line) return line.slice(0, THINKING_REVEAL_CHARS);
			end = start - 1;
		}
		return "";
	}, [activity.text]);
	const hasDetails = previewText.length > 0;

	const details = (
		<ChatMarkdown
			text={visibleText}
			isStreaming={running && !hasHiddenText}
			className={cn(
				"!leading-[1.5] !text-muted-foreground",
				"[&_p]:!mb-1 [&_li:not(:first-child)]:!mt-0.5",
				"[&_:is(h1,h2,h3,h4,h5,h6)]:!my-1 [&_:is(h1,h2,h3,h4,h5,h6)]:!text-[1em] [&_:is(h1,h2,h3,h4,h5,h6)]:!font-medium",
				"[&_[data-streamdown='code-block']]:!my-2",
			)}
		/>
	);
	const trigger = (
		<button
			type="button"
			className={cn(
				"group/thinking -mx-1 flex min-h-6 w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
				PROCESS_TEXT_CLASS,
				hasDetails ? "hover:bg-hover hover:text-foreground" : "cursor-default",
				open && "bg-hover text-foreground",
			)}
			onClick={(event) => {
				if (!hasDetails) return;
				toggleChatExpansionWithAnchor(event.currentTarget, () =>
					setOpen((value) => !value),
				);
			}}
			aria-expanded={hasDetails ? open : undefined}
		>
			<Sparkles
				className={cn(
					PROCESS_ICON_CLASS,
					running && "motion-safe:animate-pulse",
				)}
			/>
			<span className="shrink-0 truncate">{label}</span>
			{previewText && !open ? (
				<span className="min-w-0 flex-1 truncate font-normal text-muted-foreground/75">
					{previewText}
				</span>
			) : (
				<span className="min-w-0 flex-1" aria-hidden="true" />
			)}
		</button>
	);

	return (
		<div className="w-full" data-chat-expansion-root>
			<Hint
				label={
					hasDetails && !open
						? `${activity.text.slice(0, THINKING_REVEAL_CHARS)}${activity.text.length > THINKING_REVEAL_CHARS ? "\n…" : ""}`
						: undefined
				}
				className="scrollbar-pro max-h-[min(24rem,var(--radix-tooltip-content-available-height))] max-w-[min(20rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain whitespace-pre-wrap"
			>
				{trigger}
			</Hint>
			{hasDetails && open ? (
				<div className="pt-0.5">
					{details}
					{hasHiddenText ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={(event) => {
								const root = event.currentTarget.closest<HTMLElement>(
									"[data-chat-expansion-root]",
								);
								toggleChatExpansionWithAnchor(root ?? event.currentTarget, () =>
									setRevealedChars((value) => value + THINKING_REVEAL_CHARS),
								);
							}}
						>
							{t("chat.showMoreThinking")}
						</Button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function ToolDetail({
	activity,
	writeContent,
	todos,
}: {
	activity: ToolCallActivity;
	writeContent: string | null;
	todos: ChatTodoItem[] | null;
}) {
	const { t, i18n } = useTranslation();
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
	const resultText = flattenedResult?.needsRawFallback
		? formatUnknown(activity.result)
		: flattenedResult?.text;
	const detailText = [
		showArgs ? formatUnknown(activity.args) : null,
		resultText || null,
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");
	const images = flattenedResult?.images ?? [];
	const exitCode = flattenedResult?.exitCode;
	const wallTimeSeconds = flattenedResult?.wallTimeSeconds;
	const hasExecutionSummary =
		exitCode != null || wallTimeSeconds != null || flattenedResult?.truncated;

	// 待办清单自带结构化展示，不再回落到参数/结果的 JSON 文本。
	if (todos) {
		return (
			<div className="w-full pb-1 pt-0.5 font-normal text-muted-foreground">
				<ChatTodoList items={todos} className="py-1" />
			</div>
		);
	}

	if (
		writeContent === null &&
		!diff &&
		!detailText &&
		images.length === 0 &&
		!hasExecutionSummary
	)
		return null;

	return (
		<div className="w-full pb-1 pt-0.5 font-normal text-muted-foreground">
			{hasExecutionSummary ? (
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1 text-[0.8em] tabular-nums">
					{exitCode != null ? (
						<span className={cn(exitCode !== 0 && "text-destructive")}>
							{t("chat.toolExitCode", { code: exitCode })}
						</span>
					) : null}
					{wallTimeSeconds != null ? (
						<span>
							{t("chat.toolDuration", {
								duration: wallTimeSeconds.toLocaleString(i18n.language, {
									maximumFractionDigits: 2,
								}),
							})}
						</span>
					) : null}
					{flattenedResult?.truncated ? (
						<span>{t("chat.toolOutputTruncated")}</span>
					) : null}
				</div>
			) : null}
			{writeContent !== null ? (
				<pre className="scrollbar-pro max-h-56 overflow-auto whitespace-pre-wrap py-0.5 pr-1 font-mono text-[length:var(--pilo-code-font-size)] leading-[1.4] [overflow-wrap:anywhere]">
					<code>{writeContent}</code>
				</pre>
			) : null}
			{diff ? (
				<ToolDiff diff={diff} />
			) : detailText ? (
				<pre className="scrollbar-pro max-h-56 overflow-auto whitespace-pre-wrap py-0.5 pr-1 font-mono text-[length:var(--pilo-code-font-size)] leading-[1.4] [overflow-wrap:anywhere]">
					{detailText}
				</pre>
			) : null}
			{diff
				? null
				: images.map((image) => {
						const url = toolResultImageUrl(image);
						const name = t("chat.toolResultImage");
						return (
							<button
								key={image.key}
								type="button"
								aria-label={t("chat.viewImage", { name })}
								onClick={() => openChatImageLightbox({ url, name })}
								className="block max-w-full cursor-zoom-in rounded-md focus-visible:outline-2 focus-visible:outline-ring any-pointer-coarse:min-h-11 any-pointer-coarse:min-w-11"
							>
								<img
									src={url}
									alt={name}
									className="max-h-80 max-w-full rounded-md object-contain outline-1 outline-black/10 dark:outline-white/10"
								/>
							</button>
						);
					})}
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
	// 详情默认收起，手动展开后按工具调用 ID 保留状态。
	const [open, setOpen] = useChatExpansionState(expansionKey, false);
	const fileOpener = useChatFileOpen();
	const preview = toolPreview(activity);
	const filePath = toolFilePath(activity);
	const toolName = activity.toolName.toLowerCase();
	const readImage =
		toolName === "read" && !running && !activity.isError && filePath
			? singleToolResultImage(activity.result)
			: null;
	const openablePath =
		(toolName === "read" || toolName === "write" || toolName === "edit") &&
		filePath &&
		(readImage || fileOpener?.canOpenFile(filePath))
			? filePath
			: null;
	const skillName =
		toolName === "read"
			? filePath?.replace(/\\/g, "/").match(/(?:^|\/)([^/]+)\/SKILL\.md$/)?.[1]
			: null;
	// 失败调用的参数里也可能带清单，但它没生效：交给通用详情显示错误结果。
	const todos =
		!activity.isError && isChatTodoTool(activity.toolName)
			? parseChatTodos(activity.args, activity.result)
			: null;
	const previewLabel = todos
		? t("chat.todoProgress", {
				done: countChatTodos(todos).completed,
				total: todos.length,
			})
		: (skillName ?? (filePath ? fileBasename(filePath) : preview));
	const label = skillName ? t("chat.skill") : toolLabel(t, activity.toolName);
	const writeContent =
		toolName === "write" &&
		isRecord(activity.args) &&
		typeof activity.args.content === "string"
			? activity.args.content
			: null;
	const hasDetails =
		todos !== null ||
		writeContent !== null ||
		(activity.args !== undefined &&
			activity.args !== null &&
			preview === null) ||
		(activity.result !== undefined && activity.result !== null);

	const toggleDetails = (trigger: HTMLElement) => {
		if (!hasDetails) return;
		toggleChatExpansionWithAnchor(trigger, () => setOpen((value) => !value));
	};
	const rowClassName = cn(
		"group/tool -mx-1 flex min-h-6 w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors motion-reduce:transition-none",
		PROCESS_TEXT_CLASS,
		hasDetails ? "hover:bg-hover hover:text-foreground" : "cursor-default",
		open && "bg-hover text-foreground",
		activity.isError && "text-destructive",
	);
	const rowContent = (
		<>
			<ToolIcon
				toolName={activity.toolName}
				isSkill={Boolean(skillName)}
				className={cn(
					PROCESS_ICON_CLASS,
					activity.isError && "text-destructive",
				)}
			/>
			<span className="flex min-w-0 flex-1 items-center gap-1.5">
				<span className="max-w-full shrink-0 truncate">{label}</span>
				{previewLabel && openablePath ? (
					<Hint label={openablePath}>
						<button
							type="button"
							className="relative z-10 inline-flex min-w-0 shrink cursor-pointer items-center rounded-sm bg-muted/50 px-1 font-mono text-[length:var(--pilo-code-font-size)] font-normal text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
							aria-label={t("chat.openFile", { path: openablePath })}
							onClick={() => {
								if (readImage) {
									openChatImageLightbox({
										url: toolResultImageUrl(readImage),
										name: fileBasename(openablePath),
									});
									return;
								}
								fileOpener?.openFile(openablePath);
							}}
						>
							<span className="min-w-0 truncate">{previewLabel}</span>
						</button>
					</Hint>
				) : previewLabel ? (
					<Hint label={preview ?? undefined}>
						<span className="min-w-0 truncate font-mono text-[length:var(--pilo-code-font-size)] font-normal text-muted-foreground">
							{previewLabel}
						</span>
					</Hint>
				) : null}
			</span>
			{activity.isError ? (
				<CircleAlert className="size-3.5 shrink-0" />
			) : running ? (
				<Spinner className="size-3.5 shrink-0" />
			) : null}
		</>
	);

	return (
		<div className="w-full" data-chat-expansion-root>
			{openablePath ? (
				<div className={cn(rowClassName, "relative")}>
					{/* Only file-opening rows need separate disclosure and file buttons. */}
					<button
						type="button"
						className="absolute inset-0 rounded-md focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
						disabled={!hasDetails}
						onClick={(event) => toggleDetails(event.currentTarget)}
						aria-label={`${label} ${previewLabel}`}
						aria-expanded={hasDetails ? open : undefined}
					/>
					{rowContent}
				</div>
			) : (
				<button
					type="button"
					className={cn(
						rowClassName,
						"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
					)}
					onClick={(event) => toggleDetails(event.currentTarget)}
					aria-expanded={hasDetails ? open : undefined}
				>
					{rowContent}
				</button>
			)}
			{hasDetails && open ? (
				<ToolDetail
					activity={activity}
					writeContent={writeContent}
					todos={todos}
				/>
			) : null}
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
	messageId,
	expansionKey,
	followedByText = false,
	durationMs,
}: {
	activity: AssistantActivity[];
	messageId: string;
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
	const findExpandedToolIndex = useFindExpandedToolIndex(messageId);
	const [groupOpen, setGroupOpen] = useChatExpansionState(
		`${expansionKey}:group`,
		() => initiallyOpen || findExpandedToolIndex(activity) >= 0,
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
			) ||
			findExpandedToolIndex(activity) >= 0
		) {
			return;
		}
		setGroupOpen(false);
	}, [activity, autoCollapseEligible, findExpandedToolIndex, setGroupOpen]);
	if (activity.length === 0) return null;

	return (
		<div
			className="mb-1 mt-0.5 w-full text-muted-foreground"
			data-chat-expansion-root
		>
			<button
				type="button"
				className={cn(
					"group/activity -mx-1 flex min-h-7 w-[calc(100%+0.5rem)] items-center gap-1.5 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-hover hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
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
						"transition-transform duration-150 ease-out motion-reduce:transition-none",
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
				<div className="space-y-0.5 pt-0.5">
					{activity.map((item) =>
						item.type === "thinking" ? (
							<ThinkingActivityView
								key={item.id}
								activity={item}
								expansionKey={`${expansionKey}:thinking:${item.id}`}
							/>
						) : (
							<ToolCallActivityView
								key={item.id}
								activity={item}
								expansionKey={chatToolExpansionKey(messageId, item.id)}
							/>
						),
					)}
				</div>
			) : null}
		</div>
	);
}

import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ArrowDown,
	ChevronDown,
	Copy,
	PanelLeft,
	PanelRight,
} from "lucide-react";
import { toast } from "sonner";

import {
	AssistantActivityView,
	type AssistantActivity,
} from "@/components/chat/chat-activity";
import { ChatAgentActivityIndicator } from "@/components/chat/chat-agent-activity";
import {
	getAssistantActivities,
	getAssistantStreamingLabel,
	type AssistantContentItem,
} from "@/lib/chat-activity-state";
import {
	createConversationState,
	reduceConversation,
	replayConversationEventsBatched,
} from "@/lib/conversation-reducer";
import { toConversationAction } from "@/lib/conversation-runtime-adapter";
import type {
	ChatMessage,
	ConversationAction,
	ConversationState,
} from "@/lib/conversation-types";
import { getReplyRunwayHeight } from "@/lib/chat-scroll-state";
import {
	getOutlineIndexForMessageIndex,
	shouldVirtualizeChatMessages,
} from "@/lib/chat-virtualization";
import { notifyReplyCompleted } from "@/lib/desktop-notifications";
import { formatWorkDuration } from "@/lib/format-duration";
import { usePreferences } from "@/lib/preferences-provider";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { ConversationOutlineRail } from "@/components/chat/conversation-outline-rail";
import { buildConversationOutline } from "@/lib/conversation-outline";
import {
	logChatPerformanceInstructions,
	recordChatMessageRender,
	recordChatPageRender,
	recordScrollEvent,
	recordVirtualChange,
} from "@/lib/chat-performance";
import { createChatSessionClient } from "@/lib/chat-session-client";
import {
	cacheProjectPiModels,
	getCachedProjectPiModels,
} from "@/lib/pi-models";
import {
	PI_THINKING_LEVELS,
	runtimeErrorMessage,
	type PiAgentState,
	type PiModel,
	type PiThinkingLevel,
	type PiloRuntimeEvent,
} from "@/lib/pi-runtime";
import { loadSessionHistory } from "@/lib/sessions";
import type { Project } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { IS_MACOS, TRAFFIC_LIGHT_GUTTER } from "@/components/title-bar";
import {
	Button,
	EmptyState,
	ErrorState,
	LoadingState,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

export type ChatSession = {
	id: string;
	title: string;
	projectRecord: Project;
	sessionPath?: string;
	historyFileSize?: number;
	historyFileMtimeNs?: number;
	initialModel?: PiModel;
	initialThinkingLevel?: PiThinkingLevel;
};

type ChatSessionRuntimeState = {
	name?: string;
	messageCount?: number;
	tokens?: number;
	cost?: number;
	contextTokens?: number | null;
	contextWindow?: number;
	contextPercent?: number | null;
};

async function readCurrentPiSessionState(
	client: ReturnType<typeof createChatSessionClient>,
	agentState?: PiAgentState,
): Promise<ChatSessionRuntimeState> {
	const [state, stats] = await Promise.all([
		agentState ?? client.getPiAgentState(),
		client.getPiSessionStats(),
	]);
	return {
		name: state.sessionName,
		messageCount: state.messageCount,
		tokens: stats.tokens?.total,
		cost: stats.cost,
		contextTokens: stats.contextUsage?.tokens,
		contextWindow: stats.contextUsage?.contextWindow,
		contextPercent: stats.contextUsage?.percent,
	};
}

const compactNumberFormatter = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

function formatSessionUsage(state: ChatSessionRuntimeState | null): string {
	if (!state) return "";
	const parts: string[] = [];
	if (state.contextPercent !== null && state.contextPercent !== undefined) {
		parts.push(`${Math.round(state.contextPercent)}% 上下文`);
	} else if (
		state.contextTokens !== null &&
		state.contextTokens !== undefined &&
		state.contextWindow
	) {
		parts.push(
			`${compactNumberFormatter.format(state.contextTokens)}/${compactNumberFormatter.format(state.contextWindow)} 上下文`,
		);
	}
	if (state.tokens !== undefined) {
		parts.push(`${compactNumberFormatter.format(state.tokens)} tokens`);
	}
	if (state.cost !== undefined) {
		parts.push(
			`$${state.cost < 0.01 ? state.cost.toFixed(4) : state.cost.toFixed(2)}`,
		);
	}
	return parts.join(" · ");
}

const EMPTY_MESSAGES: ChatMessage[] = [];

const MOCK_CONVERSATIONS: Record<string, ChatMessage[]> = {
	s1: [
		{
			id: "s1-u1",
			role: "user",
			text: "先把 UI 做好，整体风格参考 Lody。侧边栏、聊天区域和输入框都尽量保持一致的体验。",
			time: "11:18",
		},
		{
			id: "s1-a1",
			role: "assistant",
			text: "已经把基础视觉体系迁到 Pilo。聊天页继续沿用 Lody 的单列阅读布局：\n\n- 用户消息靠右使用轻量气泡\n- Pi 回复保持无外框正文\n- 工具活动收在正文之间\n- 输入区固定在底部并和消息列使用同一宽度\n\n这样后续接真实 RPC streaming 时只需要替换数据源。",
			time: "11:19",
			activity: [
				{
					id: "s1-a1-thinking",
					type: "thinking",
					text: "对比了消息列、活动信息和输入区的层级关系，保留低对比度与单列阅读结构。",
					status: "complete",
				},
				...[
					"src/App.tsx",
					"src/index.css",
					"src/ui/button.tsx",
					"src/ui/textarea.tsx",
				].map((path, index) => ({
					id: `s1-a1-tool-${index}`,
					type: "tool" as const,
					toolName: "read",
					args: { path },
					status: "complete" as const,
				})),
			],
		},
		{
			id: "s1-u2",
			role: "user",
			text: "输入框也直接参考 Lody，不要做成传统聊天软件那种很重的卡片。",
			time: "11:23",
		},
		{
			id: "s1-a2",
			role: "assistant",
			text: '可以。`session composer` 会保持低对比边框和紧凑 footer，模型、模式、附件和发送都收在同一行。\n\n```tsx\n<ChatComposer\n  value={draft}\n  onSubmit={sendMessage}\n  modelLabel="pi / default"\n/>\n```\n\n正文输入自动增高，最多 12 行。',
			time: "11:24",
		},
		{
			id: "s1-a2b",
			role: "assistant",
			text: [
				"先把现有问题列清楚：",
				"",
				"1. **消息列宽度**：滚动条出现时被压缩 8px，输入框 overlay 不受影响，两者左边缘错位。",
				"2. **底部遮挡**：composer 容器自带 `bg-background`，消息从后面被硬切，观感生硬。",
				"3. **Outline rail**：滚动位置高亮基于 `offsetTop`，长会话下没有节流，滚动掉帧。",
				"",
				"其中 1 和 2 是纯样式问题，一行 class 就能修；3 需要把 reading line 的计算移到 `requestAnimationFrame` 里合并。",
			].join("\n"),
			time: "11:26",
		},
		{
			id: "s1-u3",
			role: "user",
			text: "那先把 1 和 2 修了，宽度用 scrollbar-gutter 对齐，遮挡直接去掉白底让输入框自然盖住就行。",
			time: "11:28",
		},
		{
			id: "s1-a3",
			role: "assistant",
			text: [
				"改动落在 `chat-page.tsx`：",
				"",
				"```tsx",
				"// 滚动容器：恒定预留滚动条空间，消息列宽度不再跳动",
				'<div className="scrollbar-pro h-full overflow-y-auto [scrollbar-gutter:stable]" />',
				"",
				"// composer overlay：补齐同样的 8px，去掉 bg-background",
				'<div className="absolute inset-x-0 bottom-0 pr-2">',
				'	<ConversationColumn className="relative pb-3">',
				"</div>",
				"```",
				"",
				"这样消息直接延伸到底部，由 composer 自身的背景自然截断，滚动条出现与否列宽都一致。",
			].join("\n"),
			time: "11:29",
		},
		{
			id: "s1-u4",
			role: "user",
			text: "好，帮我跑一遍前端验证。",
			time: "11:31",
		},
		{
			id: "s1-a4",
			role: "assistant",
			text: "`pnpm format`、`pnpm check`、`pnpm build` 全部通过。构建只有一个已有的 chunk 体积警告，和这次改动无关。视觉效果需要你这边 `pnpm tauri dev` 确认。",
			time: "11:32",
			activity: ["pnpm format", "pnpm check", "pnpm build"].map(
				(command, index) => ({
					id: `s1-a4-tool-${index}`,
					type: "tool" as const,
					toolName: "bash",
					args: { command },
					status: "complete" as const,
				}),
			),
		},
		{
			id: "s1-u5",
			role: "user",
			text: "我看效果还行。接下来把 outline rail 的掉帧问题也处理一下？",
			time: "11:40",
		},
		{
			id: "s1-a5",
			role: "assistant",
			text: [
				"可以。现在的实现是 `onScroll` 每次触发都遍历 outline entries 并 setState，长会话下每秒能触发几十次。",
				"",
				"计划这样改：",
				"",
				"- `syncScrollState` 里只更新 ref，不直接 setState",
				"- 用一个 `requestAnimationFrame` 合并同帧内的多次滚动",
				"- 高亮 index 只有变化时才 setState",
				"",
				"预计净删代码（去掉重复的中间状态），不是加节流库。",
			].join("\n"),
			time: "11:41",
		},
		{
			id: "s1-u6",
			role: "user",
			text: "改完顺便看看消息气泡在窄窗口（小于 sm）下的表现，现在 80% 上限感觉还是有点宽。",
			time: "11:45",
		},
		{
			id: "s1-a6",
			role: "assistant",
			text: [
				"窄窗口下限制到 `max-w-[85%]` 更合适，长句换行不至于每行只有几个字：",
				"",
				"```diff",
				'- <div className="max-w-[80%] sm:max-w-[70%]">',
				'+ <div className="max-w-[85%] sm:max-w-[70%]">',
				"```",
				"",
				"时间戳和操作按钮仍在气泡上方右对齐，不受影响。",
			].join("\n"),
			time: "11:46",
		},
		{
			id: "s1-u7",
			role: "user",
			text: "行，这两个一起改了吧，我再看看整体效果。",
			time: "11:48",
		},
		{
			id: "s1-a7",
			role: "assistant",
			text: [
				"都改好了：",
				"",
				"| 改动 | 文件 | 说明 |",
				"| --- | --- | --- |",
				"| scroll 节流 | `chat-page.tsx` | rAF 合并滚动事件 |",
				"| 气泡上限 | `chat-page.tsx` | 窄窗口 85% / 桌面 70% |",
				"",
				"验证命令都过了，`tauri dev` 里重点看两处：快速滚动时 outline 高亮是否跟手，以及窄窗口下用户气泡换行观感。",
			].join("\n"),
			time: "11:49",
			activity: [
				{
					id: "s1-a7-tool-1",
					type: "tool",
					toolName: "edit",
					args: { path: "src/components/chat/chat-page.tsx" },
					status: "complete",
				},
			],
		},
		{
			id: "s1-u8",
			role: "user",
			text: "如果后面接上真实 RPC streaming，消息渲染这块还要动吗？",
			time: "12:02",
		},
		{
			id: "s1-a8",
			role: "assistant",
			text: [
				"渲染层基本不用动，换的是数据源：",
				"",
				"1. `MOCK_CONVERSATIONS` 换成 Pi JSONL 的增量事件",
				"2. `streaming` 标记由 RPC 的 `message.update` 驱动",
				"3. `activity` 来自 tool call 事件，字段结构保持一致即可",
				"",
				"Streamdown 已经处理了增量 markdown 的重渲染，长回复也不会整段重绘。唯一要注意的是自动滚动：streaming 期间保持 sticky 到底部，用户上翻就解除，这部分逻辑已经在了。",
			].join("\n"),
			time: "12:03",
		},
		{
			id: "s1-u9",
			role: "user",
			text: "好。那我先去接 Runtime 那边的事件，前端这块到时候再联调。今天的改动我先提交。",
			time: "12:10",
		},
		{
			id: "s1-a9",
			role: "assistant",
			text: "好的。提交建议拆两个：一个是滚动条对齐 + 遮挡修正，一个是 scroll 节流 + 气泡上限，方便回溯。联调时如果 JSONL 事件结构和现在的 mock 对不上，直接把样例发我就行。",
			time: "12:11",
		},
	],
	s2: [
		{
			id: "s2-u1",
			role: "user",
			text: "Connection 和 PiSession 应该怎么分层？Local、WSL、SSH 后面都要支持。",
			time: "09:42",
		},
		{
			id: "s2-a1",
			role: "assistant",
			text: "Connection 只描述运行位置；Local / WSL / SSH 都由 `ServerManager` 建立对应的 `pilo-server`，Pi、文件、Git、Session 和 Terminal 再通过统一 RPC 调用目标环境。上层 Runtime 不需要区分具体 transport。",
			time: "09:44",
			activity: ["connection.rs", "server_client.rs", "server_pi.rs"].map(
				(path, index) => ({
					id: `s2-a1-tool-${index}`,
					type: "tool" as const,
					toolName: "read",
					args: { path },
					status: "complete" as const,
				}),
			),
		},
	],
	s3: [
		{
			id: "s3-u1",
			role: "user",
			text: "Pi RPC 接入后前端应该怎么消费事件？",
			time: "16:08",
		},
		{
			id: "s3-a1",
			role: "assistant",
			text: "前端只监听统一的 `pilo://runtime` event，再按 `type` 分发。Runtime 自己负责 generation 过滤，所以 React 不需要知道旧进程的事件。\n\n当前代际关系可以写成 $g_{next} > g_{active}$，旧 generation 的事件直接丢弃。\n\n```mermaid\nflowchart LR\n  Pi[Pi RPC] --> Runtime[Pilo Runtime]\n  Runtime --> Event[pilo://runtime]\n  Event --> React[React UI]\n```",
			time: "16:09",
		},
	],
};

function ConversationColumn({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("mx-auto w-full max-w-[46rem] px-3 sm:px-4", className)}>
			{children}
		</div>
	);
}

function MessageAction({
	label,
	children,
	onClick,
}: {
	label: string;
	children: ReactNode;
	onClick?: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-7 rounded-md text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100"
					aria-label={label}
					onClick={onClick}
				>
					{children}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

const LARGE_MESSAGE_PREVIEW_CHARS = 8_000;

function markdownPreview(text: string) {
	let preview = text.slice(0, LARGE_MESSAGE_PREVIEW_CHARS);
	const lastLineBreak = preview.lastIndexOf("\n");
	if (lastLineBreak > LARGE_MESSAGE_PREVIEW_CHARS * 0.75) {
		preview = preview.slice(0, lastLineBreak);
	}
	const fenceCount = preview.match(/```/g)?.length ?? 0;
	if (fenceCount % 2 === 1) preview += "\n```";
	return `${preview}\n\n…`;
}

function CollapsibleMessageBody({
	text,
	markdown = false,
	streaming = false,
}: {
	text: string;
	markdown?: boolean;
	streaming?: boolean;
}) {
	const collapsible = !streaming && text.length > LARGE_MESSAGE_PREVIEW_CHARS;
	const [expanded, setExpanded] = useState(false);
	const visibleText = collapsible && !expanded ? markdownPreview(text) : text;

	return (
		<div className="min-w-0 [content-visibility:auto] [contain-intrinsic-size:auto_96px]">
			{markdown ? (
				<ChatMarkdown text={visibleText} isStreaming={streaming} />
			) : (
				<p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
					{visibleText}
				</p>
			)}
			{collapsible ? (
				<button
					type="button"
					className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
					onClick={() => setExpanded((value) => !value)}
				>
					<ChevronDown
						className={cn(
							"size-3 transition-transform",
							expanded && "rotate-180",
						)}
					/>
					{expanded ? "收起消息" : "展开完整消息"}
				</button>
			) : null}
		</div>
	);
}

const UserMessage = memo(function UserMessage({
	message,
}: {
	message: Extract<ChatMessage, { role: "user" }>;
}) {
	recordChatMessageRender("user");
	const { conversationFontSize } = usePreferences();

	return (
		<ConversationColumn className="py-2 sm:py-3">
			<div className="flex w-full justify-end">
				<div className="group flex min-w-0 max-w-[80%] flex-col items-end gap-1.5 sm:max-w-[70%]">
					<div className="flex items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
						{message.queued ? (
							<span>{message.queued === "steer" ? "待调整" : "已排队"}</span>
						) : null}
						{message.time ? <span>{message.time}</span> : null}
					</div>
					<div className="flex min-w-0 max-w-full justify-end">
						<div
							className="min-w-0 max-w-full rounded-[1.15rem] border border-foreground/[0.08] bg-foreground/[0.05] px-3.5 py-2 leading-6 text-foreground sm:rounded-2xl sm:px-4 sm:py-2.5"
							style={{ fontSize: `${conversationFontSize}px` }}
						>
							<CollapsibleMessageBody text={message.text} />
						</div>
					</div>
					<div className="flex gap-0.5">
						<MessageAction
							label="复制"
							onClick={() => void navigator.clipboard.writeText(message.text)}
						>
							<Copy className="size-3.5" />
						</MessageAction>
					</div>
				</div>
			</div>
		</ConversationColumn>
	);
});

function getAssistantMessageContent(
	message: Extract<ChatMessage, { role: "assistant" }>,
): AssistantContentItem[] {
	if (message.content) return message.content;

	const content: AssistantContentItem[] = [];
	if (message.activity) content.push(...message.activity);
	if (message.text) {
		content.push({
			id: `${message.id}-text`,
			type: "text",
			text: message.text,
		});
	}
	return content;
}

const AssistantMessage = memo(function AssistantMessage({
	message,
	replyRunwayPx,
	onOpenFile,
}: {
	message: Extract<ChatMessage, { role: "assistant" }>;
	replyRunwayPx?: number;
	onOpenFile?: (path: string) => void;
}) {
	recordChatMessageRender("assistant");
	const { conversationFontSize, showWorkDuration } = usePreferences();
	const content = getAssistantMessageContent(message);
	const activity = getAssistantActivities(content);
	const streamingLabel = getAssistantStreamingLabel({
		text: message.text,
		activity,
		streaming: message.streaming,
	});
	const hasWorkActivity = activity.length > 0;
	const footerDuration =
		showWorkDuration && !hasWorkActivity && message.workDurationMs !== undefined
			? formatWorkDuration(message.workDurationMs)
			: "";
	const contentNodes: ReactNode[] = [];
	let firstActivityGroup = true;

	for (let index = 0; index < content.length; index += 1) {
		const item = content[index];
		if (item.type === "text") {
			if (item.text) {
				contentNodes.push(
					<CollapsibleMessageBody
						key={item.id}
						text={item.text}
						markdown
						streaming={
							message.streaming === true && index === content.length - 1
						}
					/>,
				);
			}
			continue;
		}

		const group: AssistantActivity[] = [];
		const groupStart = index;
		while (index < content.length && content[index].type !== "text") {
			group.push(content[index] as AssistantActivity);
			index += 1;
		}
		index -= 1;
		const groupKey = group[0]?.id ?? `activity-${groupStart}`;
		contentNodes.push(
			<AssistantActivityView
				key={`${message.id}-${groupKey}-${message.streaming ? "running" : "complete"}`}
				activity={group}
				streaming={message.streaming === true}
				durationMs={firstActivityGroup ? message.workDurationMs : undefined}
				onOpenPath={onOpenFile}
			/>,
		);
		firstActivityGroup = false;
	}

	return (
		<ConversationColumn className="group py-2 sm:py-3">
			<div
				className="w-full text-foreground"
				style={
					replyRunwayPx === undefined
						? { fontSize: `${conversationFontSize}px` }
						: {
								fontSize: `${conversationFontSize}px`,
								minHeight: `${replyRunwayPx}px`,
							}
				}
			>
				<div className="relative">
					{contentNodes}
					{message.errorMessage ? (
						<div
							role="alert"
							className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
						>
							{message.errorMessage}
						</div>
					) : null}
					{streamingLabel ||
					message.errorMessage ||
					message.stopReason === "aborted" ? (
						<div className="mt-1 flex min-h-6 items-center gap-1 text-[11px] text-muted-foreground">
							{streamingLabel ? (
								<ChatAgentActivityIndicator label={streamingLabel} />
							) : message.errorMessage ? (
								<span className="text-destructive">Pi 响应失败</span>
							) : (
								<span>已停止</span>
							)}
						</div>
					) : !message.streaming &&
					  (message.text || message.time || footerDuration) ? (
						<div className="mt-0.5 flex min-h-7 flex-wrap items-center gap-2 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100">
							{message.text ? (
								<MessageAction
									label="复制"
									onClick={() =>
										void navigator.clipboard.writeText(message.text)
									}
								>
									<Copy className="size-3.5" />
								</MessageAction>
							) : null}
							{message.time ? (
								<span className="tabular-nums">{message.time}</span>
							) : null}
							{message.time && footerDuration ? (
								<span aria-hidden="true">·</span>
							) : null}
							{footerDuration ? (
								<span className="font-mono tabular-nums">{footerDuration}</span>
							) : null}
						</div>
					) : null}
				</div>
			</div>
		</ConversationColumn>
	);
});

function EmptyConversation() {
	return (
		<ConversationColumn className="flex flex-1 items-center justify-center">
			<EmptyState
				variant="hero"
				title="今天想做点什么？"
				icon={
					<svg viewBox="0 0 800 800" className="h-20 w-20" aria-hidden="true">
						<path
							className="fill-current"
							fillRule="evenodd"
							d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
						/>
						<path
							className="fill-current"
							d="M517.36 400H634.72V634.72H517.36Z"
						/>
					</svg>
				}
			/>
		</ConversationColumn>
	);
}

function SessionHeader({
	session,
	sessionState,
	onRename,
	onOpenChanges,
	onExpandSidebar,
	reserveWindowControls = false,
	sidebarCollapsed = false,
}: {
	session: ChatSession;
	sessionState?: ChatSessionRuntimeState;
	onRename?: () => void;
	onOpenChanges?: () => void;
	onExpandSidebar?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
}) {
	return (
		<header
			data-tauri-drag-region="deep"
			className={cn(
				"mt-0.5 flex h-11 shrink-0 items-center bg-background",
				IS_MACOS && sidebarCollapsed && TRAFFIC_LIGHT_GUTTER,
				reserveWindowControls && "pr-[7.75rem]",
			)}
		>
			{sidebarCollapsed ? (
				<div className="flex shrink-0 items-center pl-3">
					<Button
						variant="ghost"
						size="icon"
						className="size-7 shrink-0 text-muted-foreground"
						aria-label="展开侧边栏"
						onClick={onExpandSidebar}
					>
						<PanelLeft className="size-4" />
					</Button>
				</div>
			) : null}
			<div
				role="tablist"
				aria-label="会话"
				className="flex min-w-0 flex-1 items-center px-1"
			>
				<div
					role="tab"
					aria-selected="true"
					tabIndex={0}
					className="group flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md border border-transparent px-3 text-[13px] text-foreground outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
					onDoubleClick={onRename}
					title={onRename ? "双击重命名" : undefined}
				>
					<svg
						viewBox="0 0 800 800"
						className="size-3 shrink-0 text-muted-foreground opacity-60"
						aria-hidden="true"
					>
						<path
							className="fill-current"
							fillRule="evenodd"
							d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
						/>
						<path
							className="fill-current"
							d="M517.36 400H634.72V634.72H517.36Z"
						/>
					</svg>
					<span className="truncate">
						{sessionState?.name || session.title}
					</span>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1 pr-2">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="ghost"
							size="icon"
							className="size-7"
							aria-label="显示变更"
							onClick={onOpenChanges}
						>
							<PanelRight className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>显示变更</TooltipContent>
				</Tooltip>
			</div>
		</header>
	);
}

function formatTime(timestampMs = Date.now()) {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(timestampMs));
}

function getSessionHistoryFingerprint(session: ChatSession) {
	if (
		!session.sessionPath ||
		session.historyFileSize === undefined ||
		session.historyFileMtimeNs === undefined
	) {
		return null;
	}
	return `${session.historyFileSize}:${session.historyFileMtimeNs}`;
}

type ActiveTurn = {
	sessionId: string;
	sessionTitle: string;
	generation: number | null;
	promptSent: boolean;
};

let localMessageSequence = 0;
let localActivitySequence = 0;

const CHAT_VIRTUAL_OVERSCAN = 6;
const CHAT_VIRTUAL_SCROLL_PADDING_PX = 16;

type ChatVirtualPadding = {
	start: number;
	end: number;
};

function getChatVirtualPadding(): ChatVirtualPadding {
	if (
		typeof window !== "undefined" &&
		window.matchMedia("(min-width: 640px)").matches
	) {
		return { start: 24, end: 40 };
	}
	return { start: 16, end: 32 };
}

function useChatVirtualPadding() {
	const [padding, setPadding] = useState<ChatVirtualPadding>(
		getChatVirtualPadding,
	);

	useEffect(() => {
		const media = window.matchMedia("(min-width: 640px)");
		const sync = () =>
			setPadding(
				media.matches ? { start: 24, end: 40 } : { start: 16, end: 32 },
			);
		media.addEventListener("change", sync);
		return () => media.removeEventListener("change", sync);
	}, []);

	return padding;
}

function createLocalMessageId(kind: "user" | "assistant") {
	localMessageSequence += 1;
	return `local-${kind}-${Date.now()}-${localMessageSequence}`;
}

function createLocalContentId(kind: "thinking" | "text") {
	localActivitySequence += 1;
	return `local-${kind}-${Date.now()}-${localActivitySequence}`;
}

const conversationReducerContext = {
	createMessageId: createLocalMessageId,
	createContentId: createLocalContentId,
	now: () => Date.now(),
	formatTime,
};

type ChatPageProps = {
	session: ChatSession;
	active?: boolean;
	onSessionIdentified?: (sessionId: string) => void;
	onOpenChanges?: () => void;
	onExpandSidebar?: () => void;
	onSessionChanged?: () => void;
	onOpenFile?: (path: string) => void;
	initialMessage?: string;
	loadState?: "ready" | "loading" | "error";
	onRetry?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
};

function ChatPageImpl({
	session,
	active = true,
	onSessionIdentified,
	onOpenChanges,
	onExpandSidebar,
	onSessionChanged,
	onOpenFile,
	initialMessage,
	loadState = "ready",
	onRetry,
	reserveWindowControls = false,
	sidebarCollapsed = false,
}: ChatPageProps) {
	const { desktopNotifications } = usePreferences();
	const client = useMemo(
		() =>
			createChatSessionClient(
				session.projectRecord.id,
				session.id,
				session.sessionPath,
			),
		[session.projectRecord.id, session.id, session.sessionPath],
	);
	const identifiedRef = useRef(onSessionIdentified);
	identifiedRef.current = onSessionIdentified;
	const [conversationStates, setConversationStates] = useState<
		Record<string, ConversationState>
	>({});
	const [historyLoadState, setHistoryLoadState] = useState<
		"ready" | "loading" | "error"
	>(session.sessionPath ? "loading" : "ready");
	const [historyRetry, setHistoryRetry] = useState(0);
	const [historyProgress, setHistoryProgress] = useState("");
	const sessionHistoryFingerprint = getSessionHistoryFingerprint(session);
	const historyFingerprintRef = useRef(sessionHistoryFingerprint);
	historyFingerprintRef.current = sessionHistoryFingerprint;
	const loadedHistoryFingerprintRef = useRef<string | null>(null);
	const baseMessages = useMemo<ChatMessage[]>(() => {
		if (initialMessage) {
			return [
				{
					id: `${session.id}-initial`,
					role: "user",
					text: initialMessage,
					time: formatTime(),
				},
			];
		}
		if (session.sessionPath) return EMPTY_MESSAGES;
		return MOCK_CONVERSATIONS[session.id] ?? EMPTY_MESSAGES;
	}, [initialMessage, session.id, session.sessionPath]);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [modelOptions, setModelOptions] = useState<PiModel[]>([]);
	const [selectedModel, setSelectedModel] = useState<PiModel | null>(
		session.initialModel ?? null,
	);
	const [modelLoadState, setModelLoadState] = useState<
		"idle" | "loading" | "ready" | "error"
	>("idle");
	const [modelError, setModelError] = useState<string | null>(null);
	const [modelChanging, setModelChanging] = useState(false);
	const modelRequestRef = useRef(0);
	const [thinkingLevels, setThinkingLevels] = useState<PiThinkingLevel[]>([]);
	const [selectedThinkingLevel, setSelectedThinkingLevel] =
		useState<PiThinkingLevel>("off");
	const [thinkingLoading, setThinkingLoading] = useState(false);
	const [thinkingChanging, setThinkingChanging] = useState(false);
	const [sessionState, setSessionState] =
		useState<ChatSessionRuntimeState | null>(null);
	const initialConfigAppliedRef = useRef(new Set<string>());

	const handleRenameSession = useCallback(async () => {
		if (session.sessionPath) {
			toast.info(
				"历史 Session 在查看时保持只读。继续对话后再由 Pi 管理 Session 元数据。",
			);
			return;
		}
		const name = window
			.prompt("Session name", sessionState?.name || session.title)
			?.trim();
		if (!name) return;
		try {
			await client.ensure();
			await client.setPiSessionName(name);
			setSessionState((current) => ({ ...current, name }));
			onSessionChanged?.();
		} catch (error) {
			toast.error("无法重命名 Session", {
				description: runtimeErrorMessage(error),
			});
		}
	}, [
		session.sessionPath,
		session.title,
		client,
		sessionState?.name,
		onSessionChanged,
	]);

	useEffect(() => {
		modelRequestRef.current += 1;
		setSessionState(null);
		setModelOptions(
			getCachedProjectPiModels(session.projectRecord.id)?.models ?? [],
		);
		setSelectedModel(session.initialModel ?? null);
		setModelLoadState("idle");
		setModelError(null);
		setModelChanging(false);
		setThinkingLevels([]);
		setSelectedThinkingLevel(session.initialThinkingLevel ?? "off");
	}, [
		session.id,
		session.initialModel,
		session.initialThinkingLevel,
		session.projectRecord.id,
	]);

	useEffect(() => {
		const sessionPath = session.sessionPath;
		if (!sessionPath) {
			loadedHistoryFingerprintRef.current = null;
			setHistoryLoadState("ready");
			return;
		}
		const requestedFingerprint = historyFingerprintRef.current;
		let cancelled = false;
		const loadHistory = async () => {
			const startedAt = performance.now();
			setHistoryLoadState("loading");
			setHistoryProgress("正在读取历史消息");
			try {
				const result = await loadSessionHistory(
					session.projectRecord.id,
					sessionPath,
				);
				if (cancelled) return;
				console.info("[Pilo history] read_session_file", {
					durationMs: Math.round(performance.now() - startedAt),
					eventCount: result.events.length,
				});
				const cachedModels =
					getCachedProjectPiModels(session.projectRecord.id)?.models ?? [];
				if (result.model) {
					const historicalModel = cachedModels.find(
						(model) =>
							model.provider === result.model?.provider &&
							model.id === result.model?.id,
					) ?? {
						provider: result.model.provider,
						id: result.model.id,
						name: result.model.id,
						reasoning: false,
					};
					setSelectedModel(historicalModel);
				}
				if (
					result.thinkingLevel &&
					PI_THINKING_LEVELS.includes(result.thinkingLevel as PiThinkingLevel)
				) {
					setSelectedThinkingLevel(result.thinkingLevel as PiThinkingLevel);
				}
				setThinkingLevels(PI_THINKING_LEVELS);
				setSessionState({
					name: result.name ?? undefined,
					messageCount: result.sourceMessageCount,
				});
				const replayStartedAt = performance.now();
				const finalState = await replayConversationEventsBatched(
					result.events,
					conversationReducerContext,
					{
						maxEventsPerBatch: 400,
						onBatch: (state) => {
							if (cancelled) return;
							setConversationStates((current) => ({
								...current,
								[session.id]: state,
							}));
							setHistoryProgress(
								`正在恢复历史消息 ${state.messages.length} 条`,
							);
						},
					},
				);
				if (cancelled) return;
				setConversationStates((current) => ({
					...current,
					[session.id]: finalState,
				}));
				console.info("[Pilo history] conversation_replay", {
					durationMs: Math.round(performance.now() - replayStartedAt),
					eventCount: result.events.length,
					messageCount: finalState.messages.length,
				});
				loadedHistoryFingerprintRef.current = requestedFingerprint;
				setHistoryProgress("");
				setHistoryLoadState("ready");
			} catch (error) {
				if (cancelled) return;
				console.error("Failed to read session history", error);
				setHistoryProgress("");
				setHistoryLoadState("error");
			}
		};
		void loadHistory();
		return () => {
			cancelled = true;
		};
	}, [session.id, session.sessionPath, session.projectRecord.id, historyRetry]);

	const activeTurnRef = useRef<ActiveTurn | null>(null);
	const runtimeListenerRef = useRef<ReturnType<typeof client.listen> | null>(
		null,
	);
	const runtimeEventHandlerRef = useRef<(event: PiloRuntimeEvent) => void>(
		() => {},
	);
	const sentInitialPromptsRef = useRef(new Set<string>());
	const [activeTurnSessionId, setActiveTurnSessionId] = useState<string | null>(
		null,
	);
	const [activeTurnGeneration, setActiveTurnGeneration] = useState<
		number | null
	>(null);
	const [pendingSteering, setPendingSteering] = useState(0);
	const [pendingFollowUps, setPendingFollowUps] = useState(0);

	useEffect(() => {
		if (
			!active ||
			!session.sessionPath ||
			sessionHistoryFingerprint === null ||
			historyLoadState === "loading"
		) {
			return;
		}
		const loadedFingerprint = loadedHistoryFingerprintRef.current;
		if (
			loadedFingerprint === null ||
			loadedFingerprint === sessionHistoryFingerprint ||
			activeTurnSessionId === session.id
		) {
			return;
		}
		setHistoryRetry((value) => value + 1);
	}, [
		active,
		activeTurnSessionId,
		historyLoadState,
		session.id,
		session.sessionPath,
		sessionHistoryFingerprint,
	]);

	const conversationState = conversationStates[session.id];
	const messages = conversationState?.messages ?? baseMessages;
	const effectiveLoadState = session.sessionPath
		? historyLoadState === "loading" && messages.length > 0
			? "ready"
			: historyLoadState
		: loadState;
	const outlineEntries = useMemo(
		() => buildConversationOutline(messages),
		[messages],
	);
	const draft = drafts[session.id] ?? "";
	const setDraft = (value: string) => {
		setDrafts((current) => ({ ...current, [session.id]: value }));
	};

	const scrollRef = useRef<HTMLDivElement>(null);
	const scrollPositionRef = useRef(0);
	const roundRefs = useRef(new Map<string, HTMLDivElement>());
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const virtualPadding = useChatVirtualPadding();
	const virtualized =
		active &&
		effectiveLoadState === "ready" &&
		shouldVirtualizeChatMessages(messages.length);
	recordChatPageRender(session.id, messages.length, virtualized);
	const getVirtualMessageKey = useCallback(
		(index: number) =>
			`${session.id}:${messagesRef.current[index]?.id ?? index}`,
		[session.id],
	);
	const estimateVirtualMessageSize = useCallback(
		(index: number) => (messagesRef.current[index]?.role === "user" ? 84 : 184),
		[],
	);
	/* oxlint-disable-next-line react/incompatible-library -- TanStack Virtual intentionally owns imperative measurement and scroll functions; keep the virtualizer local to this component. */
	const messageVirtualizer = useVirtualizer({
		count: messages.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: estimateVirtualMessageSize,
		getItemKey: getVirtualMessageKey,
		overscan: CHAT_VIRTUAL_OVERSCAN,
		paddingStart: virtualPadding.start,
		paddingEnd: virtualPadding.end,
		scrollPaddingStart: CHAT_VIRTUAL_SCROLL_PADDING_PX,
		useAnimationFrameWithResizeObserver: true,
		directDomUpdates: true,
		onChange: (instance, sync) => {
			const range = instance.range;
			recordVirtualChange({
				sync,
				startIndex: range?.startIndex ?? null,
				endIndex: range?.endIndex ?? null,
				totalSize: instance.getTotalSize(),
			});
		},
		enabled: virtualized,
	});
	const stickyRef = useRef(true);
	const scrollSyncFrameRef = useRef<number | null>(null);
	const [isSticky, setIsSticky] = useState(true);
	const isScrolledFromTopRef = useRef(false);
	const [isScrolledFromTop, setIsScrolledFromTop] = useState(false);
	const [activeOutlineIndex, setActiveOutlineIndex] = useState(
		outlineEntries.length ? outlineEntries.length - 1 : -1,
	);
	const activeOutlineIndexRef = useRef(activeOutlineIndex);
	activeOutlineIndexRef.current = activeOutlineIndex;

	const syncScrollState = useCallback(() => {
		recordScrollEvent();
		const viewport = scrollRef.current;
		if (!viewport) return;
		scrollPositionRef.current = viewport.scrollTop;
		if (scrollSyncFrameRef.current !== null) return;

		scrollSyncFrameRef.current = requestAnimationFrame(() => {
			scrollSyncFrameRef.current = null;
			const currentViewport = scrollRef.current;
			if (!currentViewport) return;

			const distanceFromBottom =
				currentViewport.scrollHeight -
				currentViewport.clientHeight -
				currentViewport.scrollTop;
			const nextSticky = distanceFromBottom <= 72;
			if (stickyRef.current !== nextSticky) {
				stickyRef.current = nextSticky;
				setIsSticky(nextSticky);
			}
			const nextScrolledFromTop = currentViewport.scrollTop > 16;
			if (isScrolledFromTopRef.current !== nextScrolledFromTop) {
				isScrolledFromTopRef.current = nextScrolledFromTop;
				setIsScrolledFromTop(nextScrolledFromTop);
			}

			if (outlineEntries.length === 0) {
				if (activeOutlineIndexRef.current !== -1) {
					activeOutlineIndexRef.current = -1;
					setActiveOutlineIndex(-1);
				}
				return;
			}
			if (distanceFromBottom <= 2) {
				const nextIndex = outlineEntries.length - 1;
				if (activeOutlineIndexRef.current !== nextIndex) {
					activeOutlineIndexRef.current = nextIndex;
					setActiveOutlineIndex(nextIndex);
				}
				return;
			}
			const readingLine = currentViewport.scrollTop + 72;
			if (virtualized) {
				const readingItem =
					messageVirtualizer.getVirtualItemForOffset(readingLine);
				const nextIndex = getOutlineIndexForMessageIndex(
					outlineEntries,
					readingItem?.index ?? 0,
				);
				if (activeOutlineIndexRef.current !== nextIndex) {
					activeOutlineIndexRef.current = nextIndex;
					setActiveOutlineIndex(nextIndex);
				}
				return;
			}

			let nextIndex = 0;
			for (let index = 0; index < outlineEntries.length; index += 1) {
				const row = roundRefs.current.get(outlineEntries[index].key);
				if (!row || row.offsetTop > readingLine) break;
				nextIndex = index;
			}
			if (activeOutlineIndexRef.current !== nextIndex) {
				activeOutlineIndexRef.current = nextIndex;
				setActiveOutlineIndex(nextIndex);
			}
		});
	}, [messageVirtualizer, outlineEntries, virtualized]);

	useEffect(() => {
		logChatPerformanceInstructions();
	}, []);

	useEffect(
		() => () => {
			if (scrollSyncFrameRef.current !== null) {
				cancelAnimationFrame(scrollSyncFrameRef.current);
			}
		},
		[],
	);

	const scrollToBottom = useCallback((smooth = true) => {
		const viewport = scrollRef.current;
		if (!viewport) return;
		viewport.scrollTo({
			top: viewport.scrollHeight,
			behavior: smooth ? "smooth" : "auto",
		});
		stickyRef.current = true;
		setIsSticky(true);
	}, []);

	const dispatchConversation = useCallback(
		(targetSessionId: string, action: ConversationAction) => {
			setConversationStates((current) => {
				const existing =
					current[targetSessionId] ??
					createConversationState(
						targetSessionId === session.id ? messagesRef.current : [],
					);
				const next = reduceConversation(
					existing,
					action,
					conversationReducerContext,
				);
				if (next === existing) return current;
				return { ...current, [targetSessionId]: next };
			});
		},
		[session.id],
	);

	const releaseActiveTurn = useCallback((turn: ActiveTurn) => {
		if (activeTurnRef.current !== turn) return;
		activeTurnRef.current = null;
		setActiveTurnSessionId(null);
		setActiveTurnGeneration(null);
		setPendingSteering(0);
		setPendingFollowUps(0);
	}, []);

	const failActiveTurn = useCallback(
		(turn: ActiveTurn, message: string) => {
			if (activeTurnRef.current !== turn) return;
			dispatchConversation(turn.sessionId, {
				type: "conversation_runtime_error",
				message,
				timestampMs: Date.now(),
			});
			releaseActiveTurn(turn);
		},
		[dispatchConversation, releaseActiveTurn],
	);

	const handleRuntimeEvent = useCallback(
		(event: PiloRuntimeEvent) => {
			const turn = activeTurnRef.current;
			if (
				!turn ||
				turn.generation === null ||
				event.generation !== turn.generation
			) {
				return;
			}

			const action = toConversationAction(event);
			if (action) {
				dispatchConversation(turn.sessionId, action);
			}

			switch (event.type) {
				case "assistant_message_end":
					if (
						desktopNotifications &&
						event.stopReason !== "aborted" &&
						event.stopReason !== "error" &&
						!event.errorMessage?.trim()
					) {
						notifyReplyCompleted(turn.sessionTitle);
					}
					void readCurrentPiSessionState(client)
						.then((state) => setSessionState(state))
						.catch(() => undefined);
					releaseActiveTurn(turn);
					break;
				case "user_message_start":
					requestAnimationFrame(() => scrollToBottom(false));
					break;
				case "queue_update":
					setPendingSteering(event.steering.length);
					setPendingFollowUps(event.followUp.length);
					break;
				case "runtime_error":
					failActiveTurn(turn, event.message);
					break;
				case "process_state":
					if (event.state === "failed" || event.state === "stopped") {
						failActiveTurn(
							turn,
							event.state === "failed"
								? "Pi 进程运行失败。"
								: "Pi 进程在回复完成前已停止。",
						);
					}
					break;
				case "rpc_message":
				case "assistant_message_start":
				case "assistant_text_delta":
				case "assistant_text_snapshot":
				case "assistant_thinking_start":
				case "assistant_thinking_delta":
				case "assistant_thinking_end":
				case "tool_execution_start":
				case "tool_execution_update":
				case "tool_execution_end":
				case "runtime_log":
					break;
			}
		},
		[
			client,
			desktopNotifications,
			dispatchConversation,
			failActiveTurn,
			releaseActiveTurn,
			scrollToBottom,
		],
	);

	useEffect(() => {
		runtimeEventHandlerRef.current = handleRuntimeEvent;
	}, [handleRuntimeEvent]);

	useEffect(() => {
		let disposed = false;
		const subscription = client.listen((event) => {
			runtimeEventHandlerRef.current(event);
		});
		runtimeListenerRef.current = subscription;
		void subscription.catch((error) => {
			if (disposed) return;
			const turn = activeTurnRef.current;
			if (turn) failActiveTurn(turn, runtimeErrorMessage(error));
		});

		return () => {
			disposed = true;
			if (runtimeListenerRef.current === subscription) {
				runtimeListenerRef.current = null;
			}
			void subscription.then((unlisten) => unlisten()).catch(() => undefined);
		};
	}, [client, failActiveTurn]);

	const loadModelOptions = useCallback(async () => {
		if (modelLoadState === "loading" || modelChanging) return;
		const requestId = ++modelRequestRef.current;
		setModelLoadState("loading");
		setModelError(null);
		if (session.sessionPath) {
			const cached =
				getCachedProjectPiModels(session.projectRecord.id)?.models ?? [];
			const options =
				selectedModel &&
				!cached.some(
					(model) =>
						model.provider === selectedModel.provider &&
						model.id === selectedModel.id,
				)
					? [selectedModel, ...cached]
					: cached;
			setModelOptions(options);
			setThinkingLevels(PI_THINKING_LEVELS);
			setModelLoadState("ready");
			return;
		}
		try {
			await client.ensure();
			const [state, result, thinking] = await Promise.all([
				client.getPiAgentState(),
				client.getAvailablePiModels(),
				client.getAvailablePiThinkingLevels(),
			]);
			if (modelRequestRef.current !== requestId) return;
			setSelectedModel(state.model);
			setModelOptions(result.models);
			cacheProjectPiModels(session.projectRecord.id, result.models);
			setSelectedThinkingLevel(state.thinkingLevel);
			setThinkingLevels(thinking.levels);
			setModelLoadState("ready");
		} catch (error) {
			if (modelRequestRef.current !== requestId) return;
			setModelError(runtimeErrorMessage(error));
			setModelLoadState("error");
		}
	}, [
		modelChanging,
		modelLoadState,
		client,
		selectedModel,
		session.sessionPath,
		session.projectRecord.id,
	]);

	const handleModelChange = useCallback(
		(model: PiModel | null) => {
			if (!model || modelChanging) return;
			if (session.sessionPath) {
				setSelectedModel(model);
				setModelError(null);
				return;
			}
			const previousModel = selectedModel;
			const requestId = ++modelRequestRef.current;
			setSelectedModel(model);
			setModelChanging(true);
			setModelError(null);

			void (async () => {
				try {
					await client.ensure();
					const applied = await client.setPiModel(model);
					const [state, thinking] = await Promise.all([
						client.getPiAgentState(),
						client.getAvailablePiThinkingLevels(),
					]);
					if (modelRequestRef.current !== requestId) return;
					setSelectedModel(state.model ?? applied);
					setSelectedThinkingLevel(state.thinkingLevel);
					setThinkingLevels(thinking.levels);
					setModelLoadState("ready");
				} catch (error) {
					if (modelRequestRef.current !== requestId) return;
					setSelectedModel(previousModel);
					toast.error("无法切换模型", {
						description: runtimeErrorMessage(error),
					});
				} finally {
					if (modelRequestRef.current === requestId) setModelChanging(false);
				}
			})();
		},
		[modelChanging, selectedModel, client, session.sessionPath],
	);

	const loadThinkingLevels = useCallback(async () => {
		if (thinkingLoading || thinkingChanging) return;
		if (session.sessionPath) {
			setThinkingLevels(PI_THINKING_LEVELS);
			return;
		}
		setThinkingLoading(true);
		try {
			await client.ensure();
			const [levels, state] = await Promise.all([
				client.getAvailablePiThinkingLevels(),
				client.getPiAgentState(),
			]);
			setThinkingLevels(levels.levels);
			setSelectedThinkingLevel(state.thinkingLevel);
		} catch (error) {
			toast.error("无法读取思考等级", {
				description: runtimeErrorMessage(error),
			});
		} finally {
			setThinkingLoading(false);
		}
	}, [client, session.sessionPath, thinkingChanging, thinkingLoading]);

	const handleThinkingChange = useCallback(
		(level: PiThinkingLevel | null) => {
			if (!level || thinkingChanging || level === selectedThinkingLevel) return;
			if (session.sessionPath) {
				setSelectedThinkingLevel(level);
				return;
			}
			const previous = selectedThinkingLevel;
			setSelectedThinkingLevel(level);
			setThinkingChanging(true);
			void (async () => {
				try {
					await client.ensure();
					await client.setPiThinkingLevel(level);
					const state = await client.getPiAgentState();
					setSelectedThinkingLevel(state.thinkingLevel);
				} catch (error) {
					setSelectedThinkingLevel(previous);
					toast.error("无法切换思考等级", {
						description: runtimeErrorMessage(error),
					});
				} finally {
					setThinkingChanging(false);
				}
			})();
		},
		[selectedThinkingLevel, client, session.sessionPath, thinkingChanging],
	);

	const beginTurn = useCallback(
		async (text: string, appendUserMessage = true) => {
			const trimmed = text.trim();
			if (!trimmed || activeTurnRef.current) return;
			const viewport = scrollRef.current;
			const replyRunwayPx = viewport
				? getReplyRunwayHeight({
						viewportHeight: viewport.clientHeight,
						scrollHeight: viewport.scrollHeight,
						enabled: appendUserMessage,
					})
				: undefined;

			const turn: ActiveTurn = {
				sessionId: session.id,
				sessionTitle: session.title,
				generation: null,
				promptSent: false,
			};
			activeTurnRef.current = turn;
			setActiveTurnSessionId(turn.sessionId);

			const submittedAtMs = Date.now();
			const clientMessageId = createLocalMessageId("user");
			dispatchConversation(turn.sessionId, {
				type: "local_user_submit",
				clientMessageId,
				text: trimmed,
				timestampMs: submittedAtMs,
				replyRunwayPx,
				appendMessage: appendUserMessage,
			});
			dispatchConversation(turn.sessionId, {
				type: "local_assistant_pending",
				timestampMs: submittedAtMs,
				replyRunwayPx,
			});
			setDrafts((current) => ({ ...current, [turn.sessionId]: "" }));
			requestAnimationFrame(() => scrollToBottom(false));

			try {
				const subscription = runtimeListenerRef.current;
				if (!subscription) {
					throw new Error("Pi Runtime 事件通道尚未就绪。");
				}
				await subscription;
				const snapshot = await client.ensure();
				if (activeTurnRef.current !== turn) return;
				turn.generation = snapshot.generation;
				setActiveTurnGeneration(snapshot.generation);
				const agentState = await client.getPiAgentState();
				if (activeTurnRef.current !== turn) return;
				if (agentState.sessionId) identifiedRef.current?.(agentState.sessionId);
				if (session.sessionPath) {
					let configChanged = false;
					if (
						selectedModel &&
						(agentState.model?.provider !== selectedModel.provider ||
							agentState.model?.id !== selectedModel.id)
					) {
						await client.setPiModel(selectedModel);
						configChanged = true;
					}
					if (agentState.thinkingLevel !== selectedThinkingLevel) {
						await client.setPiThinkingLevel(selectedThinkingLevel);
						configChanged = true;
					}
					if (configChanged) {
						const [state, thinking] = await Promise.all([
							client.getPiAgentState(),
							client.getAvailablePiThinkingLevels(),
						]);
						if (activeTurnRef.current !== turn) return;
						setSelectedModel(state.model);
						setSelectedThinkingLevel(state.thinkingLevel);
						setThinkingLevels(thinking.levels);
					}
				} else if (!initialConfigAppliedRef.current.has(session.id)) {
					if (session.initialModel) {
						await client.setPiModel(session.initialModel);
					}
					if (session.initialThinkingLevel) {
						await client.setPiThinkingLevel(session.initialThinkingLevel);
					}
					if (session.initialModel || session.initialThinkingLevel) {
						const [state, thinking] = await Promise.all([
							client.getPiAgentState(),
							client.getAvailablePiThinkingLevels(),
						]);
						if (activeTurnRef.current !== turn) return;
						setSelectedModel(state.model);
						setSelectedThinkingLevel(state.thinkingLevel);
						setThinkingLevels(thinking.levels);
					}
					initialConfigAppliedRef.current.add(session.id);
				}
				if (activeTurnRef.current !== turn) return;
				turn.promptSent = true;
				await client.sendPiPrompt(trimmed);
			} catch (error) {
				failActiveTurn(turn, runtimeErrorMessage(error));
			}
		},
		[
			dispatchConversation,
			failActiveTurn,
			scrollToBottom,
			selectedModel,
			selectedThinkingLevel,
			session.id,
			session.initialModel,
			session.initialThinkingLevel,
			session.sessionPath,
			session.title,
			client,
		],
	);

	const handleSubmit = useCallback(
		(text: string) => {
			void beginTurn(text);
		},
		[beginTurn],
	);

	const queueMessage = useCallback(
		(text: string, queued: "steer" | "follow_up") => {
			const trimmed = text.trim();
			const turn = activeTurnRef.current;
			if (
				!trimmed ||
				!turn ||
				turn.sessionId !== session.id ||
				turn.generation === null
			) {
				return;
			}

			const messageId = createLocalMessageId("user");
			dispatchConversation(turn.sessionId, {
				type: "local_user_queue",
				clientMessageId: messageId,
				text: trimmed,
				queueKind: queued,
				timestampMs: Date.now(),
			});
			setDrafts((current) => ({ ...current, [turn.sessionId]: "" }));
			requestAnimationFrame(() => scrollToBottom(false));

			const request =
				queued === "steer"
					? client.sendPiSteer(trimmed)
					: client.sendPiFollowUp(trimmed);
			void request.catch((error) => {
				dispatchConversation(turn.sessionId, {
					type: "local_user_queue_failed",
					clientMessageId: messageId,
				});
				setDrafts((current) => ({
					...current,
					[turn.sessionId]: current[turn.sessionId]?.trim()
						? current[turn.sessionId]
						: trimmed,
				}));
				toast.error(queued === "steer" ? "无法调整当前回复" : "无法排队发送", {
					description: runtimeErrorMessage(error),
				});
			});
		},
		[client, dispatchConversation, scrollToBottom, session.id],
	);

	const handleSteer = useCallback(
		(text: string) => queueMessage(text, "steer"),
		[queueMessage],
	);

	const handleFollowUp = useCallback(
		(text: string) => queueMessage(text, "follow_up"),
		[queueMessage],
	);

	const handleStop = useCallback(() => {
		const turn = activeTurnRef.current;
		if (!turn || turn.sessionId !== session.id) return;
		if (turn.generation === null || !turn.promptSent) {
			dispatchConversation(turn.sessionId, {
				type: "local_turn_abort",
				timestampMs: Date.now(),
			});
			releaseActiveTurn(turn);
			return;
		}
		void client.abortPiReply().catch((error) => {
			failActiveTurn(turn, runtimeErrorMessage(error));
		});
	}, [
		client,
		dispatchConversation,
		failActiveTurn,
		releaseActiveTurn,
		session.id,
	]);

	useEffect(() => {
		if (!initialMessage || activeTurnSessionId !== null) return;
		const key = `${session.id}:${initialMessage}`;
		if (sentInitialPromptsRef.current.has(key)) return;
		sentInitialPromptsRef.current.add(key);
		void beginTurn(initialMessage, false);
	}, [activeTurnSessionId, beginTurn, initialMessage, session.id]);

	const sessionId = session.id;
	useEffect(() => {
		if (!sessionId || !active) return;
		const frame = requestAnimationFrame(() => {
			if (stickyRef.current) scrollToBottom(false);
			else scrollRef.current?.scrollTo({ top: scrollPositionRef.current });
		});
		return () => cancelAnimationFrame(frame);
	}, [active, sessionId, scrollToBottom]);

	useEffect(() => {
		if (!session.sessionPath || !stickyRef.current) return;
		const frame = requestAnimationFrame(() => scrollToBottom(false));
		return () => cancelAnimationFrame(frame);
	}, [baseMessages, session.sessionPath, scrollToBottom]);

	const lastMessage = messages[messages.length - 1];
	const streamingMessage =
		lastMessage?.role === "assistant" && lastMessage.streaming
			? lastMessage
			: null;
	useEffect(() => {
		if (!stickyRef.current || streamingMessage === null) return;
		const frame = requestAnimationFrame(() => scrollToBottom(false));
		return () => cancelAnimationFrame(frame);
	}, [streamingMessage, scrollToBottom]);

	const handleOutlineJump = useCallback(
		(index: number) => {
			const entry = outlineEntries[index];
			const viewport = scrollRef.current;
			if (!entry || !viewport) return;
			stickyRef.current = false;
			if (isSticky) setIsSticky(false);
			activeOutlineIndexRef.current = index;
			setActiveOutlineIndex(index);

			if (virtualized) {
				messageVirtualizer.scrollToIndex(entry.messageIndex, {
					align: "start",
				});
				return;
			}

			const row = roundRefs.current.get(entry.key);
			if (!row) return;
			viewport.scrollTo({
				top: Math.max(0, row.offsetTop - CHAT_VIRTUAL_SCROLL_PADDING_PX),
				behavior: "smooth",
			});
		},
		[isSticky, messageVirtualizer, outlineEntries, virtualized],
	);

	const running = activeTurnSessionId === session.id;
	const runtimeBusy = activeTurnSessionId !== null;
	const historyPending =
		session.sessionPath !== undefined && historyLoadState !== "ready";
	const sessionUsageText = formatSessionUsage(sessionState);

	// Keep the session controller subscribed while its view is in the background.
	if (!active) return null;

	return (
		<div className="flex h-full min-w-0 flex-col bg-background">
			<SessionHeader
				session={session}
				sessionState={sessionState ?? undefined}
				onRename={handleRenameSession}
				onOpenChanges={onOpenChanges}
				onExpandSidebar={onExpandSidebar}
				reserveWindowControls={reserveWindowControls}
				sidebarCollapsed={sidebarCollapsed}
			/>
			<div className="relative flex min-h-0 flex-1 flex-col">
				<div
					ref={scrollRef}
					onScroll={syncScrollState}
					className="scrollbar-pro min-h-0 w-full flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
				>
					{effectiveLoadState === "loading" ? (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							<ConversationColumn className="flex flex-1 items-center justify-center">
								<LoadingState
									title="正在加载会话"
									description={historyProgress || "正在读取消息与活动记录。"}
								/>
							</ConversationColumn>
						</div>
					) : effectiveLoadState === "error" ? (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							<ConversationColumn className="flex flex-1 items-center justify-center">
								<ErrorState
									title="会话加载失败"
									description="暂时无法读取这段会话。"
									onRetry={
										session.sessionPath
											? () => setHistoryRetry((value) => value + 1)
											: onRetry
									}
								/>
							</ConversationColumn>
						</div>
					) : messages.length === 0 ? (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							<EmptyConversation />
						</div>
					) : virtualized ? (
						<div
							ref={messageVirtualizer.containerRef}
							className="relative min-h-full"
						>
							{messageVirtualizer.getVirtualItems().map((virtualMessage) => {
								const message = messages[virtualMessage.index];
								if (!message) return null;
								return (
									<div
										key={virtualMessage.key}
										data-index={virtualMessage.index}
										ref={messageVirtualizer.measureElement}
										className="absolute left-0 top-0 w-full"
									>
										{message.role === "user" ? (
											<UserMessage message={message} />
										) : (
											<AssistantMessage
												message={message}
												onOpenFile={onOpenFile}
												replyRunwayPx={
													virtualMessage.index === messages.length - 1
														? message.replyRunwayPx
														: undefined
												}
											/>
										)}
									</div>
								);
							})}
						</div>
					) : (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							{messages.map((message, index) => (
								<div
									key={message.id}
									ref={(node) => {
										if (node) roundRefs.current.set(message.id, node);
										else roundRefs.current.delete(message.id);
									}}
								>
									{message.role === "user" ? (
										<UserMessage message={message} />
									) : (
										<AssistantMessage
											message={message}
											onOpenFile={onOpenFile}
											replyRunwayPx={
												index === messages.length - 1
													? message.replyRunwayPx
													: undefined
											}
										/>
									)}
								</div>
							))}
						</div>
					)}
				</div>

				{isScrolledFromTop ? (
					<div className="pointer-events-none absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-background to-transparent" />
				) : null}

				<ConversationOutlineRail
					entries={outlineEntries}
					activeIndex={activeOutlineIndex}
					onJumpToRound={handleOutlineJump}
				/>

				{/* -mt-4 让滚动区底部上探 16px，消息在输入卡背后被自然裁切；
				    裁切线藏在卡片圆角(12px)以内，输入框下方缝隙不会露出消息 */}
				<div className="relative -mt-4 w-full shrink-0 pb-4 pr-2">
					<ConversationColumn className="relative">
						{!isSticky && messages.length > 0 ? (
							<div className="absolute -top-10 right-3 sm:right-4">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="secondary"
											size="icon"
											className="size-8 rounded-full border border-border/70 shadow-lg transition-[scale] duration-100 active:scale-[0.96]"
											onClick={() => scrollToBottom(true)}
											aria-label="滚动到最新消息"
										>
											<ArrowDown className="size-4" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>滚动到最新消息</TooltipContent>
								</Tooltip>
							</div>
						) : null}
						<ChatComposer
							value={draft}
							onChange={setDraft}
							onSubmit={handleSubmit}
							onSteer={activeTurnGeneration === null ? undefined : handleSteer}
							onFollowUp={
								activeTurnGeneration === null ? undefined : handleFollowUp
							}
							disabled={
								(runtimeBusy && !running) ||
								effectiveLoadState !== "ready" ||
								historyPending
							}
							running={running}
							onStop={handleStop}
							pendingSteering={pendingSteering}
							pendingFollowUps={pendingFollowUps}
							statusText={historyProgress || sessionUsageText}
							models={modelOptions}
							selectedModel={selectedModel}
							modelLoading={modelLoadState === "loading"}
							modelError={modelError}
							modelDisabled={modelChanging || runtimeBusy || historyPending}
							onModelMenuOpen={() => void loadModelOptions()}
							onModelChange={handleModelChange}
							thinkingLevels={thinkingLevels}
							selectedThinkingLevel={selectedThinkingLevel}
							thinkingLoading={thinkingLoading}
							thinkingDisabled={
								thinkingChanging || runtimeBusy || historyPending
							}
							onThinkingMenuOpen={() => void loadThinkingLevels()}
							onThinkingChange={handleThinkingChange}
						/>
					</ConversationColumn>
				</div>
			</div>
		</div>
	);
}

function chatPagePropsEqual(previous: ChatPageProps, next: ChatPageProps) {
	const previousActive = previous.active ?? true;
	const nextActive = next.active ?? true;

	// Keep inactive conversations mounted so their controller/local state survives,
	// but do not let unrelated App updates execute the entire ChatPage function.
	// React compares again when active changes, so reopening uses the latest props.
	if (!previousActive && !nextActive) return true;

	return false;
}

export const ChatPage = memo(ChatPageImpl, chatPagePropsEqual);

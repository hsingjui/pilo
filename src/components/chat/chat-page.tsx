import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Copy, PanelLeft, PanelRight } from "lucide-react";

import {
	AssistantActivityView,
	type AssistantActivity,
} from "@/components/chat/chat-activity";
import { ChatAgentActivityIndicator } from "@/components/chat/chat-agent-activity";
import {
	appendAssistantTextContent,
	appendAssistantThinkingContent,
	finishAssistantThinkingContent,
	getAssistantActivities,
	getAssistantStreamingLabel,
	reconcileAssistantTextContent,
	startAssistantThinkingContent,
	upsertToolContent,
	type AssistantContentItem,
} from "@/lib/chat-activity-state";
import { getReplyRunwayHeight } from "@/lib/chat-scroll-state";
import {
	getOutlineIndexForMessageIndex,
	shouldVirtualizeChatMessages,
} from "@/lib/chat-virtualization";
import { formatWorkDuration } from "@/lib/format-duration";
import { ChatComposer } from "@/components/chat/chat-composer";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { ConversationOutlineRail } from "@/components/chat/conversation-outline-rail";
import { buildConversationOutline } from "@/lib/conversation-outline";
import {
	abortPiReply,
	ensureLocalPi,
	listenRuntimeEvents,
	runtimeErrorMessage,
	sendPiPrompt,
	type PiloRuntimeEvent,
} from "@/lib/pi-runtime";
import { cn } from "@/lib/utils";
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
	workspace: string;
	workspacePath: string;
	environment: string;
	branch: string;
};

type ChatMessage =
	| { id: string; role: "user"; text: string; time: string }
	| {
			id: string;
			role: "assistant";
			text: string;
			time: string;
			content?: AssistantContentItem[];
			activity?: AssistantActivity[];
			streaming?: boolean;
			workDurationMs?: number;
			replyRunwayPx?: number;
			stopReason?: string;
			errorMessage?: string;
	  };

type AssistantChatMessage = Extract<ChatMessage, { role: "assistant" }>;

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
			text: "Connection 只描述运行位置，PiSession 管进程生命周期和 RPC；Local / WSL / SSH 各自负责把连接和 workspace 转成 `ProcessSpec`。这样 Runtime 不需要知道具体 transport。",
			time: "09:44",
			activity: ["connection.rs", "pi_session.rs", "process.rs"].map(
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
					className="size-6 rounded-md text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100"
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

function UserMessage({
	message,
}: {
	message: Extract<ChatMessage, { role: "user" }>;
}) {
	return (
		<ConversationColumn className="py-3 sm:py-4">
			<div className="flex w-full justify-end">
				<div className="group flex min-w-0 max-w-[80%] flex-col items-end gap-1.5 sm:max-w-[70%]">
					<div className="text-[11px] tabular-nums text-muted-foreground">
						{message.time}
					</div>
					<div className="flex min-w-0 max-w-full items-end gap-1">
						<MessageAction
							label="复制"
							onClick={() => void navigator.clipboard.writeText(message.text)}
						>
							<Copy className="size-3.5" />
						</MessageAction>
						<div className="min-w-0 max-w-full rounded-[1.15rem] border border-foreground/[0.08] bg-foreground/[0.05] px-3.5 py-2 text-sm leading-6 text-foreground sm:rounded-2xl sm:px-4 sm:py-2.5">
							<p className="whitespace-pre-wrap [overflow-wrap:anywhere]">
								{message.text}
							</p>
						</div>
					</div>
				</div>
			</div>
		</ConversationColumn>
	);
}

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

function AssistantMessage({
	message,
	replyRunwayPx,
}: {
	message: Extract<ChatMessage, { role: "assistant" }>;
	replyRunwayPx?: number;
}) {
	const content = getAssistantMessageContent(message);
	const activity = getAssistantActivities(content);
	const streamingLabel = getAssistantStreamingLabel({
		text: message.text,
		activity,
		streaming: message.streaming,
	});
	const hasWorkActivity = activity.length > 0;
	const footerDuration =
		!hasWorkActivity && message.workDurationMs !== undefined
			? formatWorkDuration(message.workDurationMs)
			: "";
	const contentNodes: ReactNode[] = [];
	let firstActivityGroup = true;

	for (let index = 0; index < content.length; index += 1) {
		const item = content[index];
		if (item.type === "text") {
			if (item.text) {
				contentNodes.push(
					<ChatMarkdown
						key={item.id}
						text={item.text}
						isStreaming={
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
			/>,
		);
		firstActivityGroup = false;
	}

	return (
		<ConversationColumn className="group py-3 sm:py-4">
			<div
				className="w-full text-foreground"
				style={
					replyRunwayPx === undefined
						? undefined
						: { minHeight: `${replyRunwayPx}px` }
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
					<div className="mt-1.5 flex h-6 items-center gap-1 text-[11px] text-muted-foreground">
						{streamingLabel ? (
							<ChatAgentActivityIndicator label={streamingLabel} />
						) : message.errorMessage ? (
							<span className="text-destructive">Pi 响应失败</span>
						) : message.stopReason === "aborted" ? (
							<span>已停止</span>
						) : footerDuration ? (
							<>
								<span>工作了 {footerDuration}</span>
								<span aria-hidden="true">·</span>
								<span className="tabular-nums">{message.time}</span>
							</>
						) : (
							<span className="tabular-nums">{message.time}</span>
						)}
						{message.text && !message.streaming ? (
							<MessageAction
								label="复制"
								onClick={() => void navigator.clipboard.writeText(message.text)}
							>
								<Copy className="size-3.5" />
							</MessageAction>
						) : null}
					</div>
				</div>
			</div>
		</ConversationColumn>
	);
}

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
	onOpenChanges,
	onExpandSidebar,
	reserveWindowControls = false,
	sidebarCollapsed = false,
}: {
	session: ChatSession;
	onOpenChanges?: () => void;
	onExpandSidebar?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
}) {
	return (
		<header
			data-tauri-drag-region="deep"
			className={cn(
				"flex h-10 shrink-0 items-center gap-2 px-3",
				reserveWindowControls && "pr-[7.75rem]",
			)}
		>
			{sidebarCollapsed && (
				<Button
					variant="ghost"
					size="icon"
					className="size-7 shrink-0"
					aria-label="展开侧边栏"
					onClick={onExpandSidebar}
				>
					<PanelLeft className="size-4" />
				</Button>
			)}
			<svg
				viewBox="0 0 800 800"
				className="size-5 shrink-0 text-muted-foreground"
				aria-hidden="true"
			>
				<path
					className="fill-current"
					fillRule="evenodd"
					d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
				/>
				<path className="fill-current" d="M517.36 400H634.72V634.72H517.36Z" />
			</svg>
			<h1 className="min-w-0 flex-1 truncate text-sm font-medium">
				{session.title}
			</h1>
			<div className="flex shrink-0 items-center gap-0.5">
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

function formatTime() {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date());
}

type ActiveTurn = {
	sessionId: string;
	generation: number | null;
	assistantMessageId: string;
	startedAtMs: number;
	replyRunwayPx?: number;
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

function finishActivityItem(activity: AssistantActivity): AssistantActivity {
	return activity.status === "running"
		? { ...activity, status: "complete" }
		: activity;
}

function finishAssistantContentItem(
	item: AssistantContentItem,
): AssistantContentItem {
	return item.type === "text" ? item : finishActivityItem(item);
}

export function ChatPage({
	session,
	onOpenChanges,
	onExpandSidebar,
	initialMessage,
	loadState = "ready",
	onRetry,
	reserveWindowControls = false,
	sidebarCollapsed = false,
}: {
	session: ChatSession;
	onOpenChanges?: () => void;
	onExpandSidebar?: () => void;
	initialMessage?: string;
	loadState?: "ready" | "loading" | "error";
	onRetry?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
}) {
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
		return MOCK_CONVERSATIONS[session.id] ?? EMPTY_MESSAGES;
	}, [initialMessage, session.id]);
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const [localMessages, setLocalMessages] = useState<
		Record<string, ChatMessage[]>
	>({});
	const activeTurnRef = useRef<ActiveTurn | null>(null);
	const runtimeListenerRef = useRef<ReturnType<
		typeof listenRuntimeEvents
	> | null>(null);
	const runtimeEventHandlerRef = useRef<(event: PiloRuntimeEvent) => void>(
		() => {},
	);
	const sentInitialPromptsRef = useRef(new Set<string>());
	const [activeTurnSessionId, setActiveTurnSessionId] = useState<string | null>(
		null,
	);
	const localSessionMessages = localMessages[session.id] ?? EMPTY_MESSAGES;
	const messages = useMemo(
		() => [...baseMessages, ...localSessionMessages],
		[baseMessages, localSessionMessages],
	);
	const outlineEntries = useMemo(
		() => buildConversationOutline(messages),
		[messages],
	);
	const draft = drafts[session.id] ?? "";
	const setDraft = (value: string) => {
		setDrafts((current) => ({ ...current, [session.id]: value }));
	};

	const scrollRef = useRef<HTMLDivElement>(null);
	const roundRefs = useRef(new Map<string, HTMLDivElement>());
	const messagesRef = useRef(messages);
	messagesRef.current = messages;
	const virtualPadding = useChatVirtualPadding();
	const virtualized =
		loadState === "ready" && shouldVirtualizeChatMessages(messages.length);
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
		enabled: virtualized,
	});
	const stickyRef = useRef(true);
	const [isSticky, setIsSticky] = useState(true);
	const [isScrolledFromTop, setIsScrolledFromTop] = useState(false);
	const [activeOutlineIndex, setActiveOutlineIndex] = useState(
		outlineEntries.length ? outlineEntries.length - 1 : -1,
	);

	const syncScrollState = useCallback(() => {
		const viewport = scrollRef.current;
		if (!viewport) return;
		const distanceFromBottom =
			viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
		const nextSticky = distanceFromBottom <= 72;
		stickyRef.current = nextSticky;
		setIsSticky(nextSticky);
		setIsScrolledFromTop(viewport.scrollTop > 16);

		if (outlineEntries.length === 0) {
			setActiveOutlineIndex(-1);
			return;
		}
		if (distanceFromBottom <= 2) {
			setActiveOutlineIndex(outlineEntries.length - 1);
			return;
		}
		const readingLine = viewport.scrollTop + 72;
		if (virtualized) {
			const readingItem =
				messageVirtualizer.getVirtualItemForOffset(readingLine);
			setActiveOutlineIndex(
				getOutlineIndexForMessageIndex(outlineEntries, readingItem?.index ?? 0),
			);
			return;
		}

		let nextIndex = 0;
		for (let index = 0; index < outlineEntries.length; index += 1) {
			const row = roundRefs.current.get(outlineEntries[index].key);
			if (!row || row.offsetTop > readingLine) break;
			nextIndex = index;
		}
		setActiveOutlineIndex(nextIndex);
	}, [messageVirtualizer, outlineEntries, virtualized]);

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

	const appendLocalMessage = useCallback(
		(targetSessionId: string, message: ChatMessage) => {
			setLocalMessages((current) => ({
				...current,
				[targetSessionId]: [
					...(current[targetSessionId] ?? EMPTY_MESSAGES),
					message,
				],
			}));
		},
		[],
	);

	const startAssistantMessage = useCallback((turn: ActiveTurn) => {
		setLocalMessages((current) => {
			const sessionMessages = current[turn.sessionId] ?? EMPTY_MESSAGES;
			if (
				sessionMessages.some(
					(message) => message.id === turn.assistantMessageId,
				)
			) {
				return current;
			}
			return {
				...current,
				[turn.sessionId]: [
					...sessionMessages,
					{
						id: turn.assistantMessageId,
						role: "assistant",
						text: "",
						time: formatTime(),
						streaming: true,
						replyRunwayPx: turn.replyRunwayPx,
					},
				],
			};
		});
	}, []);

	const reconcileAssistantText = useCallback(
		(turn: ActiveTurn, text: string) => {
			const contentId = createLocalContentId("text");
			setLocalMessages((current) => {
				const sessionMessages = current[turn.sessionId] ?? EMPTY_MESSAGES;
				const index = sessionMessages.findIndex(
					(message) => message.id === turn.assistantMessageId,
				);
				if (index < 0) {
					return {
						...current,
						[turn.sessionId]: [
							...sessionMessages,
							{
								id: turn.assistantMessageId,
								role: "assistant",
								text,
								time: formatTime(),
								content: reconcileAssistantTextContent(
									[],
									text,
									() => contentId,
								),
								streaming: true,
								replyRunwayPx: turn.replyRunwayPx,
							},
						],
					};
				}

				const message = sessionMessages[index];
				if (message.role !== "assistant") return current;
				const content = reconcileAssistantTextContent(
					message.content,
					text,
					() => contentId,
				);
				if (message.text === text && content === message.content)
					return current;
				const nextMessages = [...sessionMessages];
				nextMessages[index] = { ...message, text, content, streaming: true };
				return { ...current, [turn.sessionId]: nextMessages };
			});
		},
		[],
	);

	const appendAssistantDelta = useCallback(
		(turn: ActiveTurn, delta: string) => {
			if (!delta) return;
			const contentId = createLocalContentId("text");
			setLocalMessages((current) => {
				const sessionMessages = current[turn.sessionId] ?? EMPTY_MESSAGES;
				const index = sessionMessages.findIndex(
					(message) => message.id === turn.assistantMessageId,
				);
				if (index < 0) {
					return {
						...current,
						[turn.sessionId]: [
							...sessionMessages,
							{
								id: turn.assistantMessageId,
								role: "assistant",
								text: delta,
								time: formatTime(),
								content: appendAssistantTextContent([], delta, () => contentId),
								streaming: true,
								replyRunwayPx: turn.replyRunwayPx,
							},
						],
					};
				}

				const message = sessionMessages[index];
				if (message.role !== "assistant") return current;
				const nextMessages = [...sessionMessages];
				nextMessages[index] = {
					...message,
					text: `${message.text}${delta}`,
					content: appendAssistantTextContent(
						message.content,
						delta,
						() => contentId,
					),
					streaming: true,
				};
				return { ...current, [turn.sessionId]: nextMessages };
			});
		},
		[],
	);

	const updateAssistantContent = useCallback(
		(
			turn: ActiveTurn,
			update: (content: AssistantContentItem[]) => AssistantContentItem[],
		) => {
			setLocalMessages((current) => {
				const sessionMessages = current[turn.sessionId] ?? EMPTY_MESSAGES;
				const index = sessionMessages.findIndex(
					(message) => message.id === turn.assistantMessageId,
				);
				if (index < 0) {
					const message: AssistantChatMessage = {
						id: turn.assistantMessageId,
						role: "assistant",
						text: "",
						time: formatTime(),
						content: update([]),
						streaming: true,
						replyRunwayPx: turn.replyRunwayPx,
					};
					return {
						...current,
						[turn.sessionId]: [...sessionMessages, message],
					};
				}

				const message = sessionMessages[index];
				if (message.role !== "assistant") return current;
				const nextMessages = [...sessionMessages];
				nextMessages[index] = {
					...message,
					content: update(message.content ?? []),
					streaming: true,
				};
				return { ...current, [turn.sessionId]: nextMessages };
			});
		},
		[],
	);

	const startAssistantThinking = useCallback(
		(turn: ActiveTurn) => {
			const contentId = createLocalContentId("thinking");
			updateAssistantContent(turn, (content) =>
				startAssistantThinkingContent(content, () => contentId),
			);
		},
		[updateAssistantContent],
	);

	const appendAssistantThinkingDelta = useCallback(
		(turn: ActiveTurn, delta: string) => {
			if (!delta) return;
			const contentId = createLocalContentId("thinking");
			updateAssistantContent(turn, (content) =>
				appendAssistantThinkingContent(content, delta, () => contentId),
			);
		},
		[updateAssistantContent],
	);

	const finishAssistantThinking = useCallback(
		(turn: ActiveTurn) => {
			updateAssistantContent(turn, finishAssistantThinkingContent);
		},
		[updateAssistantContent],
	);

	const startToolExecution = useCallback(
		(turn: ActiveTurn, toolCallId: string, toolName: string, args: unknown) => {
			updateAssistantContent(turn, (activity) =>
				upsertToolContent(
					activity,
					toolCallId,
					() => ({
						id: toolCallId,
						type: "tool",
						toolName,
						args,
						status: "running",
					}),
					(current) => ({
						...current,
						toolName,
						args,
						status: "running",
						isError: false,
					}),
				),
			);
		},
		[updateAssistantContent],
	);

	const updateToolExecution = useCallback(
		(
			turn: ActiveTurn,
			toolCallId: string,
			toolName: string,
			args: unknown,
			partialResult: unknown,
		) => {
			updateAssistantContent(turn, (activity) =>
				upsertToolContent(
					activity,
					toolCallId,
					() => ({
						id: toolCallId,
						type: "tool",
						toolName,
						args,
						result: partialResult,
						status: "running",
					}),
					(current) => ({
						...current,
						toolName,
						args,
						result: partialResult,
						status: "running",
					}),
				),
			);
		},
		[updateAssistantContent],
	);

	const finishToolExecution = useCallback(
		(
			turn: ActiveTurn,
			toolCallId: string,
			toolName: string,
			result: unknown,
			isError: boolean,
		) => {
			updateAssistantContent(turn, (activity) =>
				upsertToolContent(
					activity,
					toolCallId,
					() => ({
						id: toolCallId,
						type: "tool",
						toolName,
						result,
						status: "complete",
						isError,
					}),
					(current) => ({
						...current,
						toolName,
						result,
						status: "complete",
						isError,
					}),
				),
			);
		},
		[updateAssistantContent],
	);

	const finishAssistantMessage = useCallback(
		(
			turn: ActiveTurn,
			stopReason?: string | null,
			errorMessage?: string | null,
		) => {
			const workDurationMs = Math.max(0, Date.now() - turn.startedAtMs);
			const visibleError =
				stopReason === "aborted"
					? undefined
					: errorMessage?.trim() ||
						(stopReason === "error" ? "Pi 返回了错误结果。" : undefined);
			setLocalMessages((current) => {
				const sessionMessages = current[turn.sessionId] ?? EMPTY_MESSAGES;
				const index = sessionMessages.findIndex(
					(message) => message.id === turn.assistantMessageId,
				);
				if (index < 0) {
					if (!visibleError) return current;
					return {
						...current,
						[turn.sessionId]: [
							...sessionMessages,
							{
								id: turn.assistantMessageId,
								role: "assistant",
								text: "",
								time: formatTime(),
								streaming: false,
								workDurationMs,
								stopReason: stopReason ?? undefined,
								errorMessage: visibleError,
							},
						],
					};
				}

				const message = sessionMessages[index];
				if (message.role !== "assistant") return current;
				const nextMessages = [...sessionMessages];
				nextMessages[index] = {
					...message,
					content: message.content?.map(finishAssistantContentItem),
					activity: message.activity?.map(finishActivityItem),
					streaming: false,
					workDurationMs,
					stopReason: stopReason ?? undefined,
					errorMessage: visibleError,
				};
				return { ...current, [turn.sessionId]: nextMessages };
			});
		},
		[],
	);

	const releaseActiveTurn = useCallback((turn: ActiveTurn) => {
		if (activeTurnRef.current !== turn) return;
		activeTurnRef.current = null;
		setActiveTurnSessionId(null);
	}, []);

	const failActiveTurn = useCallback(
		(turn: ActiveTurn, message: string) => {
			if (activeTurnRef.current !== turn) return;
			finishAssistantMessage(turn, "error", message);
			releaseActiveTurn(turn);
		},
		[finishAssistantMessage, releaseActiveTurn],
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

			switch (event.type) {
				case "rpc_message":
					break;
				case "assistant_message_start":
					startAssistantMessage(turn);
					break;
				case "assistant_text_delta":
					appendAssistantDelta(turn, event.delta);
					break;
				case "assistant_text_snapshot":
					reconcileAssistantText(turn, event.text);
					break;
				case "assistant_thinking_start":
					startAssistantThinking(turn);
					break;
				case "assistant_thinking_delta":
					appendAssistantThinkingDelta(turn, event.delta);
					break;
				case "assistant_thinking_end":
					finishAssistantThinking(turn);
					break;
				case "tool_execution_start":
					startToolExecution(
						turn,
						event.toolCallId,
						event.toolName,
						event.args,
					);
					break;
				case "tool_execution_update":
					updateToolExecution(
						turn,
						event.toolCallId,
						event.toolName,
						event.args,
						event.partialResult,
					);
					break;
				case "tool_execution_end":
					finishToolExecution(
						turn,
						event.toolCallId,
						event.toolName,
						event.result,
						event.isError,
					);
					break;
				case "assistant_message_end":
					finishAssistantMessage(turn, event.stopReason, event.errorMessage);
					releaseActiveTurn(turn);
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
				case "runtime_log":
					break;
			}
		},
		[
			appendAssistantDelta,
			appendAssistantThinkingDelta,
			failActiveTurn,
			finishAssistantMessage,
			finishAssistantThinking,
			finishToolExecution,
			reconcileAssistantText,
			releaseActiveTurn,
			startAssistantMessage,
			startAssistantThinking,
			startToolExecution,
			updateToolExecution,
		],
	);
	useEffect(() => {
		runtimeEventHandlerRef.current = handleRuntimeEvent;
	}, [handleRuntimeEvent]);

	useEffect(() => {
		let disposed = false;
		const subscription = listenRuntimeEvents((event) => {
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
	}, [failActiveTurn]);

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
				generation: null,
				assistantMessageId: createLocalMessageId("assistant"),
				startedAtMs: Date.now(),
				replyRunwayPx,
			};
			activeTurnRef.current = turn;
			setActiveTurnSessionId(turn.sessionId);

			if (appendUserMessage) {
				appendLocalMessage(turn.sessionId, {
					id: createLocalMessageId("user"),
					role: "user",
					text: trimmed,
					time: formatTime(),
				});
			}
			startAssistantMessage(turn);
			setDrafts((current) => ({ ...current, [turn.sessionId]: "" }));
			requestAnimationFrame(() => scrollToBottom(false));

			try {
				const subscription = runtimeListenerRef.current;
				if (!subscription) {
					throw new Error("Pi Runtime 事件通道尚未就绪。");
				}
				await subscription;
				const snapshot = await ensureLocalPi(session.workspacePath);
				if (activeTurnRef.current !== turn) return;
				turn.generation = snapshot.generation;
				await sendPiPrompt(trimmed);
			} catch (error) {
				failActiveTurn(turn, runtimeErrorMessage(error));
			}
		},
		[
			appendLocalMessage,
			failActiveTurn,
			scrollToBottom,
			session.id,
			session.workspacePath,
			startAssistantMessage,
		],
	);

	const handleSubmit = useCallback(
		(text: string) => {
			void beginTurn(text);
		},
		[beginTurn],
	);

	const handleStop = useCallback(() => {
		const turn = activeTurnRef.current;
		if (!turn || turn.sessionId !== session.id) return;
		if (turn.generation === null) {
			finishAssistantMessage(turn, "aborted");
			releaseActiveTurn(turn);
			return;
		}
		void abortPiReply().catch((error) => {
			failActiveTurn(turn, runtimeErrorMessage(error));
		});
	}, [failActiveTurn, finishAssistantMessage, releaseActiveTurn, session.id]);

	useEffect(() => {
		if (!initialMessage || activeTurnSessionId !== null) return;
		const key = `${session.id}:${initialMessage}`;
		if (sentInitialPromptsRef.current.has(key)) return;
		sentInitialPromptsRef.current.add(key);
		void beginTurn(initialMessage, false);
	}, [activeTurnSessionId, beginTurn, initialMessage, session.id]);

	const sessionId = session.id;
	useEffect(() => {
		if (!sessionId) return;
		stickyRef.current = true;
		const frame = requestAnimationFrame(() => scrollToBottom(false));
		return () => cancelAnimationFrame(frame);
	}, [sessionId, scrollToBottom]);

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

	const handleOutlineJump = (index: number) => {
		const entry = outlineEntries[index];
		const viewport = scrollRef.current;
		if (!entry || !viewport) return;
		stickyRef.current = false;
		setIsSticky(false);
		setActiveOutlineIndex(index);

		if (virtualized) {
			messageVirtualizer.scrollToIndex(entry.messageIndex, { align: "start" });
			return;
		}

		const row = roundRefs.current.get(entry.key);
		if (!row) return;
		viewport.scrollTo({
			top: Math.max(0, row.offsetTop - CHAT_VIRTUAL_SCROLL_PADDING_PX),
			behavior: "smooth",
		});
	};

	const running = activeTurnSessionId === session.id;
	const runtimeBusy = activeTurnSessionId !== null;

	return (
		<div className="flex h-full min-w-0 flex-col bg-background">
			<SessionHeader
				session={session}
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
					{loadState === "loading" ? (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							<ConversationColumn className="flex flex-1 items-center justify-center">
								<LoadingState
									title="正在加载会话"
									description="正在读取消息与活动记录。"
								/>
							</ConversationColumn>
						</div>
					) : loadState === "error" ? (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							<ConversationColumn className="flex flex-1 items-center justify-center">
								<ErrorState
									title="会话加载失败"
									description="暂时无法读取这段会话。"
									onRetry={onRetry}
								/>
							</ConversationColumn>
						</div>
					) : messages.length === 0 ? (
						<div className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6">
							<EmptyConversation />
						</div>
					) : virtualized ? (
						<div
							className="relative min-h-full"
							style={{ height: `${messageVirtualizer.getTotalSize()}px` }}
						>
							{messageVirtualizer.getVirtualItems().map((virtualMessage) => {
								const message = messages[virtualMessage.index];
								if (!message) return null;
								return (
									<div
										key={virtualMessage.key}
										data-index={virtualMessage.index}
										ref={(node) => {
											messageVirtualizer.measureElement(node);
											if (node) roundRefs.current.set(message.id, node);
											else roundRefs.current.delete(message.id);
										}}
										className="absolute left-0 top-0 w-full"
										style={{
											transform: `translateY(${virtualMessage.start}px)`,
										}}
									>
										{message.role === "user" ? (
											<UserMessage message={message} />
										) : (
											<AssistantMessage
												message={message}
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
							disabled={runtimeBusy && !running}
							running={running}
							onStop={handleStop}
						/>
					</ConversationColumn>
				</div>
			</div>
		</div>
	);
}

import { useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import {
	Ban,
	ChevronDown,
	ChevronUp,
	Circle,
	CircleCheck,
	CircleDot,
	ListTodo,
	X,
} from "lucide-react";

import type { ChatConversationStore } from "@/components/chat/chat-conversation-store";
import type { ChatMessage } from "@/lib/chat/conversation-types";
import {
	latestTurnChatTodos,
	type ChatTodoItem,
	type ChatTodoStatus,
} from "@/lib/chat/chat-todos";
import { cn } from "@/lib/utils";
import { Button } from "@/ui";

const STATUS_ICONS = {
	pending: Circle,
	in_progress: CircleDot,
	completed: CircleCheck,
	cancelled: Ban,
} as const;

const STATUS_ICON_CLASS: Record<ChatTodoStatus, string> = {
	pending: "text-muted-foreground",
	in_progress: "text-foreground",
	completed: "text-status-success",
	cancelled: "text-muted-foreground",
};

const STATUS_LABEL_KEYS = {
	pending: "chat.todoStatusPending",
	in_progress: "chat.todoStatusInProgress",
	completed: "chat.todoStatusCompleted",
	cancelled: "chat.todoStatusCancelled",
} as const;

function isTodoDone(status: ChatTodoStatus) {
	return status === "completed" || status === "cancelled";
}

/** 待办清单本体；工具行与输入框上方的胶囊共用。 */
export function ChatTodoList({
	items,
	className,
}: {
	items: readonly ChatTodoItem[];
	className?: string;
}) {
	const { t } = useTranslation();
	return (
		<ul className={cn("m-0 flex list-none flex-col gap-1.5 p-0", className)}>
			{items.map((item) => {
				const Icon = STATUS_ICONS[item.status];
				const done = isTodoDone(item.status);
				return (
					<li
						key={item.id}
						className="flex items-start gap-2 text-xs leading-snug"
						title={t(STATUS_LABEL_KEYS[item.status])}
					>
						<Icon
							className={cn(
								"mt-0.5 size-3.5 shrink-0",
								STATUS_ICON_CLASS[item.status],
								item.status === "in_progress" &&
									"animate-pulse motion-reduce:animate-none",
							)}
							aria-hidden="true"
						/>
						<span
							className={cn(
								"min-w-0 flex-1 break-words",
								done && "text-muted-foreground line-through",
							)}
						>
							{item.text}
						</span>
						{item.priority === "high" && !done ? (
							<span className="shrink-0 rounded-full bg-status-danger/15 px-1.5 text-2xs font-semibold text-status-danger">
								!
							</span>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * 输入框上方的待办胶囊：显示当前进度与进行中的那一条，可展开、可关闭。
 *
 * 只认最后一个用户轮里的待办，所以旧会话不会常驻一条历史清单；
 * 全部结束时收起（运行中仍保留，用完成态收尾）。
 */
export function ChatTodoCapsule({
	conversationStore,
	historyMessages,
	running,
	className,
}: {
	conversationStore: ChatConversationStore;
	/** 会话已加载的历史消息（远端是 historyPrefix，桌面是 baseMessages）。 */
	historyMessages: readonly ChatMessage[];
	running: boolean;
	className?: string;
}) {
	const { t } = useTranslation();
	const snapshot = useSyncExternalStore(
		conversationStore.subscribe,
		conversationStore.getSnapshot,
		conversationStore.getSnapshot,
	);
	const progress = useMemo(
		() =>
			latestTurnChatTodos([...historyMessages, ...(snapshot?.messages ?? [])]),
		[historyMessages, snapshot],
	);
	const fingerprint = useMemo(
		() =>
			progress?.items
				.map((item) => `${item.id}:${item.status}:${item.text}`)
				.join("|") ?? "",
		[progress],
	);
	// 关闭状态绑定在"清单指纹"上：清单变了（新任务/进度推进）自然重新出现，
	// 因此不需要额外 effect 去重置，也不会在渲染期同步 setState。
	const [dismissedFingerprint, setDismissedFingerprint] = useState<
		string | null
	>(null);
	const [expanded, setExpanded] = useState(false);
	const dismissed =
		dismissedFingerprint !== null && dismissedFingerprint === fingerprint;
	if (!progress || dismissed || (progress.complete && !running)) return null;

	const { counts, current, complete } = progress;
	const statusIcon = complete ? (
		<CircleCheck
			className="size-4 shrink-0 text-status-success"
			aria-hidden="true"
		/>
	) : counts.inProgress > 0 ? (
		<CircleDot
			className="size-4 shrink-0 animate-pulse text-foreground motion-reduce:animate-none"
			aria-hidden="true"
		/>
	) : (
		<ListTodo
			className="size-4 shrink-0 text-muted-foreground"
			aria-hidden="true"
		/>
	);

	return (
		<div
			data-chat-todo-capsule=""
			className={cn(
				"mb-1 w-full min-w-0 overflow-hidden rounded-xl border bg-muted text-xs",
				complete ? "border-status-success/30" : "border-border/70",
				className,
			)}
		>
			<div className="flex items-center gap-2 py-1 pl-3 pr-1">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1 text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
					aria-expanded={expanded}
					aria-label={t(expanded ? "chat.todoCollapse" : "chat.todoExpand")}
					onClick={() => setExpanded((value) => !value)}
				>
					{statusIcon}
					<span
						className={cn(
							"shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium tabular-nums",
							complete
								? "bg-status-success/15 text-status-success"
								: "bg-background/80 text-muted-foreground",
						)}
					>
						{counts.completed}/{counts.total}
					</span>
					<span
						className={cn(
							"min-w-0 flex-1 truncate font-medium",
							complete ? "text-status-success" : "text-foreground/90",
						)}
					>
						{complete
							? t("chat.todoAllCompleted")
							: (current?.text ?? t("chat.todos"))}
					</span>
					{expanded ? (
						<ChevronDown
							className="size-3.5 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
					) : (
						<ChevronUp
							className="size-3.5 shrink-0 text-muted-foreground"
							aria-hidden="true"
						/>
					)}
				</button>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="text-muted-foreground"
					aria-label={t("chat.todoDismiss")}
					onClick={() => setDismissedFingerprint(fingerprint)}
				>
					<X className="size-3.5" />
				</Button>
			</div>
			{expanded ? (
				<div className="border-t border-border/60 px-3 py-2">
					<ChatTodoList items={progress.items} />
				</div>
			) : null}
		</div>
	);
}

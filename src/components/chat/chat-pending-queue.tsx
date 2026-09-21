import { Pencil, Send } from "lucide-react";

import type { ConversationState } from "@/lib/conversation-types";
import {
	Button,
	Hint,
	NoticeCard,
	NoticeCardHeader,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

type PendingUser = ConversationState["pendingUsers"][number];
type PendingQueueItem = PendingUser & {
	queueKind: "steer" | "follow_up";
};

type ChatPendingQueueProps = {
	items: readonly PendingUser[];
	onEdit?: (item: PendingQueueItem) => void;
	onSendNow?: (item: PendingQueueItem) => void;
};

export function ChatPendingQueue({
	items,
	onEdit,
	onSendNow,
}: ChatPendingQueueProps) {
	const queued = items.filter(
		(item): item is PendingQueueItem => item.queueKind !== undefined,
	);
	if (queued.length === 0) return null;

	return (
		<NoticeCard className="overflow-hidden text-muted-foreground">
			<NoticeCardHeader title="待处理消息" count={queued.length} />
			<div className="max-h-[min(25vh,240px)] divide-y divide-border/30 overflow-y-auto">
				{queued.map((item) => {
					const imageLabel = item.images?.length
						? `${item.images.length} 张图片`
						: "";
					const label = item.text || imageLabel;
					return (
						<div
							key={item.clientMessageId}
							className="flex min-w-0 items-center gap-2 px-3 py-2"
						>
							<span className="shrink-0 text-[11px]">
								{item.queueKind === "steer" ? "调整" : "稍后"}
							</span>
							<Hint label={label}>
								<span className="min-w-0 flex-1 truncate text-foreground/80">
									{label}
								</span>
							</Hint>
							<div className="flex shrink-0 items-center gap-1">
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-7 rounded-md"
											aria-label="取回编辑"
											onClick={() => onEdit?.(item)}
										>
											<Pencil className="size-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>取回编辑</TooltipContent>
								</Tooltip>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-7 rounded-md"
											aria-label="立即发送"
											onClick={() => onSendNow?.(item)}
										>
											<Send className="size-3.5" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>打断当前 Agent 并立即发送</TooltipContent>
								</Tooltip>
							</div>
						</div>
					);
				})}
			</div>
		</NoticeCard>
	);
}

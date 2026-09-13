import type { ConversationState } from "@/lib/conversation-types";

type PendingUser = ConversationState["pendingUsers"][number];
type PendingQueueItem = PendingUser & {
	queueKind: "steer" | "follow_up";
};

export function ChatPendingQueue({ items }: { items: readonly PendingUser[] }) {
	const queued = items.filter(
		(item): item is PendingQueueItem => item.queueKind !== undefined,
	);
	if (queued.length === 0) return null;

	return (
		<div className="mb-1 overflow-hidden rounded-xl border border-border/60 bg-muted/30 text-xs text-muted-foreground">
			<div className="flex items-center justify-between border-b border-border/40 px-3 py-1.5">
				<span className="font-medium text-foreground/80">待处理消息</span>
				<span className="tabular-nums">{queued.length}</span>
			</div>
			<div className="max-h-[min(25vh,240px)] divide-y divide-border/30 overflow-y-auto">
				{queued.map((item) => (
					<div
						key={item.clientMessageId}
						className="flex min-w-0 items-center gap-2 px-3 py-2"
					>
						<span className="shrink-0 text-[11px]">
							{item.queueKind === "steer" ? "调整" : "稍后"}
						</span>
						<span
							className="min-w-0 flex-1 truncate text-foreground/80"
							title={item.text}
						>
							{item.text}
						</span>
					</div>
				))}
			</div>
		</div>
	);
}

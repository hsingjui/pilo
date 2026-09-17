import { memo, useState } from "react";
import { ChevronRight } from "lucide-react";

import { ConversationColumn } from "@/components/chat/chat-conversation-column";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import type { ChatMessage } from "@/lib/conversation-types";
import { cn } from "@/lib/utils";

/**
 * Pi 压缩上下文的标记。Pi 只把摘要写进 Session，被压缩的消息仍留在 JSONL 中，
 * 所以这里只标注压缩点，不隐藏它之前的对话。
 */
export const CompactionMessage = memo(function CompactionMessage({
	message,
}: {
	message: Extract<ChatMessage, { role: "compaction" }>;
}) {
	const [expanded, setExpanded] = useState(false);
	const summary = message.text.trim();
	const label =
		message.tokensBefore === undefined
			? "上下文已压缩"
			: `上下文已压缩 · ${message.tokensBefore.toLocaleString()} tokens`;

	return (
		<ConversationColumn className="py-2">
			<div className="flex items-center gap-3 text-[12px] text-muted-foreground">
				<span aria-hidden="true" className="h-px flex-1 bg-border" />
				<button
					type="button"
					className="inline-flex shrink-0 items-center gap-1 rounded-md px-1 py-0.5 transition-colors hover:text-foreground"
					aria-expanded={expanded}
					disabled={summary.length === 0}
					onClick={() => setExpanded((value) => !value)}
				>
					{summary.length > 0 ? (
						<ChevronRight
							className={cn(
								"size-3.5 shrink-0 transition-transform",
								expanded && "rotate-90",
							)}
						/>
					) : null}
					<span className="font-medium">{label}</span>
					{message.time ? (
						<span className="tabular-nums opacity-70">{message.time}</span>
					) : null}
				</button>
				<span aria-hidden="true" className="h-px flex-1 bg-border" />
			</div>
			{expanded && summary.length > 0 ? (
				<div className="mt-2 rounded-lg border border-foreground/[0.06] bg-foreground/[0.02] px-3 py-2 text-[12.5px] text-muted-foreground">
					<ChatMarkdown text={summary} isStreaming={false} />
				</div>
			) : null}
		</ConversationColumn>
	);
});

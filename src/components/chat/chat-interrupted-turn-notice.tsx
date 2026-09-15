import { TriangleAlert } from "lucide-react";

export function ChatInterruptedTurnNotice() {
	return (
		<output className="mb-1 flex min-w-0 items-start gap-2.5 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs">
			<TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
			<div className="min-w-0 flex-1">
				<div className="font-medium text-foreground/85">上次回复未完成</div>
				<div className="mt-0.5 leading-5 text-muted-foreground">
					Pilo
					已恢复已保存的历史，并将未完成的回复标记为中断。不会自动重放上一轮，可直接继续发送消息。
				</div>
			</div>
		</output>
	);
}

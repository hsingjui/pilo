import { TriangleAlert } from "lucide-react";

import { NoticeCard, NoticeIcon } from "@/ui";

export function ChatInterruptedTurnNotice() {
	return (
		<NoticeCard
			announce="status"
			className="flex items-start gap-2.5 px-3 py-2"
		>
			<NoticeIcon icon={TriangleAlert} tone="warning" />
			<div className="min-w-0 flex-1">
				<div className="font-medium text-foreground/85">上次回复未完成</div>
				<div className="mt-0.5 leading-5 text-muted-foreground">
					Pilo
					已恢复已保存的历史，并将未完成的回复标记为中断。不会自动重放上一轮，可直接继续发送消息。
				</div>
			</div>
		</NoticeCard>
	);
}

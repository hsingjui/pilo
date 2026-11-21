import { TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";

import { NoticeCard, NoticeIcon } from "@/ui";

export function ChatInterruptedTurnNotice() {
	const { t } = useTranslation();
	return (
		<NoticeCard
			announce="status"
			className="flex items-start gap-2.5 px-3 py-2"
		>
			<NoticeIcon icon={TriangleAlert} tone="warning" />
			<div className="min-w-0 flex-1">
				<div className="font-medium text-foreground/85">
					{t("chat.lastReplyIncomplete")}
				</div>
				<div className="mt-0.5 leading-5 text-muted-foreground">
					{t("chat.interruptedDescription")}
				</div>
			</div>
		</NoticeCard>
	);
}

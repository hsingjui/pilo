import { MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";

import { PathMentionBadge } from "@/components/chat/path-mention-badge";
import type { SessionMention } from "@shared/chat/session-mentions";

export function SessionMentionBadge({
	mention,
	compact = false,
}: {
	mention: SessionMention;
	compact?: boolean;
}) {
	const { t } = useTranslation();
	return (
		<PathMentionBadge
			title={mention.title}
			path={mention.path}
			description={mention.projectName}
			icon={MessageSquare}
			label={t("chat.sessionMentionPath", { title: mention.title })}
			compact={compact}
		/>
	);
}

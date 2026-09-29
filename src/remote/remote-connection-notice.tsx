import { useTranslation } from "react-i18next";
import { WifiOff } from "lucide-react";

import { ChatRuntimeRecoveryNotice } from "@/components/chat/chat-runtime-recovery-notice";
import type { ChatRuntimeRecoveryState } from "@/components/chat/chat-runtime-types";
import { NoticeCard, NoticeIcon } from "@/ui";
import type { RemoteConnectionState } from "./remote-connection-state";

export function RemoteConnectionNotice({
	connectionState,
	recoveryState,
	onReconnect,
}: {
	connectionState: RemoteConnectionState;
	recoveryState: ChatRuntimeRecoveryState;
	onReconnect: () => void;
}) {
	const { t } = useTranslation();

	if (connectionState !== "offline") {
		const effectiveRecoveryState: ChatRuntimeRecoveryState =
			connectionState === "reconnecting" && recoveryState.status !== "failed"
				? {
						status: "reconnecting",
						recoverable: true,
						messageKey: "chat.reconnecting",
					}
				: recoveryState;
		return (
			<ChatRuntimeRecoveryNotice
				state={effectiveRecoveryState}
				onReconnect={onReconnect}
			/>
		);
	}

	return (
		<NoticeCard announce="status" ariaLive="polite" className="px-3 py-2">
			<div className="flex min-w-0 items-start gap-2.5">
				<NoticeIcon icon={WifiOff} tone="warning" />
				<div className="min-w-0 flex-1">
					<div className="font-medium text-foreground/85">
						{t("settings.remoteOffline")}
					</div>
					<div className="mt-0.5 break-words leading-5 text-muted-foreground">
						{t("settings.remoteOfflineDescription")}
					</div>
				</div>
			</div>
		</NoticeCard>
	);
}

import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, NoticeCard, NoticeCardHeader, NoticeIcon } from "@/ui";

export type PiExtensionNotification = {
	id: string;
	message: string;
	type: "info" | "warning" | "error";
};

const NOTIFICATION_ICON = {
	error: { icon: CircleAlert, tone: "danger" },
	warning: { icon: TriangleAlert, tone: "warning" },
	info: { icon: Info, tone: "info" },
} as const;

type PiExtensionNotificationsProps = {
	notifications: readonly PiExtensionNotification[];
	onDismiss: (id: string) => void;
};

export function PiExtensionNotifications({
	notifications,
	onDismiss,
}: PiExtensionNotificationsProps) {
	const { t } = useTranslation();
	if (notifications.length === 0) return null;

	return (
		<NoticeCard className="animate-in fade-in-0 overflow-hidden text-muted-foreground">
			{notifications.length > 1 ? (
				<NoticeCardHeader
					title={t("chat.pluginNotifications")}
					count={notifications.length}
				/>
			) : null}
			<div className="divide-y divide-border/30">
				{notifications.map((notification) => (
					<div
						key={notification.id}
						className="flex min-w-0 items-start gap-2.5 px-3 py-2"
						role={notification.type === "error" ? "alert" : "status"}
					>
						<NoticeIcon {...NOTIFICATION_ICON[notification.type]} />
						<span className="min-w-0 flex-1 break-words leading-5 text-foreground/85">
							{notification.message}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="-my-0.5 -mr-1 size-6 shrink-0 rounded-md text-muted-foreground hover:bg-hover hover:text-foreground active:scale-[0.92] transition-[background-color,color,scale] duration-150 ease-out"
							aria-label={t("chat.closePluginNotifications")}
							onClick={() => onDismiss(notification.id)}
						>
							<X className="size-3" />
						</Button>
					</div>
				))}
			</div>
		</NoticeCard>
	);
}

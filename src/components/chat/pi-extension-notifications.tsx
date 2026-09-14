import { CircleAlert, Info, TriangleAlert, X } from "lucide-react";

import { Button } from "@/ui";

export type PiExtensionNotification = {
	id: string;
	message: string;
	type: "info" | "warning" | "error";
};

type PiExtensionNotificationsProps = {
	notifications: readonly PiExtensionNotification[];
	onDismiss: (id: string) => void;
};

function NotificationIcon({ type }: { type: PiExtensionNotification["type"] }) {
	if (type === "error") {
		return (
			<CircleAlert className="mt-0.5 size-3.5 shrink-0 text-status-danger" />
		);
	}
	if (type === "warning") {
		return (
			<TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
		);
	}
	return <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />;
}

export function PiExtensionNotifications({
	notifications,
	onDismiss,
}: PiExtensionNotificationsProps) {
	if (notifications.length === 0) return null;

	return (
		<div
			className="mb-1 overflow-hidden rounded-xl border border-border/60 bg-muted/30 text-xs text-muted-foreground"
			aria-live="polite"
		>
			<div className="divide-y divide-border/30">
				{notifications.map((notification) => (
					<div
						key={notification.id}
						role={notification.type === "error" ? "alert" : "status"}
						className="flex min-w-0 items-start gap-2.5 px-3 py-2"
					>
						<NotificationIcon type={notification.type} />
						<span className="min-w-0 flex-1 break-words leading-5 text-foreground/80">
							{notification.message}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="-my-0.5 -mr-1 size-6 shrink-0 rounded-md text-muted-foreground"
							aria-label="关闭插件通知"
							onClick={() => onDismiss(notification.id)}
						>
							<X className="size-3" />
						</Button>
					</div>
				))}
			</div>
		</div>
	);
}

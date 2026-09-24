import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Send } from "lucide-react";
import { toast } from "sonner";

import {
	ensureDesktopNotificationPermission,
	getDesktopNotificationPermission,
	isDesktopNotificationPermissionSystemManaged,
	sendDesktopNotificationTest,
	type DesktopNotificationPermission,
} from "@/lib/desktop-notifications";
import { usePreferences } from "@/lib/preferences-provider";
import { cn } from "@/lib/utils";
import { Button, Hint, Switch } from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_ICON_BUTTON_CLASS,
	SETTINGS_TEXT_BUTTON_CLASS,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./compact-layout";

const NOTIFICATION_PERMISSION_KEYS: Record<
	DesktopNotificationPermission,
	| "settings.granted"
	| "settings.denied"
	| "settings.notRequested"
	| "settings.unavailable"
> = {
	granted: "settings.granted",
	denied: "settings.denied",
	default: "settings.notRequested",
	unsupported: "settings.unavailable",
};

export function NotificationSettings() {
	const { t } = useTranslation();
	const { desktopNotifications, setDesktopNotifications } = usePreferences();
	const permissionSystemManaged =
		isDesktopNotificationPermissionSystemManaged();
	const [permission, setPermission] = useState<DesktopNotificationPermission>(
		permissionSystemManaged ? "granted" : "default",
	);
	const [checking, setChecking] = useState(!permissionSystemManaged);
	const [testing, setTesting] = useState(false);

	const refreshPermission = async () => {
		setChecking(true);
		const next = await getDesktopNotificationPermission();
		setPermission(next);
		setChecking(false);
		if (next !== "granted" && desktopNotifications)
			setDesktopNotifications(false);
	};

	useEffect(() => {
		if (permissionSystemManaged) return;

		let active = true;
		void getDesktopNotificationPermission().then((next) => {
			if (!active) return;
			setPermission(next);
			setChecking(false);
		});
		return () => {
			active = false;
		};
	}, [permissionSystemManaged]);

	const handleNotificationsChange = async (enabled: boolean) => {
		if (!enabled) {
			setDesktopNotifications(false);
			return;
		}
		const granted = await ensureDesktopNotificationPermission();
		setPermission(await getDesktopNotificationPermission());
		setDesktopNotifications(granted);
		if (!granted) {
			toast.error(t("settings.enableNotificationsFailed"), {
				description: t("settings.allowNotificationsDescription"),
			});
		}
	};

	const handleTestNotification = async () => {
		setTesting(true);
		const sent = await sendDesktopNotificationTest();
		setPermission(await getDesktopNotificationPermission());
		setTesting(false);
		if (!sent)
			toast.error(t("settings.testNotificationFailed"), {
				description: t("settings.checkNotificationPermission"),
			});
	};

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection title={t("settings.systemNotifications")}>
				<SettingsRow label={t("settings.sendDesktopNotifications")}>
					<Switch
						checked={desktopNotifications}
						onCheckedChange={(enabled) =>
							void handleNotificationsChange(enabled)
						}
					/>
				</SettingsRow>

				<SettingsRow label={t("settings.notificationPermission")}>
					<div className="flex items-center gap-1.5">
						<SettingsStatus
							muted={permission !== "granted" && !permissionSystemManaged}
						>
							{checking
								? t("settings.testing")
								: permissionSystemManaged
									? t("settings.systemManaged")
									: t(NOTIFICATION_PERMISSION_KEYS[permission])}
						</SettingsStatus>
						{!permissionSystemManaged ? (
							<Hint
								label={checking ? undefined : t("settings.recheckPermission")}
							>
								<Button
									variant="ghost"
									size="icon"
									className={SETTINGS_ICON_BUTTON_CLASS}
									disabled={checking}
									onClick={() => void refreshPermission()}
								>
									<RefreshCw
										className={cn("size-3.5", checking && "animate-spin")}
									/>
								</Button>
							</Hint>
						) : null}
					</div>
				</SettingsRow>

				<SettingsRow label={t("settings.testNotification")}>
					<Button
						variant="ghost"
						size="sm"
						className={cn(
							SETTINGS_TEXT_BUTTON_CLASS,
							"text-muted-foreground hover:text-foreground",
						)}
						disabled={testing}
						onClick={() => void handleTestNotification()}
					>
						<Send className="size-3.5" />
						{testing
							? t("settings.sending")
							: t("settings.sendTestNotification")}
					</Button>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

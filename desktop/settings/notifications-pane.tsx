import {
	type Accessor,
	Notifications,
	type NotificationPermission,
	signal,
	View,
} from "nsh";

import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection, SettingsStatus } from "./layout";
import type { SettingsClient } from "./settings-dialog";

const PERMISSION_KEYS: Record<
	NotificationPermission,
	| "settings.granted"
	| "settings.denied"
	| "settings.notRequested"
	| "settings.unavailable"
> = {
	granted: "settings.granted",
	denied: "settings.denied",
	default: "settings.notRequested",
	unavailable: "settings.unavailable",
};

/** System notifications: the toggle, the OS permission, and a test send. */
export function NotificationsPane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const permission = signal<NotificationPermission | null>(null);
	const checking = signal(false);
	const testing = signal(false);
	const refresh = () => {
		checking.set(true);
		Notifications.permission()
			.then((next) => permission.set(next))
			.catch(() => permission.set("unavailable"))
			.finally(() => checking.set(false));
	};
	refresh();
	const values = () => props.state().preferences?.values;
	const changeEnabled = (enabled: boolean) => {
		const done = (granted: boolean) => {
			permission.set(granted ? "granted" : (permission() ?? "default"));
			props.client
				.savePreferences({ desktopNotifications: granted && enabled })
				.catch((error: unknown) => {
					console.error(t("settings.preferencesSaveFailed"), error);
				});
		};
		if (!enabled) {
			done(false);
			return;
		}
		Notifications.requestPermission()
			.then((next) => done(next === "granted"))
			.catch(() => done(false));
	};
	const sendTest = () => {
		testing.set(true);
		Notifications.show({
			id: "pilo-settings-test",
			title: t("notifications.testTitle"),
			body: t("notifications.testBody"),
		})
			.catch(() => false)
			.finally(() => testing.set(false));
	};
	return (
		<View class="gap-3">
			<SettingsSection title={t("settings.systemNotifications")}>
				<SettingsRow label={t("settings.sendDesktopNotifications")}>
					{() => (
						<Switch
							testID="settings-desktop-notifications"
							checked={values()?.desktopNotifications ?? false}
							onChange={({ checked }) => changeEnabled(checked)}
						/>
					)}
				</SettingsRow>
				<SettingsRow label={t("settings.notificationPermission")}>
					<View class="flex-row items-center gap-1.5">
						{() => (
							<SettingsStatus muted={permission() !== "granted"}>
								{permission() === null
									? t("settings.testing")
									: t(PERMISSION_KEYS[permission() ?? "unavailable"])}
							</SettingsStatus>
						)}
						<Button
							testID="settings-recheck-permission"
							variant="ghost"
							size="icon"
							accessibilityLabel={t("settings.recheckPermission")}
							disabled={checking()}
							onPress={refresh}
						>
							<Icon name="RefreshCw" size={14} />
						</Button>
					</View>
				</SettingsRow>
				<SettingsRow label={t("settings.testNotification")}>
					<Button
						testID="settings-send-test-notification"
						variant="ghost"
						disabled={testing()}
						onPress={sendTest}
					>
						{() =>
							testing()
								? t("settings.sending")
								: t("settings.sendTestNotification")
						}
					</Button>
				</SettingsRow>
			</SettingsSection>
		</View>
	);
}

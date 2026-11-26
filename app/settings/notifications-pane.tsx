import {
	type Accessor,
	cleanup,
	type NotificationPermission,
	signal,
	Text,
	View,
} from "nsh";

import { userErrorMessage } from "@shared/app-error";
import { AppToaster, showToast } from "../shell/app-toasts";
import {
	defaultDesktopNotifications,
	type DesktopNotificationsApi,
} from "../shell/desktop-notifications";
import type { AppState } from "../state/app-state";
import { t } from "../shell/i18n";
import { Icon } from "../ui/icon";
import { Switch } from "../ui/switch";
import {
	SettingsActionButton,
	SettingsIconButton,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./layout";
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

/**
 * System notifications: the toggle, the OS permission, and a test send, as
 * the WebUI `NotificationSettings`. Its Windows-only "Managed by system"
 * status has no nsh counterpart (the permission is always queryable here).
 */
export function NotificationsPane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
	notifications?: DesktopNotificationsApi;
}) {
	const toasts = AppToaster();
	const notifications = props.notifications ?? defaultDesktopNotifications();
	const permission = signal<NotificationPermission | null>(null);
	const checking = signal(false);
	const testing = signal(false);
	let alive = true;
	cleanup(() => {
		alive = false;
	});
	const values = () => props.state().preferences?.values;
	const save = (patch: {
		desktopNotifications?: boolean;
		showPluginNotifications?: boolean;
	}) => {
		props.client.savePreferences(patch).catch((error: unknown) => {
			console.error(t("settings.preferencesSaveFailed"), error);
			showToast(toasts, {
				variant: "error",
				title: t("settings.preferencesSaveFailed"),
				description: userErrorMessage(error),
			});
		});
	};
	const refresh = () => {
		checking.set(true);
		notifications
			.permission()
			.then((next) => {
				if (!alive) return;
				permission.set(next);
				if (next !== "granted" && values()?.desktopNotifications)
					save({ desktopNotifications: false });
			})
			.catch(() => {
				if (alive) permission.set("unavailable");
			})
			.finally(() => {
				if (alive) checking.set(false);
			});
	};
	refresh();
	const ensurePermission = async () => {
		if (
			(await notifications.permission().catch(() => "unavailable" as const)) ===
			"granted"
		)
			return true;
		return (
			(await notifications
				.requestPermission()
				.catch(() => "denied" as const)) === "granted"
		);
	};
	const changeEnabled = (enabled: boolean) => {
		if (!enabled) {
			save({ desktopNotifications: false });
			return;
		}
		void ensurePermission().then((granted) => {
			if (!alive) return;
			save({ desktopNotifications: granted });
			if (!granted) {
				showToast(toasts, {
					variant: "error",
					title: t("settings.enableNotificationsFailed"),
				});
			}
			refresh();
		});
	};
	const sendTest = () => {
		testing.set(true);
		void ensurePermission()
			.then(async (granted) => {
				if (!granted) return false;
				return notifications
					.show({
						id: "pilo-settings-test",
						title: t("notifications.testTitle"),
						body: t("notifications.testBody"),
						waitForClick: false,
					})
					.catch(() => false);
			})
			.then((sent) => {
				if (alive && !sent)
					showToast(toasts, {
						variant: "error",
						title: t("settings.testNotificationFailed"),
					});
			})
			.finally(() => {
				if (!alive) return;
				testing.set(false);
				refresh();
			});
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
				<SettingsRow
					label={t("settings.notificationPermission")}
					ghostEdge="end"
				>
					<View class="flex-row items-center gap-1.5">
						{() => (
							<SettingsStatus muted={permission() !== "granted"}>
								{checking() || permission() === null
									? t("settings.testing")
									: t(PERMISSION_KEYS[permission() ?? "unavailable"])}
							</SettingsStatus>
						)}
						{() => (
							<SettingsIconButton
								testID="settings-recheck-permission"
								accessibilityLabel={t("settings.recheckPermission")}
								disabled={checking()}
								onPress={refresh}
							>
								<Icon
									name="RefreshCw"
									size={14}
									class={checking() ? "animate-spin" : undefined}
								/>
							</SettingsIconButton>
						)}
					</View>
				</SettingsRow>
				<SettingsRow label={t("settings.testNotification")} ghostEdge="both">
					{() => {
						const perm = permission();
						const disabled =
							testing() ||
							!(values()?.desktopNotifications ?? false) ||
							perm === "denied" ||
							perm === "unavailable";
						return (
							<SettingsActionButton
								testID="settings-send-test-notification"
								disabled={disabled}
								onPress={sendTest}
							>
								<Icon name="Send" size={14} />
								<Text class="font-sans">
									{testing()
										? t("settings.sending")
										: t("settings.sendTestNotification")}
								</Text>
							</SettingsActionButton>
						);
					}}
				</SettingsRow>
			</SettingsSection>
			<SettingsSection title={t("settings.inAppNotifications")}>
				<SettingsRow label={t("settings.pluginNotifications")}>
					{() => (
						<Switch
							testID="settings-plugin-notifications"
							checked={values()?.showPluginNotifications ?? false}
							onChange={(event) =>
								save({ showPluginNotifications: event.checked })
							}
						/>
					)}
				</SettingsRow>
			</SettingsSection>
		</View>
	);
}

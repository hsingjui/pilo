import {
	type Accessor,
	Notifications,
	type NotificationPermission,
	signal,
	Text,
	View,
} from "nsh";

import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Switch } from "../ui/switch";
import {
	SETTINGS_ICON_BUTTON_CLASS,
	SETTINGS_TEXT_BUTTON_CLASS,
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
 * the Tauri `NotificationSettings`. Its Windows-only "Managed by system"
 * status has no nsh counterpart (the permission is always queryable here),
 * and its failure toasts show inline instead.
 */
export function NotificationsPane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const permission = signal<NotificationPermission | null>(null);
	const checking = signal(false);
	const testing = signal(false);
	const failure = signal<
		| "settings.enableNotificationsFailed"
		| "settings.testNotificationFailed"
		| null
	>(null);
	const values = () => props.state().preferences?.values;
	const save = (desktopNotifications: boolean) => {
		props.client
			.savePreferences({ desktopNotifications })
			.catch((error: unknown) => {
				console.error(t("settings.preferencesSaveFailed"), error);
			});
	};
	const refresh = () => {
		checking.set(true);
		Notifications.permission()
			.then((next) => {
				permission.set(next);
				if (next !== "granted" && values()?.desktopNotifications) save(false);
			})
			.catch(() => permission.set("unavailable"))
			.finally(() => checking.set(false));
	};
	refresh();
	const ensurePermission = async () => {
		if (
			(await Notifications.permission().catch(() => "unavailable" as const)) ===
			"granted"
		)
			return true;
		return (
			(await Notifications.requestPermission().catch(
				() => "denied" as const,
			)) === "granted"
		);
	};
	const changeEnabled = (enabled: boolean) => {
		failure.set(null);
		if (!enabled) {
			save(false);
			return;
		}
		void ensurePermission().then((granted) => {
			save(granted);
			if (!granted) {
				failure.set("settings.enableNotificationsFailed");
				void refresh();
			}
		});
	};
	const sendTest = () => {
		failure.set(null);
		testing.set(true);
		void ensurePermission()
			.then(async (granted) => {
				if (!granted) return false;
				return Notifications.show({
					id: "pilo-settings-test",
					title: t("notifications.testTitle"),
					body: t("notifications.testBody"),
				}).catch(() => false);
			})
			.then((sent) => {
				if (!sent) failure.set("settings.testNotificationFailed");
			})
			.finally(() => {
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
							<Button
								testID="settings-recheck-permission"
								variant="ghost"
								size="icon"
								class={SETTINGS_ICON_BUTTON_CLASS}
								accessibilityLabel={t("settings.recheckPermission")}
								disabled={checking()}
								onPress={refresh}
							>
								<Icon
									name="RefreshCw"
									size={14}
									class={checking() ? "animate-spin" : undefined}
								/>
							</Button>
						)}
					</View>
				</SettingsRow>
				<SettingsRow label={t("settings.testNotification")} ghostEdge="both">
					{() => (
						<Button
							testID="settings-send-test-notification"
							variant="ghost"
							class={`${SETTINGS_TEXT_BUTTON_CLASS} text-muted-foreground hover:text-foreground`}
							disabled={testing()}
							onPress={sendTest}
						>
							<Icon name="Send" size={14} />
							<Text class="font-sans">
								{testing()
									? t("settings.sending")
									: t("settings.sendTestNotification")}
							</Text>
						</Button>
					)}
				</SettingsRow>
				{() =>
					failure() ? (
						<Text class="font-sans px-3 py-2 text-xs text-destructive">
							{t(failure() ?? "settings.testNotificationFailed")}
						</Text>
					) : null
				}
			</SettingsSection>
		</View>
	);
}

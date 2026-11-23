import {
	mount,
	type NotificationPermission,
	signal,
	Storage,
	Text,
	View,
} from "nsh";
import { DesktopNotifications } from "app/native";

import type { DesktopNotificationsApi } from "../shell/desktop-notifications";
import { initializeI18n } from "../shell/i18n";
import { NotificationsPane } from "../settings/notifications-pane";
import { AppStore } from "../state/app-store";
import { HOST_DEFAULT_VALUES, scriptedClient } from "./scripted-app-client";

async function run() {
	const mode = (await Storage.getItem("fixture.mode")) ?? "grant-on-request";
	if (mode === "native-probe") {
		mount(() => (
			<Text testID="native-fallback">
				{String(DesktopNotifications.isFallbackAvailable())}
			</Text>
		));
		return;
	}

	let currentPermission: NotificationPermission =
		mode === "send-fails" ? "granted" : "default";
	const shownCount = signal(0);
	const notifications: DesktopNotificationsApi = {
		permission: () => Promise.resolve(currentPermission),
		requestPermission: () => {
			if (mode === "grant-on-request") {
				currentPermission = "granted";
			} else if (mode === "deny-on-request") {
				currentPermission = "denied";
			}
			return Promise.resolve(currentPermission);
		},
		show: async () => {
			if (mode === "send-fails" || currentPermission !== "granted") {
				return false;
			}
			shownCount.update((count) => count + 1);
			return true;
		},
		onPress: () => () => undefined,
	};

	const runtime = scriptedClient({
		preferences: {
			revision: 1,
			values: {
				...HOST_DEFAULT_VALUES,
				desktopNotifications: false,
			},
		},
	});
	const store = new AppStore(runtime.client);
	mount(() => (
		<View class="flex-1 bg-background p-4 gap-3">
			<NotificationsPane
				state={store.state}
				client={runtime.client}
				notifications={notifications}
			/>
			<Text testID="enabled-probe">
				{() =>
					`enabled:${String(
						store.state().preferences?.values.desktopNotifications ?? false,
					)}`
				}
			</Text>
			<Text testID="shown-probe">{() => `shown:${shownCount()}`}</Text>
		</View>
	));
	await store.start();
}

initializeI18n();
void run();

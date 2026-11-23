import { type Accessor, View } from "nsh";

import { userErrorMessage } from "@shared/app-error";
import { isAppLocale } from "@shared/i18n/locale-types";
import type { PreferencePatch } from "@shared/host-preferences-types";
import { AppToaster, showToast } from "../shell/app-toasts";
import type { DesktopShell } from "../shell/desktop-shell";
import type { AppState } from "../state/app-state";
import { t } from "../shell/i18n";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { DesktopStartupSection } from "./desktop-startup-section";
import { SettingsRow, SettingsSection } from "./layout";
import type { SettingsClient } from "./settings-dialog";

export function PreferencesPane(props: {
	state: Accessor<AppState>;
	client: Pick<SettingsClient, "savePreferences">;
	desktop?: DesktopShell;
}) {
	const toasts = AppToaster();
	const values = () => props.state().preferences?.values;
	const save = (patch: PreferencePatch) => {
		void props.client.savePreferences(patch).catch((error: unknown) => {
			console.error(t("settings.preferencesSaveFailed"), error);
			showToast(toasts, {
				variant: "error",
				title: t("settings.preferencesSaveFailed"),
				description: userErrorMessage(error),
			});
		});
	};
	const sendShortcut = (value: string | null) => {
		if (value === "enter" || value === "mod-enter")
			save({ sendMessageShortcut: value });
	};
	const locale = (value: string | null) => {
		if (isAppLocale(value)) save({ locale: value });
	};
	return (
		<View class="gap-3">
			<SettingsSection title={t("settings.conversation")}>
				<SettingsRow label={t("settings.sendShortcut")}>
					<Select
						testID="settings-send-shortcut"
						size="sm"
						class="w-[180px]"
						items={[
							{ value: "enter", title: "Enter" },
							{ value: "mod-enter", title: "Ctrl/⌘ + Enter" },
						]}
						value={values()?.sendMessageShortcut ?? "enter"}
						onChange={(event) => sendShortcut(event.value)}
					/>
				</SettingsRow>
				<SettingsRow label={t("settings.collapseLongMessages")}>
					<Switch
						testID="settings-collapse-long"
						checked={values()?.collapseLongMessages ?? false}
						onChange={(event) => save({ collapseLongMessages: event.checked })}
					/>
				</SettingsRow>
				<SettingsRow label={t("settings.collapseWork")}>
					<Switch
						testID="settings-collapse-work"
						checked={values()?.collapseCompletedActivity ?? false}
						onChange={(event) =>
							save({ collapseCompletedActivity: event.checked })
						}
					/>
				</SettingsRow>
				<SettingsRow label={t("settings.pluginNotifications")}>
					<Switch
						testID="settings-plugin-notifications"
						checked={values()?.showPluginNotifications ?? false}
						onChange={(event) =>
							save({ showPluginNotifications: event.checked })
						}
					/>
				</SettingsRow>
				<SettingsRow label={t("settings.language")}>
					<Select
						testID="settings-language"
						size="sm"
						class="w-[180px]"
						items={[
							{ value: "zh-CN", title: t("settings.languageChinese") },
							{ value: "en-US", title: t("settings.languageEnglish") },
						]}
						value={values()?.locale ?? "en-US"}
						onChange={(event) => locale(event.value)}
					/>
				</SettingsRow>
			</SettingsSection>
			<DesktopStartupSection desktop={props.desktop} />
		</View>
	);
}

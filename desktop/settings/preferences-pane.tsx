import { type Accessor, View } from "nsh";

import { isAppLocale } from "@/i18n/locale-types";
import type { PreferencePatch } from "@/lib/host-preferences-types";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import type { SettingsClient } from "./settings-dialog";
import { SettingsRow, SettingsSection } from "./layout";

/** General preferences: language, send shortcut, conversation folding and plugin notifications. */
export function PreferencesPane(props: {
	state: Accessor<AppState>;
	client: Pick<SettingsClient, "savePreferences">;
}) {
	const values = () => props.state().preferences?.values;
	const save = (patch: PreferencePatch) => {
		void props.client.savePreferences(patch).catch((error: unknown) => {
			console.error(t("settings.preferencesSaveFailed"), error);
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
		</View>
	);
}

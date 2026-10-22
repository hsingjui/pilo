import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { changeAppLocale, isAppLocale } from "@/i18n";
import {
	usePreferences,
	type SendMessageShortcut,
} from "@/lib/preferences-provider";
import { cn } from "@/lib/utils";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	Switch,
} from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_CONTROL_CLASS,
	SettingsRow,
	SettingsSection,
} from "./compact-layout";

import { DesktopSettings } from "./desktop-settings";

export function PreferencesSettings() {
	const { t, i18n } = useTranslation();
	const {
		sendMessageShortcut,
		setSendMessageShortcut,
		collapseCompletedActivity,
		setCollapseCompletedActivity,
		collapseLongMessages,
		setCollapseLongMessages,
		showPluginNotifications,
		setShowPluginNotifications,
		developerMode,
		setDeveloperMode,
	} = usePreferences();

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection title={t("settings.conversation")}>
				<SettingsRow label={t("settings.sendShortcut")}>
					<Select
						value={sendMessageShortcut}
						onValueChange={(value) =>
							setSendMessageShortcut(value as SendMessageShortcut)
						}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[180px]")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="enter">Enter</SelectItem>
							<SelectItem value="mod-enter">Ctrl/⌘ + Enter</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
				<SettingsRow label={t("settings.collapseLongMessages")}>
					<Switch
						checked={collapseLongMessages}
						onCheckedChange={setCollapseLongMessages}
					/>
				</SettingsRow>
				<SettingsRow label={t("settings.collapseWork")}>
					<Switch
						checked={collapseCompletedActivity}
						onCheckedChange={setCollapseCompletedActivity}
					/>
				</SettingsRow>
				<SettingsRow label={t("settings.pluginNotifications")}>
					<Switch
						aria-label={t("settings.pluginNotifications")}
						checked={showPluginNotifications}
						onCheckedChange={setShowPluginNotifications}
					/>
				</SettingsRow>
				<SettingsRow label={t("settings.language")}>
					<Select
						value={i18n.language === "zh-CN" ? "zh-CN" : "en-US"}
						onValueChange={(value) => {
							if (isAppLocale(value))
								void changeAppLocale(value).catch((error: unknown) =>
									toast.error(t("settings.preferencesSaveFailed"), {
										description: String(error),
									}),
								);
						}}
					>
						<SelectTrigger className={cn(SETTINGS_CONTROL_CLASS, "w-[180px]")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="zh-CN">
								{t("settings.languageChinese")}
							</SelectItem>
							<SelectItem value="en-US">
								{t("settings.languageEnglish")}
							</SelectItem>
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsSection>
			<DesktopSettings />
			<SettingsSection title={t("settings.developer")}>
				<SettingsRow
					label={t("settings.developerMode")}
					helper={t("settings.developerModeDescription")}
				>
					<Switch
						aria-label={t("settings.developerMode")}
						checked={developerMode}
						onCheckedChange={setDeveloperMode}
					/>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

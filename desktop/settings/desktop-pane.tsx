import { signal, Text, View } from "nsh";
import { Application } from "nsh/desktop";

import type { DesktopShell } from "../app/desktop-shell";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./layout";

/** Startup integration: launching at login, via nsh's Application module. */
export function DesktopPane(props: { desktop?: DesktopShell }) {
	const enabled = signal<boolean | null>(null);
	const saving = signal(false);
	const startupError = signal<
		"desktop.loadFailed" | "desktop.saveFailed" | null
	>(null);
	const closeFailed = signal(false);
	const load = async () => {
		startupError.set(null);
		try {
			enabled.set(await Application.launchAtLogin());
		} catch {
			startupError.set("desktop.loadFailed");
		}
	};
	void load();
	const change = async (next: boolean) => {
		if (saving()) return;
		saving.set(true);
		startupError.set(null);
		try {
			await Application.setLaunchAtLogin(next);
			enabled.set(await Application.launchAtLogin());
		} catch {
			startupError.set("desktop.saveFailed");
		} finally {
			saving.set(false);
		}
	};
	const changeClose = async (next: boolean) => {
		const desktop = props.desktop;
		if (!desktop || desktop.savingClose()) return;
		closeFailed.set(false);
		try {
			await desktop.saveExitOnClose(next);
		} catch {
			closeFailed.set(true);
		}
	};
	return (
		<View class="gap-3">
			<SettingsSection title={t("desktop.startupAndTray")}>
				<SettingsRow label={t("desktop.autostart")}>
					{() => (
						<Switch
							testID="settings-launch-at-login"
							checked={enabled() ?? false}
							disabled={enabled() === null || saving()}
							onChange={({ checked }) => void change(checked)}
						/>
					)}
				</SettingsRow>
				{() => {
					const error = startupError();
					return error ? (
						<SettingsRow label={t(error)}>
							{enabled() === null ? (
								<Button onPress={() => void load()}>{t("common.retry")}</Button>
							) : null}
						</SettingsRow>
					) : null;
				}}
				{props.desktop ? (
					<SettingsRow label={t("desktop.exitOnClose")}>
						{() => (
							<Switch
								checked={props.desktop?.settings()?.exitOnClose ?? false}
								disabled={
									!props.desktop?.settings() || props.desktop.savingClose()
								}
								onChange={({ checked }) => void changeClose(checked)}
							/>
						)}
					</SettingsRow>
				) : null}
				{() =>
					props.desktop?.loadFailed() ? (
						<SettingsRow label={t("desktop.closeLoadFailed")}>
							<Button onPress={() => void props.desktop?.load()}>
								{t("common.retry")}
							</Button>
						</SettingsRow>
					) : closeFailed() ? (
						<Text class="px-3 py-2 text-xs text-destructive">
							{t("desktop.closeSaveFailed")}
						</Text>
					) : null
				}
			</SettingsSection>
		</View>
	);
}

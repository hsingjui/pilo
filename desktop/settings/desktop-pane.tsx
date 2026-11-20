import { signal, Text, View } from "nsh";
import { Application } from "nsh/desktop";

import type { DesktopShell } from "../app/desktop-shell";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./layout";

/**
 * Startup integration, as the Tauri `DesktopSettings` (a section inside its
 * Preferences pane, a tab of its own here). nsh's `Application` reports
 * launch-at-login as a boolean, so the Tauri version's three-mode select
 * (off / window / tray) shows as a switch.
 */
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
					{() =>
						startupError() === "desktop.loadFailed" ? (
							<View class="flex-row flex-wrap items-center gap-2">
								<Text class="text-xs text-destructive">
									{t("desktop.loadFailed")}
								</Text>
								<Button variant="ghost" size="sm" onPress={() => void load()}>
									{t("common.retry")}
								</Button>
							</View>
						) : (
							<View class="flex-row flex-wrap items-center gap-2">
								<Switch
									testID="settings-launch-at-login"
									checked={enabled() ?? false}
									disabled={enabled() === null || saving()}
									onChange={({ checked }) => void change(checked)}
								/>
								{startupError() === "desktop.saveFailed" ? (
									<Text class="text-xs text-destructive">
										{t("desktop.saveFailed")}
									</Text>
								) : null}
							</View>
						)
					}
				</SettingsRow>
				{props.desktop ? (
					<SettingsRow label={t("desktop.exitOnClose")}>
						{() =>
							props.desktop?.loadFailed() ? (
								<View class="flex-row flex-wrap items-center gap-2">
									<Text class="text-xs text-destructive">
										{t("desktop.closeLoadFailed")}
									</Text>
									<Button
										variant="ghost"
										size="sm"
										onPress={() => void props.desktop?.load()}
									>
										{t("common.retry")}
									</Button>
								</View>
							) : (
								<View class="flex-row flex-wrap items-center gap-2">
									<Switch
										testID="settings-exit-on-close"
										checked={props.desktop?.settings()?.exitOnClose ?? false}
										disabled={
											!props.desktop?.settings() || props.desktop.savingClose()
										}
										onChange={({ checked }) => void changeClose(checked)}
									/>
									{closeFailed() ? (
										<Text class="font-sans text-xs text-destructive">
											{t("desktop.closeSaveFailed")}
										</Text>
									) : null}
								</View>
							)
						}
					</SettingsRow>
				) : null}
			</SettingsSection>
		</View>
	);
}

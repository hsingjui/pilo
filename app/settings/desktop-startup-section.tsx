import { cleanup, signal, Text, View } from "nsh";
import { Application } from "nsh/desktop";

import type { DesktopShell } from "../shell/desktop-shell";
import { t } from "../shell/i18n";
import { Switch } from "../ui/switch";
import { SettingsRetryInline, SettingsRow, SettingsSection } from "./layout";

export function DesktopStartupSection(props: { desktop?: DesktopShell }) {
	const enabled = signal<boolean | null>(null);
	const saving = signal(false);
	const startupError = signal<
		"desktop.loadFailed" | "desktop.saveFailed" | null
	>(null);
	const closeFailed = signal(false);
	let alive = true;
	cleanup(() => {
		alive = false;
	});
	const load = async () => {
		startupError.set(null);
		try {
			const next = await Application.launchAtLogin();
			if (alive) enabled.set(next);
		} catch {
			if (alive) startupError.set("desktop.loadFailed");
		}
	};
	void load();
	const change = async (next: boolean) => {
		if (saving()) return;
		saving.set(true);
		startupError.set(null);
		try {
			await Application.setLaunchAtLogin(next);
			const refreshed = await Application.launchAtLogin();
			if (alive) enabled.set(refreshed);
		} catch {
			if (alive) startupError.set("desktop.saveFailed");
		} finally {
			if (alive) saving.set(false);
		}
	};
	const changeClose = async (next: boolean) => {
		const desktop = props.desktop;
		if (!desktop || desktop.savingClose()) return;
		closeFailed.set(false);
		try {
			await desktop.saveExitOnClose(next);
		} catch {
			if (alive) closeFailed.set(true);
		}
	};
	return (
		<SettingsSection title={t("desktop.startupAndTray")}>
			<SettingsRow label={t("desktop.autostart")}>
				{() =>
					startupError() === "desktop.loadFailed" ? (
						<SettingsRetryInline
							message={t("desktop.loadFailed")}
							onRetry={() => void load()}
						/>
					) : (
						<View class="flex-row flex-wrap items-center gap-2">
							<Switch
								testID="settings-launch-at-login"
								checked={enabled() ?? false}
								disabled={enabled() === null || saving()}
								onChange={({ checked }) => void change(checked)}
							/>
							{startupError() === "desktop.saveFailed" ? (
								<Text class="font-sans text-xs text-destructive">
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
							<SettingsRetryInline
								message={t("desktop.closeLoadFailed")}
								onRetry={() => void props.desktop?.load()}
							/>
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
	);
}

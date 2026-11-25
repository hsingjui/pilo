import { cleanup, signal } from "nsh";
import { Application } from "nsh/desktop";

import { AppToaster, showToast } from "../shell/app-toasts";
import type { DesktopShell } from "../shell/desktop-shell";
import { t } from "../shell/i18n";
import { Switch } from "../ui/switch";
import { SettingsRetryInline, SettingsRow, SettingsSection } from "./layout";

export function DesktopStartupSection(props: { desktop?: DesktopShell }) {
	const toasts = AppToaster();
	const enabled = signal<boolean | null>(null);
	const saving = signal(false);
	const loadFailed = signal(false);
	let alive = true;
	cleanup(() => {
		alive = false;
	});
	const load = async () => {
		loadFailed.set(false);
		try {
			const next = await Application.launchAtLogin();
			if (alive) enabled.set(next);
		} catch {
			if (alive) loadFailed.set(true);
		}
	};
	void load();
	const change = async (next: boolean) => {
		if (saving()) return;
		saving.set(true);
		try {
			await Application.setLaunchAtLogin(next);
			const refreshed = await Application.launchAtLogin();
			if (alive) enabled.set(refreshed);
		} catch {
			if (alive)
				showToast(toasts, { variant: "error", title: t("desktop.saveFailed") });
		} finally {
			if (alive) saving.set(false);
		}
	};
	const changeClose = async (next: boolean) => {
		const desktop = props.desktop;
		if (!desktop || desktop.savingClose()) return;
		try {
			await desktop.saveExitOnClose(next);
		} catch {
			if (alive)
				showToast(toasts, {
					variant: "error",
					title: t("desktop.closeSaveFailed"),
				});
		}
	};
	return (
		<SettingsSection title={t("desktop.startupAndTray")}>
			<SettingsRow label={t("desktop.autostart")}>
				{() =>
					loadFailed() ? (
						<SettingsRetryInline
							message={t("desktop.loadFailed")}
							onRetry={() => void load()}
						/>
					) : (
						<Switch
							testID="settings-launch-at-login"
							checked={enabled() ?? false}
							disabled={enabled() === null || saving()}
							onChange={({ checked }) => void change(checked)}
						/>
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
							<Switch
								testID="settings-exit-on-close"
								checked={props.desktop?.settings()?.exitOnClose ?? false}
								disabled={
									!props.desktop?.settings() || props.desktop.savingClose()
								}
								onChange={({ checked }) => void changeClose(checked)}
							/>
						)
					}
				</SettingsRow>
			) : null}
		</SettingsSection>
	);
}

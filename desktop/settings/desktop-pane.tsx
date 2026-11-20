import { signal, View } from "nsh";
import { Application } from "nsh/desktop";

import { t } from "../app/i18n";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./layout";

/** Startup integration: launching at login, via nsh's Application module. */
export function DesktopPane() {
	const enabled = signal<boolean | null>(null);
	Application.launchAtLogin()
		.then((value) => enabled.set(value))
		.catch(() => enabled.set(false));
	const change = (next: boolean) => {
		Application.setLaunchAtLogin(next)
			.then(() => enabled.set(next))
			.catch(() => Application.launchAtLogin().then((v) => enabled.set(v)));
	};
	return (
		<View class="gap-3">
			<SettingsSection title={t("desktop.startupAndTray")}>
				<SettingsRow label={t("desktop.autostart")}>
					{() => (
						<Switch
							testID="settings-launch-at-login"
							checked={enabled() ?? false}
							disabled={enabled() === null}
							onChange={({ checked }) => change(checked)}
						/>
					)}
				</SettingsRow>
			</SettingsSection>
		</View>
	);
}

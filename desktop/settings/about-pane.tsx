import { openUrl, Text, View } from "nsh";

import { t } from "../app/i18n";
import meta from "../nsh.json";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { SettingsRow, SettingsSection, SettingsStatus } from "./layout";

const REPOSITORY_URL = "https://github.com/hsingjui/pilo";

/**
 * What the app is and its version, as the Tauri `AboutSettings` pane (its
 * updater and log rows follow the shell's own updater work).
 */
export function AboutPane() {
	return (
		<View class="gap-3">
			<SettingsSection>
				<View class="flex-row items-center gap-4 px-4 py-4">
					<View class="size-16 shrink-0 items-center justify-center rounded-2xl border border-border/60 bg-background">
						<Icon name="Laptop" size={28} class="text-muted-foreground" />
					</View>
					<View class="min-w-0 gap-1">
						<View class="flex-row items-center gap-2">
							<Text class="text-lg font-semibold tracking-tight text-foreground">
								Pilo
							</Text>
							<SettingsStatus>v{meta.version}</SettingsStatus>
						</View>
						<Text class="text-xs leading-relaxed text-muted-foreground">
							{() => t("about.description")}
						</Text>
					</View>
				</View>
			</SettingsSection>
			<SettingsSection title={t("settings.application")}>
				<SettingsRow label={t("settings.version")}>
					<Text class="font-mono text-xs text-muted-foreground">
						{meta.version}
					</Text>
				</SettingsRow>
				<SettingsRow label={t("settings.repository")} ghostEdge="both">
					<Button
						testID="settings-repository"
						variant="ghost"
						size="sm"
						class="h-8 gap-1.5 px-2 text-xs font-normal text-muted-foreground"
						onPress={() => {
							void openUrl(REPOSITORY_URL).catch((error: unknown) =>
								console.error("openUrl failed", error),
							);
						}}
					>
						<Icon name="Code2" size={14} />
						<Text class="text-xs">GitHub</Text>
						<Icon name="ExternalLink" size={14} class="opacity-60" />
					</Button>
				</SettingsRow>
			</SettingsSection>
		</View>
	);
}

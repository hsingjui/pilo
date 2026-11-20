import { type Accessor, keymap, signal, Text, View } from "nsh";

import { SHORTCUT_COMMANDS } from "@/lib/keyboard-shortcuts-types";
import type { AppState } from "../state/app-state";
import type { DesktopShell } from "../app/desktop-shell";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection, SettingsStatus } from "./layout";

const SHORTCUT_SECTIONS = [
	{ id: "app", titleKey: "settings.shortcutApp" },
	{ id: "session", titleKey: "settings.shortcutSession" },
] as const;

/**
 * The saved shortcuts, read-only: nsh views get no per-key events, so a
 * recorder like the Tauri pane's cannot run here.
 */
export function ShortcutsPane(props: {
	state: Accessor<AppState>;
	desktop?: DesktopShell;
}) {
	const map = () => props.state().preferences?.values.keyboardShortcuts;
	return (
		<View class="gap-3">
			{props.desktop ? <GlobalShortcutSetting desktop={props.desktop} /> : null}
			{SHORTCUT_SECTIONS.map((section) => (
				<SettingsSection title={t(section.titleKey)}>
					{SHORTCUT_COMMANDS.filter(
						(command) => command.section === section.id,
					).map((command) => (
						<SettingsRow label={t(command.labelKey)}>
							{() => {
								const shortcut = map()?.[command.id] ?? "";
								return (
									<SettingsStatus muted={!shortcut}>
										{shortcut
											? keymap.label(shortcut)
											: t("shortcuts.unassigned")}
									</SettingsStatus>
								);
							}}
						</SettingsRow>
					))}
				</SettingsSection>
			))}
		</View>
	);
}

function GlobalShortcutSetting(props: { desktop: DesktopShell }) {
	const draft = signal<string | null>(null);
	const saving = () => props.desktop.savingShortcut();
	const failed = signal(false);
	const value = () => draft() ?? props.desktop.settings()?.showShortcut ?? "";
	const save = async () => {
		if (saving() || !props.desktop.settings() || !value().trim()) return;
		failed.set(false);
		try {
			await props.desktop.saveShortcut(value());
			draft.set(null);
		} catch (error) {
			console.warn("Failed to save Pilo global shortcut", error);
			failed.set(true);
		}
	};
	return (
		<SettingsSection title={t("desktop.globalShortcut")}>
			<View class="gap-2 px-3 py-2">
				<Text class="text-xs text-muted-foreground">
					{t("desktop.shortcutHint")}
				</Text>
				<View class="flex-row items-center gap-2">
					<Input
						class="min-w-0 flex-1"
						accessibilityLabel={t("desktop.globalShortcut")}
						placeholder="mod+alt+p"
						value={value()}
						disabled={!props.desktop.settings() || saving()}
						maxLength={100}
						autoCapitalize="none"
						autoCorrect={false}
						onChange={({ value: text }) => draft.set(text)}
						onSubmit={() => void save()}
					/>
					<Button
						disabled={!props.desktop.settings() || saving() || !value().trim()}
						onPress={() => void save()}
					>
						{t("common.save")}
					</Button>
				</View>
				{() =>
					props.desktop.loadFailed() ? (
						<View class="flex-row items-center gap-2">
							<Text class="min-w-0 flex-1 text-xs text-destructive">
								{t("desktop.shortcutLoadFailed")}
							</Text>
							<Button onPress={() => void props.desktop.load()}>
								{t("common.retry")}
							</Button>
						</View>
					) : failed() ? (
						<Text class="text-xs text-destructive">
							{t("desktop.shortcutSaveFailed")}
						</Text>
					) : props.desktop.settings() && !props.desktop.registered() ? (
						<Text class="text-xs text-muted-foreground">
							{t("desktop.shortcutUnavailable")}
						</Text>
					) : null
				}
			</View>
		</SettingsSection>
	);
}

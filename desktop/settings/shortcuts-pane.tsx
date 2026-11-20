import { type Accessor, keymap, View } from "nsh";

import { SHORTCUT_COMMANDS } from "@/lib/keyboard-shortcuts-types";
import type { AppState } from "../state/app-state";
import { t } from "../app/i18n";
import { SettingsRow, SettingsSection, SettingsStatus } from "./layout";

const SHORTCUT_SECTIONS = [
	{ id: "app", titleKey: "settings.shortcutApp" },
	{ id: "session", titleKey: "settings.shortcutSession" },
] as const;

/**
 * The saved shortcuts, read-only: nsh views get no per-key events, so a
 * recorder like the Tauri pane's cannot run here.
 */
export function ShortcutsPane(props: { state: Accessor<AppState> }) {
	const map = () => props.state().preferences?.values.keyboardShortcuts;
	return (
		<View class="gap-3">
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

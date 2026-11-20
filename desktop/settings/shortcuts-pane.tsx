import { type Accessor, platform, signal, Text, View } from "nsh";

import { formatKeyboardShortcutLabels } from "@/lib/keyboard-shortcuts-format";
import { SHORTCUT_COMMANDS } from "@/lib/keyboard-shortcuts-types";
import type { AppState } from "../state/app-state";
import type { DesktopShell } from "../app/desktop-shell";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { styleVar } from "../ui/theme-style";
import { SettingsRow, SettingsSection } from "./layout";

const SHORTCUT_SECTIONS = [
	{ id: "app", titleKey: "settings.shortcutApp" },
	{ id: "session", titleKey: "settings.shortcutSession" },
] as const;

/** The same default the Tauri pane resets to (`DEFAULT_DESKTOP_SHORTCUT`). */
const DEFAULT_SHOW_SHORTCUT = "mod+alt+p";

/** The boxed control a shortcut row shows (Tauri's `SHORTCUT_INPUT_CLASS`). */
const SHORTCUT_BOX_CLASS =
	"h-9 w-fit min-w-0 max-w-full flex-row items-center gap-1.5 rounded-md border border-border/80 bg-background px-2.5";

/** One keystroke as the Tauri pane's kbd chips: `⌘ + ⇧ + M` for `mod+shift+m`. */
function ShortcutKeys(props: { shortcut: string }) {
	const labels = formatKeyboardShortcutLabels(
		props.shortcut,
		platform.os === "macos",
	);
	return (
		<View class="flex-row items-center gap-1">
			{labels.map((label, index) => (
				<>
					{index > 0 ? (
						<Text class="text-[11px] text-muted-foreground">+</Text>
					) : null}
					<Text
						class="min-w-6 rounded border border-border/80 bg-muted/55 px-1.5 py-0.5 text-center font-mono text-[11px] text-foreground"
						style={{ boxShadow: styleVar("pilo-shadow-xs") }}
					>
						{label}
					</Text>
				</>
			))}
		</View>
	);
}

/**
 * The saved shortcuts, read-only: nsh views get no per-key events, so a
 * recorder like the Tauri pane's cannot run here (nor its reset buttons).
 * The rows show the same key chips in the same bordered box.
 */
export function ShortcutsPane(props: {
	state: Accessor<AppState>;
	desktop?: DesktopShell;
}) {
	const map = () => props.state().preferences?.values.keyboardShortcuts;
	const newline = () =>
		(props.state().preferences?.values.sendMessageShortcut ?? "enter") ===
		"enter"
			? "shift+enter"
			: "enter";
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
									<View class={SHORTCUT_BOX_CLASS}>
										{shortcut ? (
											<ShortcutKeys shortcut={shortcut} />
										) : (
											<Text class="text-xs text-muted-foreground">
												{t("shortcuts.unassigned")}
											</Text>
										)}
									</View>
								);
							}}
						</SettingsRow>
					))}
				</SettingsSection>
			))}
			<SettingsSection title={t("settings.shortcutInput")}>
				<SettingsRow label={t("settings.newline")}>
					{() => (
						<View class={SHORTCUT_BOX_CLASS}>
							<ShortcutKeys shortcut={newline()} />
						</View>
					)}
				</SettingsRow>
			</SettingsSection>
		</View>
	);
}

/**
 * The global "show Pilo" shortcut. The Tauri pane records keys; nsh views get
 * no per-key events, so this edits the keystroke as text instead.
 */
function GlobalShortcutSetting(props: { desktop: DesktopShell }) {
	const draft = signal<string | null>(null);
	const saving = () => props.desktop.savingShortcut();
	const failed = signal(false);
	const value = () => draft() ?? props.desktop.settings()?.showShortcut ?? "";
	const save = async (input?: string) => {
		const shortcut = (input ?? value()).trim();
		if (saving() || !props.desktop.settings() || !shortcut) return;
		failed.set(false);
		try {
			await props.desktop.saveShortcut(shortcut);
			draft.set(null);
		} catch (error) {
			console.warn("Failed to save Pilo global shortcut", error);
			failed.set(true);
		}
	};
	return (
		<SettingsSection title={t("desktop.globalShortcut")}>
			<SettingsRow label={t("desktop.show")} helper={t("desktop.shortcutHint")}>
				{() =>
					props.desktop.loadFailed() ? (
						<View class="flex-row flex-wrap items-center gap-2">
							<Text class="text-xs text-destructive">
								{t("desktop.shortcutLoadFailed")}
							</Text>
							<Button
								variant="ghost"
								size="sm"
								onPress={() => void props.desktop.load()}
							>
								{t("common.retry")}
							</Button>
						</View>
					) : (
						<View class="flex-row flex-wrap items-center gap-2">
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
								testID="settings-shortcut-reset"
								variant="ghost"
								size="icon"
								accessibilityLabel={t("settings.resetDefault")}
								disabled={
									!props.desktop.settings() ||
									saving() ||
									props.desktop.settings()?.showShortcut ===
										DEFAULT_SHOW_SHORTCUT
								}
								onPress={() => void save(DEFAULT_SHOW_SHORTCUT)}
							>
								<Icon name="RotateCcw" size={14} />
							</Button>
							<Button
								size="sm"
								disabled={
									!props.desktop.settings() || saving() || !value().trim()
								}
								onPress={() => void save()}
							>
								{t("common.save")}
							</Button>
						</View>
					)
				}
			</SettingsRow>
			{() =>
				!props.desktop.loadFailed() && props.desktop.settings() ? (
					<>
						{failed() ? (
							<Text class="px-3 py-2 text-xs text-destructive">
								{t("desktop.shortcutSaveFailed")}
							</Text>
						) : !props.desktop.registered() ? (
							<View class="px-3 py-2 flex-row flex-wrap items-center gap-2">
								<Text class="min-w-0 flex-1 text-xs text-destructive">
									{t("desktop.shortcutUnavailable")}
								</Text>
								<Button
									variant="ghost"
									size="sm"
									disabled={saving()}
									onPress={() =>
										void save(props.desktop.settings()?.showShortcut ?? "")
									}
								>
									{t("common.retry")}
								</Button>
							</View>
						) : null}
					</>
				) : null
			}
		</SettingsSection>
	);
}

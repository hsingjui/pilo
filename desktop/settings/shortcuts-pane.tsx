import {
	type Accessor,
	cleanup,
	effect,
	keymap,
	platform,
	signal,
	Text,
	View,
} from "nsh";

import {
	defaultKeyboardShortcuts,
	findShortcutConflict,
	getShortcutCommand,
	isSafeGlobalShortcut,
	normalizeKeyboardShortcut,
	shortcutFromKeyEvent,
	type ShortcutKeyEvent,
} from "@shared/keyboard-shortcuts-core";
import { formatKeyboardShortcutLabels } from "@shared/keyboard-shortcuts-format";
import {
	SHORTCUT_COMMANDS,
	type ShortcutCommandId,
} from "@shared/keyboard-shortcuts-types";
import type { PreferencePatch } from "@shared/host-preferences-types";
import { nshAppShortcut } from "../shortcuts";
import type { AppState } from "../state/app-state";
import type { DesktopShell } from "../app/desktop-shell";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { styleVar } from "../ui/theme-style";
import type { SettingsClient } from "./settings-dialog";
import { SettingsRow, SettingsSection } from "./layout";

const SHORTCUT_SECTIONS = [
	{ id: "app", titleKey: "settings.shortcutApp" },
	{ id: "session", titleKey: "settings.shortcutSession" },
] as const;

/** The same default the Tauri pane resets to (`DEFAULT_DESKTOP_SHORTCUT`). */
const DEFAULT_SHOW_SHORTCUT = "mod+alt+p";

/** The boxed control a shortcut row shows (Tauri's `SHORTCUT_INPUT_CLASS`). */
const SHORTCUT_BOX_CLASS =
	"h-9 w-fit min-w-0 max-w-full flex-row items-center gap-1.5 rounded-md border px-2.5";
const SHORTCUT_BOX_IDLE_CLASS = "border-border/80 bg-background";
const SHORTCUT_BOX_RECORDING_CLASS = "border-ring bg-accent/60";

/** The ghost icon button Tauri shows for per-row and header resets. */
const SHORTCUT_RESET_CLASS = "size-7 shrink-0";

const IS_MAC = platform.os === "macos";
const EDITABLE_COMMANDS = SHORTCUT_COMMANDS.filter(
	(command) => command.section === "app",
);

/** One keystroke as the Tauri pane's kbd chips: `⌘ + ⇧ + M` for `mod+shift+m`. */
function ShortcutKeys(props: { shortcut: string }) {
	const labels = formatKeyboardShortcutLabels(props.shortcut, IS_MAC);
	return (
		<View class="flex-row items-center gap-1">
			{labels.map((label, index) => (
				<>
					{index > 0 ? (
						<Text class="font-sans text-[11px] text-muted-foreground">+</Text>
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

/** A nsh key event as the DOM-shaped parts the shared normalizer expects. */
function keyEventParts(event: {
	key: string;
	modifiers: {
		alt: boolean;
		control: boolean;
		platform: boolean;
		shift: boolean;
	};
}): ShortcutKeyEvent {
	return {
		key: event.key,
		metaKey: IS_MAC ? event.modifiers.platform : false,
		ctrlKey: IS_MAC
			? event.modifiers.control
			: event.modifiers.control || event.modifiers.platform,
		altKey: event.modifiers.alt,
		shiftKey: event.modifiers.shift,
	};
}

type ShortcutNotice = {
	kind: "modifier" | "conflict" | "default" | "unavailable" | "save";
	label?: string;
};

/** The validation feedback Tauri raises as a toast; nsh surfaces it inline. */
function noticeText(notice: ShortcutNotice): string {
	if (notice.kind === "unavailable") return t("shortcuts.unavailable");
	if (notice.kind === "save") return t("settings.preferencesSaveFailed");
	if (notice.kind === "modifier")
		return `${t("shortcuts.modifierRequired")} ${t("shortcuts.modifierDescription")}`;
	if (notice.kind === "default")
		return `${t("shortcuts.defaultOccupied")} ${t("shortcuts.defaultOccupiedDescription", { label: notice.label ?? "" })}`;
	return `${t("shortcuts.conflict")} ${t("shortcuts.conflictDescription", { label: notice.label ?? "" })}`;
}

/** A focusable view receives raw keys on macOS; a native input does not. */
function ShortcutRecorder(props: {
	label: string;
	onCapture: (shortcut: string) => void;
	onCancel: () => void;
}) {
	return (
		<View
			testID="shortcut-recorder"
			focusable
			ref={(view) => view.focus()}
			captureKeys="all"
			class={`${SHORTCUT_BOX_CLASS} ${SHORTCUT_BOX_RECORDING_CLASS} w-40`}
			accessibilityLabel={props.label}
			onBlur={props.onCancel}
			onKeyDown={(event) => {
				if (
					event.key === "Escape" ||
					(event.key === "Tab" &&
						!event.modifiers.platform &&
						!event.modifiers.control &&
						!event.modifiers.alt)
				) {
					props.onCancel();
					return;
				}
				if (event.repeat) return;
				const next = shortcutFromKeyEvent(keyEventParts(event), IS_MAC);
				if (next) props.onCapture(next);
			}}
		>
			<Text class="font-sans text-xs text-muted-foreground">
				{t("settings.pressNewShortcut")}
			</Text>
		</View>
	);
}

export function ShortcutsPane(props: {
	state: Accessor<AppState>;
	client: Pick<SettingsClient, "savePreferences">;
	desktop?: DesktopShell;
	onRecordingChange?: (recording: boolean) => void;
}) {
	const map = () => props.state().preferences?.values.keyboardShortcuts;
	const sendShortcut = () =>
		props.state().preferences?.values.sendMessageShortcut ?? "enter";
	const newline = () => (sendShortcut() === "enter" ? "shift+enter" : "enter");
	const defaults = defaultKeyboardShortcuts(IS_MAC);

	const recording = signal<ShortcutCommandId | "desktop" | null>(null);
	const stopRecording = (id: ShortcutCommandId | "desktop") => {
		if (recording() === id) recording.set(null);
	};
	const notice = signal<ShortcutNotice | null>(null);
	effect(() => props.onRecordingChange?.(recording() !== null));
	cleanup(() => props.onRecordingChange?.(false));

	const save = (patch: PreferencePatch) => {
		notice.set(null);
		void props.client.savePreferences(patch).catch((error: unknown) => {
			console.error(t("settings.preferencesSaveFailed"), error);
			notice.set({ kind: "save" });
		});
	};

	const shortcutFor = (id: ShortcutCommandId) => map()?.[id] ?? defaults[id];
	const hasCustomShortcut = () =>
		EDITABLE_COMMANDS.some(({ id }) => shortcutFor(id) !== defaults[id]);
	const findConflict = (commandId: ShortcutCommandId, shortcut: string) => {
		const native = nshAppShortcut(shortcut, IS_MAC);
		return (
			findShortcutConflict(
				{ ...defaults, ...map() },
				commandId,
				shortcut,
				IS_MAC,
			) ??
			EDITABLE_COMMANDS.find(
				({ id }) =>
					id !== commandId &&
					native &&
					native === nshAppShortcut(shortcutFor(id), IS_MAC),
			)?.id
		);
	};

	/** The saved global shortcut must not collide with an in-app one. */
	const freeOfDesktopConflict = (shortcuts: readonly string[]) => {
		const show = props.desktop?.settings()?.showShortcut;
		if (!show) return true;
		const conflict = shortcuts.some(
			(shortcut) =>
				normalizeKeyboardShortcut(shortcut, IS_MAC) ===
				normalizeKeyboardShortcut(show, IS_MAC),
		);
		if (!conflict) return true;
		notice.set({ kind: "conflict", label: t("desktop.show") });
		return false;
	};

	const assign = (commandId: ShortcutCommandId, next: string) => {
		if (!isSafeGlobalShortcut(next, IS_MAC)) {
			notice.set({ kind: "modifier" });
			return;
		}
		const conflictId = findConflict(commandId, next);
		if (conflictId) {
			notice.set({
				kind: "conflict",
				label: t(getShortcutCommand(conflictId).labelKey),
			});
			return;
		}
		if (!freeOfDesktopConflict([next])) return;
		const nativeShortcut = nshAppShortcut(next, IS_MAC);
		if (!nativeShortcut) return;
		try {
			// Only bind validates both syntax and platform-reserved keys.
			keymap.bind(nativeShortcut, () => {}, { passThrough: true })();
		} catch {
			notice.set({ kind: "unavailable" });
			return;
		}
		save({ keyboardShortcuts: { [commandId]: next } });
		recording.set(null);
	};

	const reset = (commandId: ShortcutCommandId) => {
		const fallback = defaults[commandId];
		const conflictId = findConflict(commandId, fallback);
		if (conflictId) {
			notice.set({
				kind: "default",
				label: t(getShortcutCommand(conflictId).labelKey),
			});
			return;
		}
		if (!freeOfDesktopConflict([fallback])) return;
		save({ keyboardShortcuts: { [commandId]: fallback } });
	};

	const resetAll = () => {
		const keyboardShortcuts = Object.fromEntries(
			EDITABLE_COMMANDS.map(({ id }) => [id, defaults[id]]),
		);
		if (!freeOfDesktopConflict(Object.values(keyboardShortcuts))) return;
		save({ keyboardShortcuts });
		recording.set(null);
	};

	return (
		<View class="gap-3">
			{props.desktop ? (
				<GlobalShortcutSetting
					desktop={props.desktop}
					recording={() => recording() === "desktop"}
					onRecordingChange={(next) => {
						if (next) recording.set("desktop");
						else stopRecording("desktop");
					}}
				/>
			) : null}
			{SHORTCUT_SECTIONS.map((section, sectionIndex) => (
				<SettingsSection
					title={t(section.titleKey)}
					actions={() =>
						sectionIndex === 0 ? (
							<Button
								testID="shortcuts-reset-all"
								variant="ghost"
								size="icon"
								class={SHORTCUT_RESET_CLASS}
								accessibilityLabel={t("settings.resetAllDefaults")}
								disabled={!hasCustomShortcut()}
								onPress={resetAll}
							>
								<Icon name="RotateCcw" size={14} />
							</Button>
						) : null
					}
				>
					{SHORTCUT_COMMANDS.filter(
						(command) => command.section === section.id,
					).map((command) => (
						<SettingsRow label={t(command.labelKey)}>
							{() => {
								const shortcut = shortcutFor(command.id);
								const keys = () =>
									shortcut ? (
										<ShortcutKeys shortcut={shortcut} />
									) : (
										<Text class="font-sans text-xs text-muted-foreground">
											{t("shortcuts.unassigned")}
										</Text>
									);
								if (command.section !== "app") {
									return (
										<View
											class={`${SHORTCUT_BOX_CLASS} ${SHORTCUT_BOX_IDLE_CLASS}`}
										>
											{keys()}
										</View>
									);
								}
								const isCustom = shortcut !== defaults[command.id];
								return (
									<View class="flex-row items-center gap-1.5">
										{recording() === command.id ? (
											<ShortcutRecorder
												label={t("shortcuts.change", {
													label: t(command.labelKey),
												})}
												onCapture={(next) => assign(command.id, next)}
												onCancel={() => stopRecording(command.id)}
											/>
										) : (
											<Button
												testID={`shortcut-box-${command.id}`}
												variant="ghost"
												class={`${SHORTCUT_BOX_CLASS} ${SHORTCUT_BOX_IDLE_CLASS}`}
												accessibilityLabel={t("shortcuts.change", {
													label: t(command.labelKey),
												})}
												onPress={() => {
													notice.set(null);
													recording.set(command.id);
												}}
											>
												{keys()}
											</Button>
										)}
										<Button
											variant="ghost"
											size="icon"
											class={`${SHORTCUT_RESET_CLASS} ${isCustom ? "" : "invisible"}`}
											accessibilityLabel={t("shortcuts.reset", {
												label: t(command.labelKey),
											})}
											disabled={!isCustom}
											onPress={() => reset(command.id)}
										>
											<Icon name="RotateCcw" size={14} />
										</Button>
									</View>
								);
							}}
						</SettingsRow>
					))}
				</SettingsSection>
			))}
			{() =>
				notice() ? (
					<Text class="font-sans px-3 pb-1 text-xs text-destructive">
						{noticeText(notice()!)}
					</Text>
				) : null
			}
			<SettingsSection title={t("settings.shortcutInput")}>
				<SettingsRow label={t("settings.newline")}>
					{() => (
						<View class="flex-row items-center gap-1.5">
							<View class={`${SHORTCUT_BOX_CLASS} border-transparent`}>
								<ShortcutKeys shortcut={newline()} />
							</View>
							<View class={`${SHORTCUT_RESET_CLASS} invisible`} />
						</View>
					)}
				</SettingsRow>
			</SettingsSection>
		</View>
	);
}

/**
 * The global "show Pilo" shortcut with the same recorder as the in-app rows:
 * captured keystrokes go through `DesktopShell.saveShortcut`, which validates,
 * registers and persists them.
 */
function GlobalShortcutSetting(props: {
	desktop: DesktopShell;
	recording: Accessor<boolean>;
	onRecordingChange: (recording: boolean) => void;
}) {
	const saving = () => props.desktop.savingShortcut();
	const failed = signal(false);
	const notice = signal<ShortcutNotice | null>(null);
	const saved = () => props.desktop.settings()?.showShortcut ?? "";

	const save = async (shortcut: string) => {
		if (saving() || !props.desktop.settings() || !shortcut) return;
		failed.set(false);
		notice.set(null);
		try {
			await props.desktop.saveShortcut(shortcut);
			props.onRecordingChange(false);
		} catch (error) {
			console.warn("Failed to save Pilo global shortcut", error);
			failed.set(true);
		}
	};

	const capture = (shortcut: string) => {
		if (!isSafeGlobalShortcut(shortcut, IS_MAC)) {
			notice.set({ kind: "modifier" });
			return;
		}
		void save(shortcut);
	};

	return (
		<SettingsSection title={t("desktop.globalShortcut")}>
			<SettingsRow label={t("desktop.show")} helper={t("desktop.shortcutHint")}>
				{() =>
					props.desktop.loadFailed() ? (
						<View class="flex-row flex-wrap items-center gap-2">
							<Text class="font-sans text-xs text-destructive">
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
						<View class="flex-row items-center gap-1.5">
							{props.recording() ? (
								<ShortcutRecorder
									label={t("shortcuts.change", { label: t("desktop.show") })}
									onCapture={capture}
									onCancel={() => props.onRecordingChange(false)}
								/>
							) : (
								<Button
									variant="ghost"
									class={`${SHORTCUT_BOX_CLASS} ${SHORTCUT_BOX_IDLE_CLASS}`}
									accessibilityLabel={t("shortcuts.change", {
										label: t("desktop.show"),
									})}
									disabled={!props.desktop.settings() || saving()}
									onPress={() => props.onRecordingChange(true)}
								>
									{props.desktop.settings() ? (
										<ShortcutKeys shortcut={saved()} />
									) : (
										<Text class="font-sans text-xs text-muted-foreground">
											{t("common.loading")}
										</Text>
									)}
								</Button>
							)}
							<Button
								testID="settings-shortcut-reset"
								variant="ghost"
								size="icon"
								class={SHORTCUT_RESET_CLASS}
								accessibilityLabel={t("shortcuts.reset", {
									label: t("desktop.show"),
								})}
								disabled={
									!props.desktop.settings() ||
									saving() ||
									saved() === DEFAULT_SHOW_SHORTCUT
								}
								onPress={() => void save(DEFAULT_SHOW_SHORTCUT)}
							>
								<Icon name="RotateCcw" size={14} />
							</Button>
						</View>
					)
				}
			</SettingsRow>
			{() =>
				!props.desktop.loadFailed() && props.desktop.settings() ? (
					<>
						{notice() ? (
							<Text class="font-sans px-3 py-2 text-xs text-destructive">
								{noticeText(notice()!)}
							</Text>
						) : null}
						{failed() ? (
							<Text class="font-sans px-3 py-2 text-xs text-destructive">
								{t("desktop.shortcutSaveFailed")}
							</Text>
						) : !props.desktop.registered() ? (
							<View class="px-3 py-2 flex-row flex-wrap items-center gap-2">
								<Text class="font-sans min-w-0 flex-1 text-xs text-destructive">
									{t("desktop.shortcutUnavailable")}
								</Text>
								<Button
									variant="ghost"
									size="sm"
									disabled={saving()}
									onPress={() => void save(saved())}
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

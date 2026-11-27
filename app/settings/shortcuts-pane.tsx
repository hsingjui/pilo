import {
	type Accessor,
	effect,
	type JSX,
	keymap,
	platform,
	signal,
	Text,
	View,
	type ViewRef,
} from "nsh";

import {
	defaultKeyboardShortcuts,
	findShortcutConflict,
	getShortcutCommand,
	isSafeGlobalShortcut,
	shortcutFromKeyEvent,
	type ShortcutKeyEvent,
} from "@shared/keyboard-shortcuts-core";
import { formatKeyboardShortcutLabels } from "@shared/keyboard-shortcuts-format";
import {
	SHORTCUT_COMMANDS,
	type ShortcutCommandId,
} from "@shared/keyboard-shortcuts-types";
import type { PreferencePatch } from "@shared/host-preferences-types";
import { isReservedSendShortcut, nshAppShortcut } from "../shortcuts";
import type { AppState } from "../state/app-state";
import type { DesktopShell } from "../shell/desktop-shell";
import { AppToaster, showToast } from "../shell/app-toasts";
import { t } from "../shell/i18n";
import { Icon } from "../ui/icon";
import { MOTION, tactileTransition } from "../ui/motion";
import { styleVar } from "../ui/theme-style";
import type { SettingsClient } from "./settings-dialog";
import {
	SETTINGS_HEADER_ICON_BUTTON_CLASS,
	SETTINGS_ICON_BUTTON_CLASS,
	SettingsIconButton,
	SettingsRetryInline,
	SettingsRow,
	SettingsSection,
	SettingsSectionMessage,
} from "./layout";

const SHORTCUT_SECTIONS = [
	{ id: "app", titleKey: "settings.shortcutApp" },
	{ id: "session", titleKey: "settings.shortcutSession" },
] as const;

/** The same default the WebUI pane resets to (`DEFAULT_DESKTOP_SHORTCUT`). */
const DEFAULT_SHOW_SHORTCUT = "mod+alt+p";

/** The boxed control a shortcut row shows, matching compact 32pt row controls. */
const SHORTCUT_BOX_CLASS =
	"h-(--pilo-button-sm-height) w-fit min-w-0 max-w-full flex-row items-center gap-1.5 rounded-md border px-2.5";
const SHORTCUT_BOX_IDLE_CLASS = "border-border/80 bg-background";
const SHORTCUT_BOX_RECORDING_CLASS = "border-ring bg-accent/60";

const IS_MAC = platform.os === "macos";

/**
 * The US-layout character a DOM `KeyboardEvent.code` names (`"KeyJ"` a `j`),
 * for the keys whose logical key an Option or Shift combination changes
 * (`Option+J` reports `"∆"` on macOS). Named keys and other layouts keep the
 * reported key, as `shortcutFromKeyEvent` reads it.
 */
function codeKey(code: unknown): string | null {
	if (typeof code !== "string") return null;
	const letter = /^Key([A-Z])$/.exec(code);
	if (letter?.[1]) return letter[1].toLowerCase();
	const digit = /^(?:Digit|Numpad)([0-9])$/.exec(code);
	if (digit?.[1]) return digit[1];
	return null;
}

/** One keystroke as the WebUI pane's kbd chips: `⌘ + ⇧ + M` for `mod+shift+m`. */
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
	code?: string;
	modifiers: {
		alt: boolean;
		control: boolean;
		platform: boolean;
		shift: boolean;
	};
}): ShortcutKeyEvent {
	return {
		key: codeKey(event.code) ?? event.key,
		metaKey: IS_MAC ? event.modifiers.platform : false,
		ctrlKey: IS_MAC
			? event.modifiers.control
			: event.modifiers.control || event.modifiers.platform,
		altKey: event.modifiers.alt,
		shiftKey: event.modifiers.shift,
	};
}

type ShortcutNotice = {
	kind: "modifier" | "conflict" | "default" | "unavailable";
	label?: string;
	commandId?: ShortcutCommandId;
};

/** The validation feedback the WebUI raises as a toast; nsh surfaces it inline. */
function noticeText(notice: ShortcutNotice): string {
	if (notice.kind === "unavailable") return t("shortcuts.unavailable");
	if (notice.kind === "modifier")
		return `${t("shortcuts.modifierRequired")} ${t("shortcuts.modifierDescription")}`;
	if (notice.kind === "default")
		return `${t("shortcuts.defaultOccupied")} ${t("shortcuts.defaultOccupiedDescription", { label: notice.label ?? "" })}`;
	return `${t("shortcuts.conflict")} ${t("shortcuts.conflictDescription", { label: notice.label ?? "" })}`;
}

/** Keep the same focused control when switching between display and capture. */
function ShortcutRecorder(props: {
	testID?: string;
	label: string;
	recording: Accessor<boolean>;
	disabled?: boolean;
	onStart: () => void;
	onCapture: (shortcut: string) => void;
	onCancel: () => void;
	children: JSX.Element;
}) {
	let view: ViewRef | undefined;
	const node = (
		<View
			ref={(el) => {
				view = el;
			}}
			testID={props.recording() ? "shortcut-recorder" : props.testID}
			role="button"
			focusable
			disabled={!props.recording() && props.disabled}
			captureKeys={props.recording() ? "all" : "none"}
			class={`${SHORTCUT_BOX_CLASS} ${
				props.recording()
					? SHORTCUT_BOX_RECORDING_CLASS
					: `${SHORTCUT_BOX_IDLE_CLASS} justify-center hover:bg-hover focus-visible:border-ring`
			} disabled:opacity-50`}
			style={tactileTransition("background-color, border-color, opacity")}
			accessibilityLabel={props.label}
			onPress={() => {
				if (!props.recording()) props.onStart();
			}}
			onBlur={() => {
				if (props.recording()) props.onCancel();
			}}
			onKeyDown={(event) => {
				if (!props.recording()) return;
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
			{() =>
				props.recording() ? (
					<Text class="font-sans text-xs text-muted-foreground">
						{t("settings.pressNewShortcut")}
					</Text>
				) : (
					props.children
				)
			}
		</View>
	);
	let wasRecording = props.recording();
	effect(() => {
		const rec = props.recording();
		if (rec !== wasRecording) {
			view?.animateLayout({ type: "spring", ...MOTION.spring.crisp });
			wasRecording = rec;
		}
		if (rec) view?.focus();
	});
	return node;
}

export function ShortcutsPane(props: {
	state: Accessor<AppState>;
	client: Pick<SettingsClient, "savePreferences">;
	desktop?: DesktopShell;
}) {
	const toasts = AppToaster();
	const map = () => props.state().preferences?.values.keyboardShortcuts;
	const sendShortcut = () =>
		props.state().preferences?.values.sendMessageShortcut ?? "enter";
	const newline = () => (sendShortcut() === "enter" ? "shift+enter" : "enter");
	const defaults = defaultKeyboardShortcuts(IS_MAC);

	const recording = signal<ShortcutCommandId | "desktop" | null>(null);
	const stopRecording = (id: ShortcutCommandId | "desktop") => {
		if (recording() === id) recording.set(null);
		notice.set(null);
	};
	const notice = signal<ShortcutNotice | null>(null);

	const save = (patch: PreferencePatch) => {
		notice.set(null);
		void props.client.savePreferences(patch).catch((error: unknown) => {
			console.error(t("settings.preferencesSaveFailed"), error);
			showToast(toasts, {
				variant: "error",
				title: t("settings.preferencesSaveFailed"),
			});
		});
	};

	const shortcutFor = (id: ShortcutCommandId) => map()?.[id] ?? defaults[id];
	const hasCustomShortcut = () =>
		SHORTCUT_COMMANDS.some(({ id }) => shortcutFor(id) !== defaults[id]);
	const findConflict = (commandId: ShortcutCommandId, shortcut: string) => {
		const native = nshAppShortcut(shortcut, IS_MAC);
		return (
			findShortcutConflict(
				{ ...defaults, ...map() },
				commandId,
				shortcut,
				IS_MAC,
			) ??
			SHORTCUT_COMMANDS.find(
				({ id }) =>
					id !== commandId &&
					native &&
					native === nshAppShortcut(shortcutFor(id), IS_MAC),
			)?.id
		);
	};

	/** The saved global shortcut must not collide with an in-app one. */
	const freeOfDesktopConflict = (
		shortcuts: readonly string[],
		commandId?: ShortcutCommandId,
	) => {
		const show = props.desktop?.settings()?.showShortcut;
		if (!show) return true;
		const conflict = shortcuts.some(
			(shortcut) =>
				nshAppShortcut(shortcut, IS_MAC) === nshAppShortcut(show, IS_MAC),
		);
		if (!conflict) return true;
		notice.set({ kind: "conflict", label: t("desktop.show"), commandId });
		return false;
	};

	const assign = (commandId: ShortcutCommandId, next: string) => {
		if (!isSafeGlobalShortcut(next, IS_MAC)) {
			notice.set({ kind: "modifier", commandId });
			return;
		}
		const conflictId = findConflict(commandId, next);
		if (conflictId) {
			notice.set({
				kind: "conflict",
				label: t(getShortcutCommand(conflictId).labelKey),
				commandId,
			});
			return;
		}
		if (!freeOfDesktopConflict([next], commandId)) return;
		const nativeShortcut = nshAppShortcut(next, IS_MAC);
		if (!nativeShortcut) return;
		try {
			if (isReservedSendShortcut(nativeShortcut)) {
				notice.set({
					kind: "conflict",
					label: t("settings.sendShortcut"),
					commandId,
				});
				return;
			}
			// Only bind validates both syntax and platform-reserved keys.
			keymap.bind(nativeShortcut, () => {}, { passThrough: true })();
		} catch {
			notice.set({ kind: "unavailable", commandId });
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
				commandId,
			});
			return;
		}
		if (!freeOfDesktopConflict([fallback], commandId)) return;
		save({ keyboardShortcuts: { [commandId]: fallback } });
	};

	const resetAll = () => {
		const keyboardShortcuts = Object.fromEntries(
			SHORTCUT_COMMANDS.map(({ id }) => [id, defaults[id]]),
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
					findAppConflict={(shortcut) => {
						const native = nshAppShortcut(shortcut, IS_MAC);
						const match = SHORTCUT_COMMANDS.find(
							({ id }) =>
								native && native === nshAppShortcut(shortcutFor(id), IS_MAC),
						);
						return match ? t(match.labelKey) : null;
					}}
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
							<SettingsIconButton
								testID="shortcuts-reset-all"
								class={SETTINGS_HEADER_ICON_BUTTON_CLASS}
								accessibilityLabel={t("settings.resetAllDefaults")}
								disabled={!hasCustomShortcut()}
								onPress={resetAll}
							>
								<Icon name="RotateCcw" size={14} />
							</SettingsIconButton>
						) : null
					}
				>
					{SHORTCUT_COMMANDS.filter(
						(command) => command.section === section.id,
					).map((command) => (
						<SettingsRow
							label={
								<View class="min-w-0 gap-0.5">
									<Text class="font-sans font-medium leading-tight text-foreground">
										{t(command.labelKey)}
									</Text>
									{() =>
										notice()?.commandId === command.id ? (
											<Text class="font-sans text-xs leading-4 text-destructive">
												{noticeText(notice()!)}
											</Text>
										) : null
									}
								</View>
							}
						>
							<View class="flex-row items-center gap-1.5">
								<ShortcutRecorder
									testID={`shortcut-box-${command.id}`}
									label={t("shortcuts.change", { label: t(command.labelKey) })}
									recording={() => recording() === command.id}
									onStart={() => {
										notice.set(null);
										recording.set(command.id);
									}}
									onCapture={(next) => assign(command.id, next)}
									onCancel={() => stopRecording(command.id)}
								>
									{() => {
										const shortcut = shortcutFor(command.id);
										return shortcut ? (
											<ShortcutKeys shortcut={shortcut} />
										) : (
											<Text class="font-sans text-xs text-muted-foreground">
												{t("shortcuts.unassigned")}
											</Text>
										);
									}}
								</ShortcutRecorder>
								<SettingsIconButton
									class={
										shortcutFor(command.id) === defaults[command.id]
											? "invisible"
											: undefined
									}
									accessibilityLabel={t("shortcuts.reset", {
										label: t(command.labelKey),
									})}
									disabled={shortcutFor(command.id) === defaults[command.id]}
									onPress={() => reset(command.id)}
								>
									<Icon name="RotateCcw" size={14} />
								</SettingsIconButton>
							</View>
						</SettingsRow>
					))}
				</SettingsSection>
			))}
			{() =>
				notice() && notice()?.commandId === undefined ? (
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
							<View class={`${SETTINGS_ICON_BUTTON_CLASS} invisible`} />
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
	findAppConflict?: (shortcut: string) => string | null;
	onRecordingChange: (recording: boolean) => void;
}) {
	const toasts = AppToaster();
	const saving = () => props.desktop.savingShortcut();
	const notice = signal<ShortcutNotice | null>(null);
	const saved = () => props.desktop.settings()?.showShortcut ?? "";

	const save = async (shortcut: string) => {
		if (saving() || !props.desktop.settings() || !shortcut) return;
		notice.set(null);
		try {
			await props.desktop.saveShortcut(shortcut);
			props.onRecordingChange(false);
		} catch (error) {
			console.warn("Failed to save Pilo global shortcut", error);
			showToast(toasts, {
				variant: "error",
				title: t("desktop.shortcutSaveFailed"),
			});
		}
	};

	const capture = (shortcut: string) => {
		if (!isSafeGlobalShortcut(shortcut, IS_MAC)) {
			notice.set({ kind: "modifier" });
			return;
		}
		const conflictLabel = props.findAppConflict?.(shortcut);
		if (conflictLabel) {
			notice.set({ kind: "conflict", label: conflictLabel });
			return;
		}
		void save(shortcut);
	};

	return (
		<SettingsSection title={t("desktop.globalShortcut")}>
			<SettingsRow label={t("desktop.show")} helper={t("desktop.shortcutHint")}>
				{() =>
					props.desktop.loadFailed() ? (
						<SettingsRetryInline
							message={t("desktop.shortcutLoadFailed")}
							onRetry={() => void props.desktop.load()}
						/>
					) : (
						<View class="flex-row items-center gap-1.5">
							<ShortcutRecorder
								label={t("shortcuts.change", { label: t("desktop.show") })}
								recording={props.recording}
								disabled={!props.desktop.settings() || saving()}
								onStart={() => props.onRecordingChange(true)}
								onCapture={capture}
								onCancel={() => props.onRecordingChange(false)}
							>
								{() =>
									props.desktop.settings() ? (
										<ShortcutKeys shortcut={saved()} />
									) : (
										<Text class="font-sans text-xs text-muted-foreground">
											{t("common.loading")}
										</Text>
									)
								}
							</ShortcutRecorder>
							<SettingsIconButton
								testID="settings-shortcut-reset"
								accessibilityLabel={t("shortcuts.reset", {
									label: t("desktop.show"),
								})}
								disabled={
									!props.desktop.settings() ||
									saving() ||
									saved() === DEFAULT_SHOW_SHORTCUT
								}
								onPress={() => {
									const conflictLabel = props.findAppConflict?.(
										DEFAULT_SHOW_SHORTCUT,
									);
									if (conflictLabel) {
										notice.set({ kind: "conflict", label: conflictLabel });
										return;
									}
									void save(DEFAULT_SHOW_SHORTCUT);
								}}
							>
								<Icon name="RotateCcw" size={14} />
							</SettingsIconButton>
						</View>
					)
				}
			</SettingsRow>
			{() =>
				!props.desktop.loadFailed() && props.desktop.settings() ? (
					<>
						{notice() ? (
							<SettingsSectionMessage tone="error">
								{noticeText(notice()!)}
							</SettingsSectionMessage>
						) : null}
						{!props.desktop.registered() ? (
							<SettingsRetryInline
								class="px-3 py-2"
								fill
								message={t("desktop.shortcutUnavailable")}
								disabled={saving()}
								onRetry={() => void save(saved())}
							/>
						) : null}
					</>
				) : null
			}
		</SettingsSection>
	);
}

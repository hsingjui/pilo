import { useConfigurationRevision } from "@/lib/use-configuration-revision";
import {
	useEffect,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import {
	DEFAULT_KEYBOARD_SHORTCUTS,
	SHORTCUT_COMMANDS,
	findShortcutConflict,
	formatKeyboardShortcut,
	getShortcutCommand,
	isSafeGlobalShortcut,
	shortcutFromKeyboardEvent,
	type ShortcutCommandId,
} from "@/lib/keyboard-shortcuts";
import { usePreferences } from "@/lib/preferences-provider";
import {
	DEFAULT_DESKTOP_SHORTCUT,
	desktopShortcutFromKeyboardEvent,
	getDesktopShortcut,
	hasDesktopShortcutConflict,
	isDesktopIntegrationAvailable,
	setDesktopShortcut,
	type DesktopShortcutSettings,
} from "@/lib/desktop-integration";
import { cn } from "@/lib/utils";
import { Button, Hint } from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SettingsRow,
	SettingsSection,
} from "./compact-layout";

// 分组和设置行共享内容列，让最长组合键决定列宽，同时保持左右两端对齐。
const SHORTCUT_SUBGRID_CLASS = "sm:col-span-full sm:grid sm:grid-cols-subgrid";
const SHORTCUT_SECTION_CLASS = cn(
	SHORTCUT_SUBGRID_CLASS,
	"sm:[&>header]:col-span-full",
);
const SHORTCUT_EDITOR_CLASS =
	"grid w-full min-w-0 grid-cols-[minmax(0,1fr)_max-content] items-center gap-1.5";
const SHORTCUT_INPUT_CLASS =
	"flex h-9 w-fit min-w-0 max-w-full items-center justify-start justify-self-start overflow-x-auto overflow-y-hidden whitespace-nowrap rounded-md border px-2.5 py-1.5 text-left font-normal transition-colors outline-none pointer-coarse:min-h-[44px] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

// 表头、全局快捷键和普通项共用重置按钮列，不应用文字按钮的边距补偿。
const SHORTCUT_RESET_BUTTON_CLASS =
	"size-7 shrink-0 sm:mr-0! pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]";

function ShortcutKeys({ shortcut }: { shortcut: string }) {
	const tokens = shortcut.split("+");
	const keys = formatKeyboardShortcut(shortcut).map((label, index) => ({
		label,
		token: tokens[index] ?? label,
	}));
	return (
		<span className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-2xs text-foreground">
			{keys.map((key, index) => (
				<span
					key={key.token}
					className="flex items-center gap-1 whitespace-nowrap"
				>
					{index > 0 ? <span className="text-muted-foreground">+</span> : null}
					<kbd className="min-w-6 whitespace-nowrap rounded border border-border/80 bg-muted/55 px-1.5 py-0.5 text-center shadow-xs">
						{key.label}
					</kbd>
				</span>
			))}
		</span>
	);
}

function ShortcutEditor({
	commandId,
	recording,
	onStartRecording,
	onStopRecording,
	canUseShortcuts,
}: {
	commandId: ShortcutCommandId;
	recording: boolean;
	onStartRecording: () => void;
	onStopRecording: () => void;
	canUseShortcuts: (shortcuts: readonly string[]) => Promise<boolean>;
}) {
	const { t } = useTranslation();
	const { keyboardShortcuts, setKeyboardShortcut, resetKeyboardShortcut } =
		usePreferences();
	const shortcut = keyboardShortcuts[commandId];
	const isCustom = shortcut !== DEFAULT_KEYBOARD_SHORTCUTS[commandId];
	const resetShortcut = async () => {
		const defaultShortcut = DEFAULT_KEYBOARD_SHORTCUTS[commandId];
		const conflictId = findShortcutConflict(
			keyboardShortcuts,
			commandId,
			defaultShortcut,
		);
		if (conflictId) {
			toast.error(t("shortcuts.defaultOccupied"), {
				description: t("shortcuts.defaultOccupiedDescription", {
					label: t(getShortcutCommand(conflictId).labelKey),
				}),
			});
			return;
		}
		if (!(await canUseShortcuts([defaultShortcut]))) return;
		resetKeyboardShortcut(commandId);
	};

	const handleKeyDown = async (
		event: ReactKeyboardEvent<HTMLButtonElement>,
	) => {
		if (!recording) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.key === "Escape") {
			onStopRecording();
			return;
		}

		const next = shortcutFromKeyboardEvent(event.nativeEvent);
		if (!next) return;
		if (!isSafeGlobalShortcut(next)) {
			toast.error(t("shortcuts.modifierRequired"), {
				description: t("shortcuts.modifierDescription"),
			});
			return;
		}
		const conflictId = findShortcutConflict(keyboardShortcuts, commandId, next);
		if (conflictId) {
			toast.error(t("shortcuts.conflict"), {
				description: t("shortcuts.conflictDescription", {
					label: t(getShortcutCommand(conflictId).labelKey),
				}),
			});
			return;
		}
		if (!(await canUseShortcuts([next]))) return;
		setKeyboardShortcut(commandId, next);
		onStopRecording();
	};

	return (
		<div className={SHORTCUT_EDITOR_CLASS}>
			<button
				type="button"
				data-shortcut-recording={recording ? "true" : undefined}
				className={cn(
					SHORTCUT_INPUT_CLASS,
					recording
						? "border-ring bg-accent/60 ring-2 ring-ring/20"
						: "border-border/80 bg-background hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-ring/30",
				)}
				onClick={onStartRecording}
				onKeyDown={handleKeyDown}
				aria-label={t("shortcuts.change", {
					label: t(getShortcutCommand(commandId).labelKey),
				})}
			>
				{recording ? (
					<span className="text-xs text-muted-foreground">
						{t("settings.pressNewShortcut")}
					</span>
				) : shortcut ? (
					<ShortcutKeys shortcut={shortcut} />
				) : (
					<span className="text-xs text-muted-foreground">
						{t("shortcuts.unassigned")}
					</span>
				)}
			</button>
			<Hint label={isCustom ? t("settings.resetDefault") : undefined}>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className={cn(SHORTCUT_RESET_BUTTON_CLASS, !isCustom && "invisible")}
					disabled={!isCustom}
					onClick={resetShortcut}
					aria-label={t("shortcuts.reset", {
						label: t(getShortcutCommand(commandId).labelKey),
					})}
				>
					<RotateCcw className="size-3.5" />
				</Button>
			</Hint>
		</div>
	);
}

function DesktopShortcutSettings() {
	const configurationRevision = useConfigurationRevision();
	const { t } = useTranslation();
	const { keyboardShortcuts } = usePreferences();
	const [settings, setSettings] = useState<DesktopShortcutSettings | null>(
		null,
	);
	const [loadError, setLoadError] = useState(false);
	const [saving, setSaving] = useState(false);
	const [recording, setRecording] = useState(false);

	/* oxlint-disable react/exhaustive-effect-dependencies -- Host configuration revisions intentionally reload externally owned settings. */
	useEffect(() => {
		let active = true;
		void getDesktopShortcut().then(
			(value) => {
				if (active) setSettings(value);
			},
			(error) => {
				console.error("Failed to load desktop shortcut", error);
				if (active) setLoadError(true);
			},
		);
		return () => {
			active = false;
		};
	}, [configurationRevision]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	const retry = async () => {
		setLoadError(false);
		try {
			setSettings(await getDesktopShortcut());
		} catch (error) {
			console.error("Failed to load desktop shortcut", error);
			setLoadError(true);
		}
	};

	const save = async (shortcut: string) => {
		if (saving) return;
		const conflict = SHORTCUT_COMMANDS.find(
			(command) => keyboardShortcuts[command.id] === shortcut,
		);
		if (conflict) {
			toast.error(t("shortcuts.conflict"), {
				description: t("shortcuts.conflictDescription", {
					label: t(conflict.labelKey),
				}),
			});
			return;
		}
		setRecording(false);
		setSaving(true);
		try {
			setSettings(await setDesktopShortcut(shortcut));
		} catch (error) {
			console.error("Failed to save desktop shortcut", error);
			toast.error(t("desktop.shortcutSaveFailed"));
		} finally {
			setSaving(false);
		}
	};

	const record = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
		if (!recording) return;
		event.preventDefault();
		event.stopPropagation();
		if (event.key === "Escape") {
			setRecording(false);
			return;
		}
		if (event.repeat || event.nativeEvent.isComposing) return;
		const shortcut = desktopShortcutFromKeyboardEvent(event.nativeEvent);
		if (!shortcut) return;
		if (!isSafeGlobalShortcut(shortcut)) {
			toast.error(t("shortcuts.modifierRequired"), {
				description: t("shortcuts.modifierDescription"),
			});
			return;
		}
		void save(shortcut);
	};

	return (
		<SettingsSection
			title={t("desktop.globalShortcut")}
			className={SHORTCUT_SECTION_CLASS}
			contentClassName={SHORTCUT_SUBGRID_CLASS}
		>
			<SettingsRow
				label={t("desktop.show")}
				helper={t("desktop.shortcutHint")}
				className={SHORTCUT_SUBGRID_CLASS}
			>
				{loadError ? (
					<div role="alert" className="flex flex-wrap items-center gap-2">
						<span className="text-xs text-destructive">
							{t("desktop.shortcutLoadFailed")}
						</span>
						<Button variant="ghost" size="sm" onClick={() => void retry()}>
							{t("common.retry")}
						</Button>
					</div>
				) : (
					<div className={SHORTCUT_EDITOR_CLASS}>
						<Button
							type="button"
							variant="outline"
							className={SHORTCUT_INPUT_CLASS}
							disabled={!settings || saving}
							data-shortcut-recording={recording ? "true" : undefined}
							aria-label={t("shortcuts.change", { label: t("desktop.show") })}
							onClick={() => setRecording(true)}
							onBlur={() => setRecording(false)}
							onKeyDown={record}
						>
							{recording ? (
								t("settings.pressNewShortcut")
							) : settings ? (
								<ShortcutKeys shortcut={settings.shortcut} />
							) : (
								t("common.loading")
							)}
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className={SHORTCUT_RESET_BUTTON_CLASS}
							disabled={
								!settings ||
								saving ||
								settings.shortcut === DEFAULT_DESKTOP_SHORTCUT
							}
							aria-label={t("shortcuts.reset", { label: t("desktop.show") })}
							onClick={() => void save(DEFAULT_DESKTOP_SHORTCUT)}
						>
							<RotateCcw className="size-3.5" />
						</Button>
						{settings && !settings.registered ? (
							<div
								aria-live="polite"
								className="col-span-full flex flex-wrap items-center gap-2"
							>
								<span className="text-xs text-destructive">
									{t("desktop.shortcutUnavailable")}
								</span>
								<Button
									variant="ghost"
									size="sm"
									disabled={saving}
									onClick={() => void save(settings.shortcut)}
								>
									{t("common.retry")}
								</Button>
							</div>
						) : null}
					</div>
				)}
			</SettingsRow>
		</SettingsSection>
	);
}

export function KeyboardShortcutsSettings() {
	const { t } = useTranslation();
	const {
		sendMessageShortcut,
		setSendMessageShortcut,
		keyboardShortcuts,
		resetKeyboardShortcuts,
	} = usePreferences();
	const [recordingCommandId, setRecordingCommandId] =
		useState<ShortcutCommandId | null>(null);
	const hasCustomShortcut =
		sendMessageShortcut !== "enter" ||
		SHORTCUT_COMMANDS.some(
			(command) =>
				keyboardShortcuts[command.id] !==
				DEFAULT_KEYBOARD_SHORTCUTS[command.id],
		);
	const newlineKeys = sendMessageShortcut === "enter" ? "shift+enter" : "enter";

	const canUseShortcuts = async (shortcuts: readonly string[]) => {
		try {
			if (!(await hasDesktopShortcutConflict(shortcuts))) return true;
			toast.error(t("shortcuts.conflict"), {
				description: t("shortcuts.conflictDescription", {
					label: t("desktop.show"),
				}),
			});
		} catch (error) {
			console.error("Failed to check desktop shortcut", error);
			toast.error(t("desktop.shortcutLoadFailed"));
		}
		return false;
	};

	return (
		<div
			className={cn(
				SETTINGS_CONTAINER_CLASS,
				"sm:grid sm:grid-cols-[minmax(min-content,1fr)_minmax(0,max-content)]",
			)}
		>
			{isDesktopIntegrationAvailable() ? <DesktopShortcutSettings /> : null}
			{(["app", "session"] as const).map((section, sectionIndex) => (
				<SettingsSection
					key={section}
					className={SHORTCUT_SECTION_CLASS}
					contentClassName={SHORTCUT_SUBGRID_CLASS}
					title={t(
						section === "app"
							? "settings.shortcutApp"
							: "settings.shortcutSession",
					)}
					actions={
						sectionIndex === 0 ? (
							<Hint
								label={
									hasCustomShortcut ? t("settings.resetAllDefaults") : undefined
								}
							>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className={SHORTCUT_RESET_BUTTON_CLASS}
									disabled={!hasCustomShortcut}
									onClick={async () => {
										if (
											!(await canUseShortcuts(
												Object.values(DEFAULT_KEYBOARD_SHORTCUTS),
											))
										)
											return;
										resetKeyboardShortcuts();
										setSendMessageShortcut("enter");
										setRecordingCommandId(null);
									}}
									aria-label={t("settings.resetAllDefaults")}
								>
									<RotateCcw className="size-3.5" />
								</Button>
							</Hint>
						) : undefined
					}
				>
					{SHORTCUT_COMMANDS.filter(
						(command) => command.section === section,
					).map((command) => (
						<SettingsRow
							key={command.id}
							label={t(command.labelKey)}
							className={SHORTCUT_SUBGRID_CLASS}
						>
							<ShortcutEditor
								commandId={command.id}
								canUseShortcuts={canUseShortcuts}
								recording={recordingCommandId === command.id}
								onStartRecording={() => setRecordingCommandId(command.id)}
								onStopRecording={() => setRecordingCommandId(null)}
							/>
						</SettingsRow>
					))}
				</SettingsSection>
			))}

			<SettingsSection
				title={t("settings.shortcutInput")}
				className={SHORTCUT_SECTION_CLASS}
				contentClassName={SHORTCUT_SUBGRID_CLASS}
			>
				<SettingsRow
					label={t("settings.newline")}
					className={SHORTCUT_SUBGRID_CLASS}
				>
					<div className={SHORTCUT_EDITOR_CLASS}>
						<div className={cn(SHORTCUT_INPUT_CLASS, "border-transparent")}>
							<ShortcutKeys shortcut={newlineKeys} />
						</div>
						<span aria-hidden="true" className={SHORTCUT_RESET_BUTTON_CLASS} />
					</div>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

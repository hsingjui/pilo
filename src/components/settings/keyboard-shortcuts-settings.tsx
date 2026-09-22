import { useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
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
import { cn } from "@/lib/utils";
import { Button, Hint } from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SettingsRow,
	SettingsSection,
} from "./compact-layout";

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
}: {
	commandId: ShortcutCommandId;
	recording: boolean;
	onStartRecording: () => void;
	onStopRecording: () => void;
}) {
	const { keyboardShortcuts, setKeyboardShortcut, resetKeyboardShortcut } =
		usePreferences();
	const shortcut = keyboardShortcuts[commandId];
	const isCustom = shortcut !== DEFAULT_KEYBOARD_SHORTCUTS[commandId];
	const resetShortcut = () => {
		const defaultShortcut = DEFAULT_KEYBOARD_SHORTCUTS[commandId];
		const conflictId = findShortcutConflict(
			keyboardShortcuts,
			commandId,
			defaultShortcut,
		);
		if (conflictId) {
			toast.error("默认快捷键已被占用", {
				description: `“${getShortcutCommand(conflictId).label}”正在使用这个组合键。可先恢复全部默认快捷键。`,
			});
			return;
		}
		resetKeyboardShortcut(commandId);
	};

	const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
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
			toast.error("快捷键需要包含修饰键", {
				description: "请使用 Ctrl、⌘、Alt、Shift 等组合键，或 F1–F12。",
			});
			return;
		}
		const conflictId = findShortcutConflict(keyboardShortcuts, commandId, next);
		if (conflictId) {
			toast.error("快捷键冲突", {
				description: `已被“${getShortcutCommand(conflictId).label}”使用，请换一个组合键。`,
			});
			return;
		}
		setKeyboardShortcut(commandId, next);
		onStopRecording();
	};

	return (
		<div className="flex items-center gap-1.5">
			<button
				type="button"
				data-shortcut-recording={recording ? "true" : undefined}
				className={cn(
					"min-w-[132px] shrink-0 whitespace-nowrap rounded-md border px-2.5 py-1.5 text-left transition-colors outline-none",
					recording
						? "border-ring bg-accent/60 ring-2 ring-ring/20"
						: "border-border/80 bg-background hover:bg-muted/55 focus-visible:ring-2 focus-visible:ring-ring/30",
				)}
				onClick={onStartRecording}
				onKeyDown={handleKeyDown}
				aria-label={`修改${getShortcutCommand(commandId).label}快捷键`}
			>
				{recording ? (
					<span className="text-xs text-muted-foreground">按下新快捷键…</span>
				) : (
					<ShortcutKeys shortcut={shortcut} />
				)}
			</button>
			<Hint label={isCustom ? "恢复默认" : undefined}>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className={cn("size-7", !isCustom && "invisible")}
					disabled={!isCustom}
					onClick={resetShortcut}
					aria-label={`恢复${getShortcutCommand(commandId).label}默认快捷键`}
				>
					<RotateCcw className="size-3.5" />
				</Button>
			</Hint>
		</div>
	);
}

export function KeyboardShortcutsSettings() {
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

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			{(["应用", "会话"] as const).map((section, sectionIndex) => (
				<SettingsSection
					key={section}
					title={section}
					actions={
						sectionIndex === 0 ? (
							<Hint
								label={hasCustomShortcut ? "恢复全部默认快捷键" : undefined}
							>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									disabled={!hasCustomShortcut}
									onClick={() => {
										resetKeyboardShortcuts();
										setSendMessageShortcut("enter");
										setRecordingCommandId(null);
									}}
									aria-label="恢复全部默认快捷键"
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
						<SettingsRow key={command.id} label={command.label}>
							<ShortcutEditor
								commandId={command.id}
								recording={recordingCommandId === command.id}
								onStartRecording={() => setRecordingCommandId(command.id)}
								onStopRecording={() => setRecordingCommandId(null)}
							/>
						</SettingsRow>
					))}
				</SettingsSection>
			))}

			<SettingsSection title="输入框">
				<SettingsRow label="换行">
					<ShortcutKeys shortcut={newlineKeys} />
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

import {
	defaultKeyboardShortcuts,
	findShortcutConflict as findShortcutConflictForPlatform,
	isSafeGlobalShortcut as isSafeGlobalShortcutForPlatform,
	normalizeKeyboardShortcut as normalizeKeyboardShortcutForPlatform,
	shortcutFromKeyEvent,
	type ShortcutKeyEvent,
} from "@shared/keyboard-shortcuts-core";
import { formatKeyboardShortcutLabels } from "@shared/keyboard-shortcuts-format";
import {
	SHORTCUT_COMMANDS,
	type KeyboardShortcutMap,
	type ShortcutCommandId,
} from "@shared/keyboard-shortcuts-types";

export { getShortcutCommand } from "@shared/keyboard-shortcuts-core";
export {
	SHORTCUT_COMMANDS,
	type KeyboardShortcutMap,
	type ShortcutCommandId,
} from "@shared/keyboard-shortcuts-types";

function isMacPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

export function normalizeKeyboardShortcut(value: unknown): string | null {
	return normalizeKeyboardShortcutForPlatform(value, isMacPlatform());
}

export const DEFAULT_KEYBOARD_SHORTCUTS = Object.freeze(
	defaultKeyboardShortcuts(isMacPlatform()),
);

export function isSafeGlobalShortcut(shortcut: string): boolean {
	return isSafeGlobalShortcutForPlatform(shortcut, isMacPlatform());
}

export function normalizeKeyboardShortcutMap(
	value: unknown,
): KeyboardShortcutMap {
	const defaults = { ...DEFAULT_KEYBOARD_SHORTCUTS };
	if (!value || typeof value !== "object" || Array.isArray(value))
		return defaults;

	const source = value as Record<string, unknown>;
	const next = { ...defaults };
	const assigned = new Set<string>();
	// Reserve saved bindings before filling defaults for newly added commands.
	for (const command of SHORTCUT_COMMANDS) {
		const normalized = normalizeKeyboardShortcut(source[command.id]);
		next[command.id] = "";
		if (normalized && isSafeGlobalShortcut(normalized)) {
			if (assigned.has(normalized)) return defaults;
			next[command.id] = normalized;
			assigned.add(normalized);
		}
	}

	for (const command of SHORTCUT_COMMANDS) {
		if (next[command.id] || source[command.id] === "") continue;
		const shortcut = defaults[command.id];
		if (!assigned.has(shortcut)) {
			next[command.id] = shortcut;
			assigned.add(shortcut);
		}
	}
	return next;
}

export function shortcutFromKeyboardEvent(
	event: ShortcutKeyEvent,
): string | null {
	return shortcutFromKeyEvent(event, isMacPlatform());
}

export function keyboardEventMatchesShortcut(
	event: ShortcutKeyEvent,
	shortcut: string,
): boolean {
	const expected = normalizeKeyboardShortcut(shortcut);
	return expected !== null && shortcutFromKeyboardEvent(event) === expected;
}

export function findShortcutConflict(
	shortcuts: KeyboardShortcutMap,
	commandId: ShortcutCommandId,
	shortcut: string,
): ShortcutCommandId | null {
	return findShortcutConflictForPlatform(
		shortcuts,
		commandId,
		shortcut,
		isMacPlatform(),
	);
}

export function formatKeyboardShortcut(shortcut: string): string[] {
	const normalized = normalizeKeyboardShortcut(shortcut);
	if (!normalized) return [];
	return formatKeyboardShortcutLabels(normalized, isMacPlatform());
}

export function formatKeyboardShortcutText(shortcut: string): string {
	return formatKeyboardShortcut(shortcut).join(" + ");
}

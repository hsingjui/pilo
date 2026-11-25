import { keymap, platform } from "nsh";
import {
	isSafeGlobalShortcut,
	normalizeKeyboardShortcut,
} from "@shared/keyboard-shortcuts-core";
import type { ShortcutCommandId } from "@shared/keyboard-shortcuts-types";

/** nsh's built-in bindings, reserved from the system-wide show shortcut. */
export const APP_SHORTCUTS = {
	openCommandPalette: "mod+k",
	newChat: "mod+n",
	openSettings: "mod+,",
	// Reserve even in Enter mode so changing the send preference stays safe.
	sendMessage: "mod+enter",
} as const;

/** Adapt DOM-style saved keys to nsh without changing what WebUI reads. */
export function nshAppShortcut(value: string, isMac: boolean): string | null {
	const shortcut = normalizeKeyboardShortcut(value, isMac);
	if (!shortcut) return null;
	const tokens = shortcut.split("+");
	const key = tokens.pop()!;
	const shifted = '~!@#$%^&*()_{}|:"<>?';
	const base = "`1234567890-[]\\;',./";
	const unshifted = tokens.includes("shift")
		? base[shifted.indexOf(key)]
		: undefined;
	return [
		...tokens,
		unshifted ?? key.replace(/^arrow(up|down|left|right)$/, "$1"),
	].join("+");
}

/** Keep the fixed send binding free even while plain Enter is selected. */
export function isReservedSendShortcut(shortcut: string): boolean {
	return keymap.label(shortcut) === keymap.label(APP_SHORTCUTS.sendMessage);
}

export interface AppShortcutBinding {
	shortcut: string;
	dispose: () => void;
}

export function bindAppShortcut(
	id: ShortcutCommandId,
	value: string,
	handler: () => void,
	overFocused = false,
): AppShortcutBinding | undefined {
	const isMac = platform.os === "macos";
	const shortcut = nshAppShortcut(value, isMac);
	if (!shortcut) return;
	try {
		if (isReservedSendShortcut(shortcut)) return;
		return {
			shortcut,
			dispose: keymap.bind(shortcut, handler, {
				when: "always",
				// Plain editing and navigation keys keep the focused view's priority.
				overFocused: overFocused && isSafeGlobalShortcut(value, isMac),
			}),
		};
	} catch (error) {
		// A binding saved by another client may not be valid on nsh.
		console.warn(`Skipping unsupported shortcut for ${id}`, error);
	}
}

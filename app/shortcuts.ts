import { keymap, platform } from "nsh";
import { normalizeKeyboardShortcut } from "@shared/keyboard-shortcuts-core";
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

export function bindAppShortcut(
	id: ShortcutCommandId,
	value: string,
	handler: () => void,
) {
	const shortcut = nshAppShortcut(value, platform.os === "macos");
	if (!shortcut) return;
	try {
		if (isReservedSendShortcut(shortcut)) return;
		return {
			shortcut,
			dispose: keymap.bind(shortcut, handler, { when: "always" }),
		};
	} catch (error) {
		// A binding saved by another client may not be valid on nsh.
		console.warn(`Skipping unsupported shortcut for ${id}`, error);
	}
}

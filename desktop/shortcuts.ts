import { normalizeKeyboardShortcut } from "@shared/keyboard-shortcuts-core";

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
	if (!tokens.includes("shift")) return shortcut;
	const key = tokens.pop()!;
	const shifted = '~!@#$%^&*()_{}|:"<>?';
	const base = "`1234567890-[]\\;',./";
	return [...tokens, base[shifted.indexOf(key)] ?? key].join("+");
}

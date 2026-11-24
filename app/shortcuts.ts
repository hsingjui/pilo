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

export interface AppShortcutBinding {
	shortcut: string;
	handler: () => void;
	dispose: () => void;
}

/** Convert a validated nsh key to the RichEditor plugin's key vocabulary. */
export function richEditorShortcut(shortcut: string): string {
	const modifiers = shortcut.split("+");
	const key = modifiers.pop()!;
	const names: Record<string, string> = {
		up: "ArrowUp",
		down: "ArrowDown",
		left: "ArrowLeft",
		right: "ArrowRight",
		pageup: "PageUp",
		pagedown: "PageDown",
		del: "Delete",
		plus: "=",
		minus: "-",
	};
	const name =
		names[key] ??
		(key.length === 1 ? key : key[0].toUpperCase() + key.slice(1));
	return [...modifiers, name].join("-");
}

export function bindAppShortcut(
	id: ShortcutCommandId,
	value: string,
	handler: () => void,
): AppShortcutBinding | undefined {
	const shortcut = nshAppShortcut(value, platform.os === "macos");
	if (!shortcut) return;
	try {
		if (isReservedSendShortcut(shortcut)) return;
		return {
			shortcut,
			handler,
			dispose: keymap.bind(shortcut, handler, { when: "always" }),
		};
	} catch (error) {
		// A binding saved by another client may not be valid on nsh.
		console.warn(`Skipping unsupported shortcut for ${id}`, error);
	}
}

/**
 * Platform-independent shortcut normalization, capture and conflict helpers.
 *
 * `keyboard-shortcuts.ts` wraps these for the DOM frontend (it derives `isMac`
 * from `navigator`); the nsh desktop calls them with `platform.os === "macos"`,
 * so this module must stay free of DOM globals.
 */
import {
	SHORTCUT_COMMANDS,
	type KeyboardShortcutMap,
	type ShortcutCommandId,
} from "./keyboard-shortcuts-types";

const MODIFIERS = new Set(["mod", "ctrl", "meta", "alt", "shift"]);
const MODIFIER_ORDER = ["mod", "ctrl", "meta", "alt", "shift"] as const;
const MODIFIER_KEYS = new Set([
	"Control",
	"Meta",
	"Alt",
	"Shift",
	"OS",
	"AltGraph",
]);

function normalizeKeyToken(value: string): string {
	const key = value.trim();
	if (!key) return "";
	const lower = key.toLowerCase();
	const aliases: Record<string, string> = {
		cmd: "mod",
		command: "mod",
		control: "ctrl",
		option: "alt",
		return: "enter",
		esc: "escape",
		" ": "space",
		spacebar: "space",
		up: "arrowup",
		down: "arrowdown",
		left: "arrowleft",
		right: "arrowright",
	};
	return aliases[lower] ?? lower;
}

export function normalizeKeyboardShortcut(
	value: unknown,
	isMac: boolean,
): string | null {
	if (typeof value !== "string") return null;
	const rawTokens = value.split("+").map(normalizeKeyToken).filter(Boolean);
	if (rawTokens.length === 0) return null;

	const modifiers = new Set<string>();
	let key = "";
	for (const token of rawTokens) {
		if (MODIFIERS.has(token)) {
			modifiers.add(token);
			continue;
		}
		if (key) return null;
		key = token;
	}
	if (!key) return null;

	const orderedModifiers = MODIFIER_ORDER.filter((modifier) =>
		modifiers.has(modifier),
	);
	// Windows / Linux 上物理 Ctrl 就是应用修饰键，快捷键统一落为 "mod"；
	// "ctrl" token 只有 macOS（Ctrl 不带 Cmd）会产生，直接存会在 Windows 上永不匹配。
	const resolvedModifiers = isMac
		? orderedModifiers
		: orderedModifiers.map((modifier) =>
				modifier === "ctrl" ? "mod" : modifier,
			);
	return [...resolvedModifiers, key].join("+");
}

export function defaultKeyboardShortcuts(isMac: boolean): KeyboardShortcutMap {
	return Object.fromEntries(
		SHORTCUT_COMMANDS.map((command) => [
			command.id,
			normalizeKeyboardShortcut(command.defaultShortcut, isMac) ??
				command.defaultShortcut,
		]),
	) as KeyboardShortcutMap;
}

export function isSafeGlobalShortcut(
	shortcut: string,
	isMac: boolean,
): boolean {
	const normalized = normalizeKeyboardShortcut(shortcut, isMac);
	if (!normalized) return false;
	const tokens = normalized.split("+");
	const key = tokens[tokens.length - 1] ?? "";
	if (/^f(?:[1-9]|1[0-2])$/.test(key)) return true;
	return tokens.slice(0, -1).some((modifier) => modifier !== "shift");
}

export function findShortcutConflict(
	shortcuts: KeyboardShortcutMap,
	commandId: ShortcutCommandId,
	shortcut: string,
	isMac: boolean,
): ShortcutCommandId | null {
	const normalized = normalizeKeyboardShortcut(shortcut, isMac);
	if (!normalized) return null;
	for (const command of SHORTCUT_COMMANDS) {
		if (command.id === commandId) continue;
		if (normalizeKeyboardShortcut(shortcuts[command.id], isMac) === normalized)
			return command.id;
	}
	return null;
}

/** Structural shape so callers need no DOM `KeyboardEvent` (nsh has none). */
export interface ShortcutKeyEvent {
	key: string;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	shiftKey: boolean;
}

export function shortcutFromKeyEvent(
	event: ShortcutKeyEvent,
	isMac: boolean,
): string | null {
	if (MODIFIER_KEYS.has(event.key)) return null;
	const tokens: string[] = [];
	if ((isMac && event.metaKey) || (!isMac && event.ctrlKey)) tokens.push("mod");
	if (isMac && event.ctrlKey) tokens.push("ctrl");
	if (!isMac && event.metaKey) tokens.push("meta");
	if (event.altKey) tokens.push("alt");
	if (event.shiftKey) tokens.push("shift");

	const key = normalizeKeyToken(event.key === " " ? "space" : event.key);
	if (!key || MODIFIERS.has(key)) return null;
	return normalizeKeyboardShortcut([...tokens, key].join("+"), isMac);
}

export function getShortcutCommand(commandId: ShortcutCommandId) {
	return SHORTCUT_COMMANDS.find((command) => command.id === commandId)!;
}

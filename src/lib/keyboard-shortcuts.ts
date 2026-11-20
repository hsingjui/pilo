import { formatKeyboardShortcutLabels } from "./keyboard-shortcuts-format";
import {
	SHORTCUT_COMMANDS,
	type KeyboardShortcutMap,
	type ShortcutCommandId,
} from "./keyboard-shortcuts-types";

export {
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

function isMacPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

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

export function normalizeKeyboardShortcut(value: unknown): string | null {
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
	const resolvedModifiers = isMacPlatform()
		? orderedModifiers
		: orderedModifiers.map((modifier) =>
				modifier === "ctrl" ? "mod" : modifier,
			);
	return [...resolvedModifiers, key].join("+");
}

export const DEFAULT_KEYBOARD_SHORTCUTS = Object.freeze(
	Object.fromEntries(
		SHORTCUT_COMMANDS.map((command) => [
			command.id,
			normalizeKeyboardShortcut(command.defaultShortcut) ??
				command.defaultShortcut,
		]),
	) as KeyboardShortcutMap,
);

export function isSafeGlobalShortcut(shortcut: string): boolean {
	const normalized = normalizeKeyboardShortcut(shortcut);
	if (!normalized) return false;
	const tokens = normalized.split("+");
	const key = tokens[tokens.length - 1] ?? "";
	if (/^f(?:[1-9]|1[0-2])$/.test(key)) return true;
	return tokens.slice(0, -1).some((modifier) => modifier !== "shift");
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
	event: Pick<
		KeyboardEvent,
		"key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
	>,
): string | null {
	if (MODIFIER_KEYS.has(event.key)) return null;
	const isMac = isMacPlatform();
	const tokens: string[] = [];
	if ((isMac && event.metaKey) || (!isMac && event.ctrlKey)) tokens.push("mod");
	if (isMac && event.ctrlKey) tokens.push("ctrl");
	if (!isMac && event.metaKey) tokens.push("meta");
	if (event.altKey) tokens.push("alt");
	if (event.shiftKey) tokens.push("shift");

	const key = normalizeKeyToken(event.key === " " ? "space" : event.key);
	if (!key || MODIFIERS.has(key)) return null;
	return normalizeKeyboardShortcut([...tokens, key].join("+"));
}

export function keyboardEventMatchesShortcut(
	event: Pick<
		KeyboardEvent,
		"key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
	>,
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
	const normalized = normalizeKeyboardShortcut(shortcut);
	if (!normalized) return null;
	for (const command of SHORTCUT_COMMANDS) {
		if (command.id === commandId) continue;
		if (normalizeKeyboardShortcut(shortcuts[command.id]) === normalized) {
			return command.id;
		}
	}
	return null;
}

export function formatKeyboardShortcut(shortcut: string): string[] {
	const normalized = normalizeKeyboardShortcut(shortcut);
	if (!normalized) return [];
	return formatKeyboardShortcutLabels(normalized, isMacPlatform());
}

export function formatKeyboardShortcutText(shortcut: string): string {
	return formatKeyboardShortcut(shortcut).join(" + ");
}

export function getShortcutCommand(commandId: ShortcutCommandId) {
	return SHORTCUT_COMMANDS.find((command) => command.id === commandId)!;
}

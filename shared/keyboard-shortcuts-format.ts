/**
 * The display labels of a normalized keystroke's tokens, by platform.
 *
 * Shared so the nsh desktop (no DOM `navigator`) and WebUI format keys identically:
 * the caller passes `isMac` (`platform.os === "macos"`).
 */
export function formatKeyboardShortcutLabels(
	shortcut: string,
	isMac: boolean,
): string[] {
	return shortcut
		.split("+")
		.map((raw) => raw.trim())
		.filter(Boolean)
		.map((token) => {
			if (token === "mod") return isMac ? "⌘" : "Ctrl";
			if (token === "ctrl") return isMac ? "⌃" : "Ctrl";
			if (token === "meta") return isMac ? "⌘" : "Win";
			if (token === "alt") return isMac ? "⌥" : "Alt";
			if (token === "shift") return isMac ? "⇧" : "Shift";
			const labels: Record<string, string> = {
				enter: "Enter",
				escape: "Esc",
				space: "Space",
				tab: "Tab",
				backspace: "Backspace",
				delete: "Delete",
				arrowup: "↑",
				arrowdown: "↓",
				arrowleft: "←",
				arrowright: "→",
			};
			return (
				labels[token] ?? (token.length === 1 ? token.toUpperCase() : token)
			);
		});
}

export const SHORTCUT_COMMANDS = [
	{
		id: "new-chat",
		section: "app",
		labelKey: "shortcuts.newChat",
		defaultShortcut: "mod+n",
	},
	{
		id: "toggle-sidebar",
		section: "app",
		labelKey: "shortcuts.toggleSidebar",
		defaultShortcut: "mod+b",
	},
	{
		id: "open-settings",
		section: "app",
		labelKey: "shortcuts.openSettings",
		defaultShortcut: "mod+,",
	},
	{
		id: "open-command-palette",
		section: "app",
		labelKey: "shortcuts.openCommandPalette",
		defaultShortcut: "mod+k",
	},
	{
		id: "cycle-model",
		section: "session",
		labelKey: "shortcuts.cycleModel",
		defaultShortcut: "mod+shift+m",
	},
	{
		id: "cycle-scoped-model",
		section: "session",
		labelKey: "shortcuts.cycleScopedModel",
		defaultShortcut: "ctrl+p",
	},
	{
		id: "focus-composer",
		section: "session",
		labelKey: "shortcuts.focusComposer",
		defaultShortcut: "mod+l",
	},
	{
		id: "queue-message",
		section: "session",
		labelKey: "shortcuts.queueMessage",
		defaultShortcut: "alt+enter",
	},
] as const;

export type ShortcutCommandId = (typeof SHORTCUT_COMMANDS)[number]["id"];
// An empty string means the command has no shortcut assigned.
export type KeyboardShortcutMap = Record<ShortcutCommandId, string>;

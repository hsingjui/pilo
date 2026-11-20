/** nsh's built-in bindings, reserved from the system-wide show shortcut. */
export const APP_SHORTCUTS = {
	openCommandPalette: "mod+k",
	newChat: "mod+n",
	openSettings: "mod+,",
	// Reserve even in Enter mode so changing the send preference stays safe.
	sendMessage: "mod+enter",
} as const;

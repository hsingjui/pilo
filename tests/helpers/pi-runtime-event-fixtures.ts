import type { PiloRuntimeEvent } from "../../shared/api/pi-runtime-types.ts";

export const runtimeEvents = [
	{
		type: "preferences_changed",
		timestampMs: 100,
		settings: {
			revision: 1,
			values: {
				locale: "zh-CN",
				defaultWorkspaceVisibility: { local: true },
				sendMessageShortcut: "mod-enter",
				keyboardShortcuts: {
					"new-chat": "mod+n",
					"toggle-sidebar": "mod+b",
					"open-settings": "mod+,",
					"open-command-palette": "mod+k",
					"cycle-model": "mod+shift+m",
					"cycle-scoped-model": "ctrl+p",
					"focus-composer": "mod+l",
					"queue-message": "",
				},
				collapseCompletedActivity: true,
				collapseLongMessages: true,
				showWorkDuration: false,
				showPluginNotifications: true,
				desktopNotifications: true,
				developerMode: false,
				pageFontFamily: "system-sans",
				uiFontSize: 15,
				readingFontFamily: "inter",
				readingFontSize: 16,
				codeFontFamily: "jetbrains-mono",
				codeFontSize: 14,
				terminalFontFamily: "system-mono",
				terminalFontSize: 14,
			},
		},
	},
	{
		type: "theme_settings_changed",
		settings: {
			revision: 2,
			theme: "dark",
			themeFamily: "custom",
			themeCustomCss: ":root {}",
			themeCustomTokens: {},
			themeCustomName: "Custom",
			savedCustomThemes: [{ name: "Custom", css: ":root {}", tokens: {} }],
		},
	},
	{
		type: "external_session_activity_changed",
		projectId: "project",
		activities: [{ path: "/sessions/example.jsonl", turnOpen: true }],
	},
	{
		type: "next_prompt_settings_changed",
		settings: {
			connectionId: "local",
			enabled: true,
			model: { provider: "provider", id: "model" },
			updatedAtMs: 102,
		},
	},
	{
		type: "prompt_enhancement_settings_changed",
		settings: {
			connectionId: "local",
			enabled: true,
			model: null,
			updatedAtMs: 103,
		},
	},
	{
		type: "assistant_text_delta",
		sessionKey: "session",
		generation: 1,
		delta: "hello",
	},
] satisfies PiloRuntimeEvent[];

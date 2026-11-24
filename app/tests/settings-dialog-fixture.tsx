import { host, mount, setTheme, signal, Storage, Text, View } from "nsh";

import type { Connection } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { PreferencesSnapshot } from "@shared/host-preferences-types";
import {
	type KeyboardShortcutMap,
	SHORTCUT_COMMANDS,
} from "@shared/keyboard-shortcuts-types";
import type { ThemeSettings } from "@shared/theme-settings-types";
import { AppShell } from "../shell/AppShell";
import { conversationContext, followOpenSession } from "../shell/open-chat";
import { initializeI18n } from "../shell/i18n";
import { AppStore } from "../state/app-store";
import { ComposerStore } from "../composer/composer-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { setStyleTheme } from "../ui/theme-style";
import claude from "../../theme/claude-theme.json";
import lody from "../../theme/theme.json";
import { composerStubClient } from "./composer-fixture";
import { fixtureThemeFamily } from "./fixture-theme";
import { HOST_DEFAULT_VALUES, scriptedClient } from "./scripted-app-client";

/**
 * The shell over a scripted client with its settings wired, for the settings
 * dialog: `settings-probe` echoes a saved preference so a test sees a write
 * land, the theme buttons swap Lody and Claude for screenshots, and the
 * `host.on("fixture", ...)` events emit scripted settings events / write the
 * keep-alive rows to storage so a test can drive them behind the modal
 * dialog on every target.
 */
const local = { id: "local", name: "Local", kind: { type: "local" } };

const project = {
	id: "pilo",
	name: "pilo",
	path: "/code/pilo",
	connection: local as Connection,
} as Project;

async function run() {
	const themeSettings = {
		revision: 1,
		theme: "system",
		themeFamily: await fixtureThemeFamily(),
	} as ThemeSettings;
	const keyboardShortcuts = {
		...Object.fromEntries(
			SHORTCUT_COMMANDS.map((command) => [command.id, command.defaultShortcut]),
		),
		// Two custom bindings keep the row and header resets pressable.
		"new-chat": "mod+shift+p",
		"toggle-sidebar": "mod+shift+o",
	} as KeyboardShortcutMap;
	const preferences = {
		revision: 1,
		values: {
			...HOST_DEFAULT_VALUES,
			keyboardShortcuts,
		},
	} as PreferencesSnapshot;
	const models = [
		{
			id: "claude-sonnet-4",
			name: "Claude Sonnet 4",
			provider: "anthropic",
			reasoning: true,
		},
		{
			id: "gpt-5-mini",
			name: "GPT-5 mini",
			provider: "openai",
			reasoning: false,
		},
	];
	const runtime = scriptedClient({
		projects: [project],
		preferences,
		themeSettings,
		connectionModels: { local: models },
		models: {
			pilo: {
				projectId: "pilo",
				models,
				commands: null,
				defaultModel: null,
				defaultThinkingLevel: null,
				refreshedAtMs: Date.now(),
			},
		},
		namingModels: [
			{
				connectionId: "local",
				provider: "anthropic",
				modelId: "claude-sonnet-4",
			},
		],
		nextPrompt: {
			local: {
				connectionId: "local",
				enabled: true,
				model: { provider: "anthropic", id: "claude-sonnet-4" },
				updatedAtMs: 1,
			},
		},
		promptEnhancement: {
			local: {
				connectionId: "local",
				enabled: false,
				model: null,
				updatedAtMs: 1,
			},
		},
		cacheKeepAlive: {
			local: [
				{
					connectionId: "local",
					provider: "anthropic",
					modelId: "claude-sonnet-4",
					enabled: true,
					cacheTtlSeconds: 300,
					idleKeepAliveSeconds: 1800,
					updatedAtMs: 1,
				},
			],
		},
		localConnection: {
			id: "local",
			name: "Local",
			kind: { type: "local" },
			piExecutable: "pi",
			piRuntime: "workspace",
			shownInHome: true,
		},
		sshConnections: [
			{
				connection: {
					id: "ssh:prod",
					name: "prod-server",
					kind: {
						type: "ssh",
						target: {
							type: "direct",
							hostname: "prod.example.com",
							port: 22,
							user: "deploy",
							identityFile: null,
							authMethod: "agent",
							proxyJump: null,
						},
					},
					piRuntime: "workspace",
					shownInHome: true,
				},
				projectCount: 2,
				hasPassword: false,
				localPiResources: true,
			},
		],
		wslConnections: [
			{
				connection: {
					id: "wsl:Ubuntu",
					name: "WSL · Ubuntu",
					kind: { type: "wsl", distro: "Ubuntu" },
					piRuntime: "workspace",
					shownInHome: true,
				},
				projectCount: 1,
			},
		],
		wslDistributions: [{ name: "Ubuntu" }, { name: "Debian" }],
		sshAgentIdentities: [
			{
				publicKey: "ssh-ed25519 AAAA test",
				fingerprint: "SHA256:abc123",
				comment: "jui@mac",
			},
		],
	});
	host.on("fixture", (name) => {
		if (name === "emit-next-prompt")
			runtime.emit({
				type: "next_prompt_settings_changed",
				settings: {
					connectionId: "local",
					enabled: true,
					model: { provider: "openai", id: "gpt-5-mini" },
					updatedAtMs: Date.now(),
				},
			});
		if (name === "emit-keep-alive")
			runtime.emit({
				type: "cache_keep_alive_settings_changed",
				settings: {
					connectionId: "local",
					provider: "anthropic",
					modelId: "claude-sonnet-4",
					enabled: true,
					cacheTtlSeconds: 600,
					idleKeepAliveSeconds: 1800,
					updatedAtMs: Date.now(),
				},
			});
		if (name === "probe-shortcuts")
			void Storage.setItem(
				"shortcut-patches",
				JSON.stringify(runtime.preferencePatches),
			);
		if (name === "probe-keep-alive")
			void Storage.removeItem("keep-alive-probe")
				.then(() => runtime.client.loadCacheKeepAliveSettings("local"))
				.then((rows) =>
					Storage.setItem(
						"keep-alive-probe",
						rows
							.map(
								(row) =>
									`${row.modelId}:${row.enabled}:${row.cacheTtlSeconds}:${row.idleKeepAliveSeconds}`,
							)
							.join(","),
					),
				);
	});
	const chat = new ChatTranscriptStore(runtime.client, conversationContext());
	const store = new AppStore(runtime.client, chat);
	const composer = new ComposerStore({
		client: composerStubClient(runtime.client),
		app: store.state,
	});
	followOpenSession(store, chat);
	mount(() => (
		<View class="flex-1 bg-background">
			<AppShell
				store={store}
				chat={chat}
				composer={composer}
				searchSessions={runtime.client}
				settings={runtime.client}
			/>
			<View class="absolute bottom-2 right-2 flex-row items-center gap-2">
				<Text testID="settings-probe">
					{() =>
						String(
							store.state().preferences?.values.collapseLongMessages ?? "unset",
						)
					}
				</Text>
				<Button
					testID="lody-theme"
					onPress={() => {
						setTheme({ cssVars: lody.cssVars });
						setStyleTheme(null);
					}}
				>
					<Text>Lody</Text>
				</Button>
				<Button
					testID="claude-theme"
					onPress={() => {
						setTheme({ cssVars: claude.cssVars });
						setStyleTheme(claude.styleVars);
					}}
				>
					<Text>Claude</Text>
				</Button>
			</View>
		</View>
	));
	await store.start();
}

initializeI18n();
void run();

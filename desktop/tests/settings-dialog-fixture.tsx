import { mount, setTheme, Text, View } from "nsh";

import type { Connection } from "@/lib/api/pi-runtime-types";
import type { Project } from "@/lib/api/projects-types";
import type { PreferencesSnapshot } from "@/lib/host-preferences-types";
import {
	type KeyboardShortcutMap,
	SHORTCUT_COMMANDS,
} from "@/lib/keyboard-shortcuts-types";
import type { ThemeSettings } from "@/lib/theme-settings-types";
import "../app/fonts";
import { AppShell } from "../app/AppShell";
import { conversationContext, followOpenSession } from "../app/open-chat";
import { initializeI18n } from "../app/i18n";
import { AppStore } from "../state/app-store";
import { ComposerStore } from "../composer/composer-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { setStyleTheme } from "../ui/theme-style";
import claude from "../claude-theme.json";
import lody from "../theme.json";
import { composerStubClient } from "./composer-fixture";
import { fixtureThemeFamily } from "./fixture-theme";
import { HOST_DEFAULT_VALUES, scriptedClient } from "./scripted-app-client";

/**
 * The shell over a scripted client with its settings wired, for the settings
 * dialog: `settings-probe` echoes a saved preference so a test sees a write
 * land, and the theme buttons swap Lody and Claude for screenshots.
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
	const keyboardShortcuts = Object.fromEntries(
		SHORTCUT_COMMANDS.map((command) => [command.id, command.defaultShortcut]),
	) as KeyboardShortcutMap;
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

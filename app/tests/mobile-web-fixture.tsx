import { mount, signal, Storage, Text, View } from "nsh";

import type { PiModel, PiThinkingLevel } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import type { ThemeSettings } from "@shared/theme-settings-types";

import { initializeI18n } from "../shell/i18n";
import { conversationContext, followOpenSession } from "../shell/open-chat";
import type {
	WebRemoteConnectionState,
	WebRemoteRecoveryState,
} from "../../web/web-remote-client";
import { ComposerStore } from "../composer/composer-store";
import {
	MobileAppShell,
	MobileAuthRequiredView,
	type AuthExpiryReminder,
} from "../../web/mobile-app-shell";
import {
	MobileDropdownItem,
	MobileDropdownMenu,
} from "../../web/mobile-dropdown-menu";
import { RemotePairingPage } from "../../web/pairing-page";
import { RemotePairingError } from "../../web/web-remote-client";
import { AppStore } from "../state/app-store";
import type { ChatRunConfigState } from "../state/chat-run-config";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { composerStubClient } from "./composer-fixture";
import { scriptedClient } from "./scripted-app-client";

const project = {
	id: "p1",
	name: "pilo",
	path: "/Users/pilo/code/pilo",
	connection: {
		id: "local",
		name: "Local",
		shownInHome: true,
		kind: { type: "local" },
	},
} as Project;

const sessions: SessionIndexEntry[] = [
	{
		piSessionId: "s1",
		sessionPath: "/sessions/s1.jsonl",
		projectId: "p1",
		name: "Mobile Testing Session",
		firstUserMessagePreview: "Check iOS Safari keyboard behavior",
		titleOverride: null,
		pinned: false,
		createdAt: "2026-11-23T01:00:00Z",
		updatedAt: "2026-11-23T02:00:00Z",
		lastMessageAt: "2026-11-23T02:00:00Z",
		indexedAtMs: 1_763_863_200_000,
		fileSize: 1024,
		fileMtimeNs: "1763863200000000000",
	} as SessionIndexEntry,
];

async function run() {
	const scenario = (await Storage.getItem("fixture.scenario")) ?? "ready";
	if (scenario === "header-menu") {
		const positionText = signal("unpositioned");
		const selected = signal(0);
		mount(() => (
			<View class="flex-1 flex-col bg-background">
				<View class="mt-0.5 h-11 flex-row items-center justify-end px-1.5">
					<MobileDropdownMenu
						align="end"
						popupClass="w-72"
						onPosition={({ placement, bounds }) => {
							positionText.set(
								`${placement}:${Math.round(bounds.origin.x)},${Math.round(bounds.origin.y)},${Math.round(bounds.size.width)}x${Math.round(bounds.size.height)}`,
							);
						}}
						trigger={
							<Button testID="probe-header-menu-trigger" class="size-11">
								<Text>More</Text>
							</Button>
						}
					>
						<View class="gap-1">
							<MobileDropdownItem
								testID="probe-header-menu-item"
								onSelect={() => selected.update((n) => n + 1)}
							>
								<Text>Session ID</Text>
							</MobileDropdownItem>
						</View>
					</MobileDropdownMenu>
				</View>
				<Text testID="probe-menu-position">{positionText}</Text>
				<Text testID="probe-menu-selected">
					{() => `selected:${selected()}`}
				</Text>
			</View>
		));
		return;
	}
	if (
		scenario === "pairing-single" ||
		scenario === "pairing-multi" ||
		scenario === "pairing-expired"
	) {
		const secret = "a".repeat(43);
		const tokenValue = "b".repeat(43);
		const storageMap = new Map<string, string>();
		const memStorage = {
			getItem: (key: string) => storageMap.get(key) ?? null,
			setItem: (key: string, value: string) => {
				storageMap.set(key, value);
			},
			removeItem: (key: string) => {
				storageMap.delete(key);
			},
		};
		const paired = signal<string | null>(null);
		const navigated = signal<string | null>(null);
		mount(() => (
			<View class="flex-1 bg-background">
				{() =>
					paired() ? (
						<Text testID="pairing-done">{`paired:${paired()}`}</Text>
					) : (
						<RemotePairingPage
							onPaired={(tok) => paired.set(tok)}
							overrides={{
								url: `http://192.168.1.5:47653/pair#pair=${secret}`,
								origin: "http://192.168.1.5:47653",
								storage: memStorage,
								randomBytes: (size) => new Uint8Array(size).fill(7),
								loadToken: async () => null,
								saveToken: async () => undefined,
								navigate: (url) => navigated.set(url),
								getPairingInfo: async () => {
									if (scenario === "pairing-expired") {
										throw new RemotePairingError(401, "expired");
									}
									const base = {
										id: "lan",
										name: "LAN",
										baseUrl: "http://192.168.1.5:47653",
										issued: false,
									};
									const addresses =
										scenario === "pairing-multi"
											? [
													base,
													{
														id: "public",
														name: "Public",
														baseUrl: "https://pilo.example.com",
														issued: true,
													},
												]
											: [base];
									return {
										addresses,
										expiresAtMs: Date.now() + 60_000,
										remainingUses: addresses.length,
									};
								},
								pair: async () => ({
									token: tokenValue,
									expiresAtMs: Date.now() + 30 * 24 * 60 * 60 * 1_000,
								}),
							}}
						/>
					)
				}
				{() =>
					navigated() ? (
						<Text testID="pairing-navigated">{navigated()!}</Text>
					) : null
				}
			</View>
		));
		return;
	}
	if (scenario === "auth") {
		const token = signal<string | null>(null);
		mount(
			() => () =>
				token() ? (
					<MobileAuthRequiredView
						error={() => `Connected with ${token()}`}
						onSubmitToken={(value) => token.set(value)}
					/>
				) : (
					<MobileAuthRequiredView
						error={() => "Authorization expired"}
						onSubmitToken={(value) => token.set(value)}
					/>
				),
		);
		return;
	}

	const themeSettings = {
		revision: 1,
		theme: "light",
		themeFamily: "lody",
	} as ThemeSettings;
	const runtime = scriptedClient({
		projects: [project],
		sessions: async (projectId) => (projectId === "p1" ? sessions : []),
		onDeleteSession: async () => {
			if (scenario === "delete-failed") {
				throw new Error("Disk is read-only");
			}
			return { method: "trash" };
		},
		themeSettings,
		history: async (sessionPath) =>
			sessionPath === "/sessions/s1.jsonl"
				? [
						{
							type: "user_message_start",
							text: "Hello from iPhone Safari",
							timestampMs: 1000,
							sourceEntryId: "u1",
						},
						{
							type: "assistant_message_start",
							timestampMs: 2000,
							sourceEntryId: "a1",
						},
						{
							type: "assistant_text_delta",
							delta: "Everything is running on nsh Web.",
							timestampMs: 2000,
							sourceEntryId: "a1",
							sourceContentIndex: 0,
						},
						{
							type: "assistant_turn_end",
							stopReason: "stop",
							completion: "complete",
							timestampMs: 2500,
						},
					]
				: [],
	});
	const chat = new ChatTranscriptStore(runtime.client, conversationContext());
	const store = new AppStore(runtime.client, chat);
	const composer = new ComposerStore({
		client: composerStubClient(runtime.client),
		app: store.state,
	});
	followOpenSession(store, chat);

	const connectionState = signal<WebRemoteConnectionState>(
		scenario === "offline" ? "offline" : "connected",
	);
	const recoveryState = signal<WebRemoteRecoveryState>(
		scenario === "offline" ? "reconnecting" : "idle",
	);

	const models: PiModel[] = [
		{
			provider: "anthropic",
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			reasoning: true,
			contextWindow: 200_000,
		},
		{
			provider: "openai",
			id: "gpt-5",
			name: "GPT-5",
			reasoning: true,
			contextWindow: 400_000,
		},
	];
	const runConfigState = signal<ChatRunConfigState>({
		sessionKey: "p1:draft-1",
		projectId: "p1",
		session: null,
		model: models[0],
		thinkingLevel: "medium",
		thinkingLevels: ["off", "low", "medium", "high"],
		ready: true,
		compacting: false,
		modelDirty: false,
		thinkingDirty: false,
		headerMissing: false,
		changing: false,
		error: null,
	});
	const catalogState = signal({
		projectId: "p1",
		loaded: true,
		refreshing: false,
		savingScope: false,
		error: null,
		catalog: {
			projectId: "p1",
			connectionId: "local",
			models,
			commands: [],
			defaultModel: models[0],
			defaultThinkingLevel: "medium" as PiThinkingLevel,
			refreshedAtMs: 1_763_863_200_000,
		},
		scope: { projectId: "p1", models: null, updatedAtMs: 1_763_863_200_000 },
	});

	const authExpiryReminder = signal<AuthExpiryReminder | null>(
		scenario === "expiring"
			? {
					description: "Expires soon",
					renew: () => {
						authExpiryReminder.set(null);
					},
					dismiss: () => {
						authExpiryReminder.set(null);
					},
				}
			: null,
	);

	mount(MobileAppShell, {
		store,
		chat,
		composer,
		authExpiryReminder,
		runConfig: {
			state: runConfigState,
			scopeModels: models,
			catalogReady: true,
			setModel: async (model) => {
				runConfigState.update((current) => ({ ...current, model }));
			},
			setThinkingLevel: async (thinkingLevel: PiThinkingLevel) => {
				runConfigState.update((current) => ({ ...current, thinkingLevel }));
			},
			cycleScopeModel: async () => undefined,
		},
		catalog: {
			state: catalogState,
			refresh: async () => undefined,
			saveScope: async () => undefined,
		},
		connectionState,
		recoveryState,
		onReconnect: () => {
			connectionState.set("connected");
			recoveryState.set("recovered");
		},
	});
	await store.start();
}

initializeI18n();
void run();

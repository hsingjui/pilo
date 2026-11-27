import { mount, signal, Storage, Text, token, View } from "nsh";

import { chatSessionKey } from "@shared/api/chat-session-key";
import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import type { PiModel, PiThinkingLevel } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import { createChatSubmission } from "@shared/chat/chat-submission";
import type { ThemeSettings } from "@shared/theme-settings-types";

import { AppToasts } from "../shell/app-toasts";
import { initializeI18n } from "../shell/i18n";
import { LandingProjectPicker } from "../shell/landing";
import { conversationContext, followOpenSession } from "../shell/open-chat";
import { MobileViewport } from "../../web/mobile-viewport";
import type {
	WebRemoteConnectionState,
	WebRemoteRecoveryState,
} from "../../web/web-remote-client";
import { ComposerStore } from "../composer/composer-store";
import {
	MobileAppShell,
	MobileAuthRequiredView,
} from "../../web/mobile-app-shell";
import {
	MobileDropdownItem,
	MobileDropdownMenu,
} from "../../web/mobile-dropdown-menu";
import { RemotePairingPage } from "../../web/pairing-page";
import { RemotePairingError } from "../../web/web-remote-browser";
import { AppStore } from "../state/app-store";
import { ChatQueueStore } from "../state/chat-queue-store";
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

const secondProject = {
	id: "p2",
	name: "api",
	path: "/Users/pilo/code/api",
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
	if (scenario === "landing-project-picker") {
		const projects = [project, secondProject];
		const active = signal<Project>(project);
		const triggerBounds = signal("unmeasured");
		const positionText = signal("unpositioned");
		mount(() => (
			<View class="flex-1 flex-col items-center justify-center bg-background">
				<View
					onLayout={({ bounds }) => {
						triggerBounds.set(
							`trigger:${Math.round(bounds.origin.x)},${Math.round(bounds.origin.y)},${Math.round(bounds.size.width)}x${Math.round(bounds.size.height)}`,
						);
					}}
				>
					<LandingProjectPicker
						touch
						projects={() => projects}
						project={active}
						onSelect={(id) => {
							const found = projects.find((item) => item.id === id);
							if (found) active.set(found);
						}}
						onPosition={({ placement, bounds }) => {
							positionText.set(
								`${placement}:${Math.round(bounds.origin.x)},${Math.round(bounds.origin.y)},${Math.round(bounds.size.width)}x${Math.round(bounds.size.height)}`,
							);
						}}
					/>
				</View>
				<Text testID="probe-landing-trigger">{triggerBounds}</Text>
				<Text testID="probe-landing-position">{positionText}</Text>
				<Text testID="probe-landing-selected">
					{() => `selected:${active().id}`}
				</Text>
			</View>
		));
		return;
	}
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

	const queueScenario = scenario === "queue" || scenario === "queue-offline";
	const externalReadOnlyScenario =
		scenario === "external-readonly" || scenario === "external-readonly-draft";
	const s1Key = chatSessionKey("p1", "s1");
	const queues = { steering: [] as string[], followUp: [] as string[] };
	let queueSequence = 1;
	let queue: ChatQueueStore | undefined;

	const themeSettings = {
		revision: 1,
		theme: "light",
		themeFamily: "lody",
	} as ThemeSettings;
	const runtime = scriptedClient({
		projects:
			scenario === "multi-project" ? [project, secondProject] : [project],
		sessions: async (projectId) => (projectId === "p1" ? sessions : []),
		chatSessions: queueScenario
			? ([
					{
						sessionKey: s1Key,
						projectId: "p1",
						sessionPath: "/sessions/s1.jsonl",
						prepared: true,
						initialized: true,
						snapshot: { state: "running", generation: 1 },
						activeTurn: { id: "t1" },
					},
				] as unknown as ChatSessionRuntimeState[])
			: undefined,
		onCommand: queueScenario
			? (sessionKey, command) => {
					const type = String(command.type ?? "");
					if (type === "steer" || type === "follow_up") {
						const message = String(command.message ?? "");
						if (type === "steer") queues.steering.push(message);
						else queues.followUp.push(message);
						queue?.receive({
							sequence: ++queueSequence,
							timestampMs: 1000,
							sessionKey,
							generation: 1,
							type: "queue_update",
							steering: [...queues.steering],
							followUp: [...queues.followUp],
						});
						return { success: true, data: { disposition: "queued" } };
					}
					if (type === "clear_queue") {
						const cleared = {
							steering: [...queues.steering],
							followUp: [...queues.followUp],
						};
						queues.steering = [];
						queues.followUp = [];
						queue?.receive({
							sequence: ++queueSequence,
							timestampMs: 1000,
							sessionKey,
							generation: 1,
							type: "queue_update",
							steering: [],
							followUp: [],
						});
						return { success: true, data: cleared };
					}
					if (type === "prompt") {
						return { success: true, data: { disposition: "started" } };
					}
					return { success: true };
				}
			: undefined,
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
	let externalTurnOpen = scenario === "external-readonly";
	const appClient = externalReadOnlyScenario
		? {
				...runtime.client,
				externalSessionActivity: async (projectId: string) =>
					externalTurnOpen && projectId === "p1"
						? [{ path: "/sessions/s1.jsonl", turnOpen: true }]
						: [],
			}
		: runtime.client;
	const store = new AppStore(appClient, chat);
	const composerClient = composerStubClient(runtime.client);
	if (queueScenario) {
		queue = new ChatQueueStore(composerClient);
	}
	const composer = new ComposerStore({
		client: composerClient,
		app: store.state,
		queue,
	});
	followOpenSession(store, chat);

	const connectionState = signal<WebRemoteConnectionState>(
		scenario === "offline" || scenario === "queue-offline"
			? "offline"
			: "connected",
	);
	const recoveryState = signal<WebRemoteRecoveryState>(
		scenario === "offline" || scenario === "queue-offline"
			? "reconnecting"
			: "idle",
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
		session:
			scenario === "context-usage" || externalReadOnlyScenario
				? {
						sessionId: "s1",
						sessionPath: "/sessions/s1.jsonl",
						name: "Mobile Testing Session",
						contextTokens: 42_000,
						contextWindow: 200_000,
						contextPercent: 21,
						contextStale: false,
						tokens: {
							input: 12_000,
							output: 3_000,
							cacheRead: 27_000,
							cacheWrite: 0,
						},
						cost: 0.042,
					}
				: null,
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

	const toasts = scenario === "toast" ? new AppToasts() : undefined;
	const toastActionCount = signal(0);
	const safeAreaTopOverride = Number(
		(await Storage.getItem("fixture.safeAreaTop")) ?? "0",
	);
	const shellProps = {
		store,
		chat,
		composer,
		queue,
		toasts,
		runConfig: {
			state: runConfigState,
			scopeModels: models,
			catalogReady: true,
			setModel: async (model: PiModel) => {
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
	};
	if (scenario === "toast" && toasts) {
		const viewportState = {
			managed: () => true,
			availableHeight: () => 844,
			requestSync: () => {},
			keyboardOpen: () => false,
			offsetTop: () => 0,
			safeAreaTop: () => safeAreaTopOverride,
			safeAreaBottom: () => 0,
		};
		mount(() => (
			<MobileViewport.Provider value={viewportState}>
				<View class="flex-1 bg-background">
					<MobileAppShell {...shellProps} />
					<View class="absolute bottom-24 left-3 z-40 flex-row gap-2">
						<Button
							testID="probe-show-toast"
							onPress={() => {
								toasts.show({
									variant: "info",
									title: "Leaving temporary chat",
									description: "Chat will be cleared shortly",
									timeout: 60_000,
									action: {
										label: "Return",
										onPress: () => toastActionCount.update((n) => n + 1),
									},
								});
							}}
						>
							<Text>Show toast</Text>
						</Button>
						<Text testID="probe-toast-actions">
							{() => `toastActions:${toastActionCount()}`}
						</Text>
					</View>
				</View>
			</MobileViewport.Provider>
		));
	} else if (scenario === "font-scale") {
		mount(() => (
			<View class="flex-1 bg-background">
				<MobileAppShell {...shellProps} />
				<Text testID="probe-font-scale">
					{() =>
						`fontScale uiSm=${Math.round(token("pilo-ui-text-sm"))} code=${Math.round(token("pilo-code-font-size"))}`
					}
				</Text>
			</View>
		));
	} else {
		mount(MobileAppShell, shellProps);
	}
	await store.start();
	if (queueScenario || externalReadOnlyScenario) {
		store.selectSession("p1", "/sessions/s1.jsonl");
	}
	if (externalReadOnlyScenario) {
		await store.loadSessions("p1");
	}
	if (scenario === "external-readonly-draft") {
		composer.setValue("keep this draft while external Pi runs");
		externalTurnOpen = true;
		await store.loadSessions("p1");
	}
	if (scenario === "queue-offline" && queue) {
		queues.steering.push("keep waiting while offline");
		queue.adoptQueued(
			s1Key,
			"steer",
			createChatSubmission("keep waiting while offline"),
		);
		queue.receive({
			sequence: ++queueSequence,
			timestampMs: 1000,
			sessionKey: s1Key,
			generation: 1,
			type: "queue_update",
			steering: [...queues.steering],
			followUp: [],
		});
	}
}

initializeI18n();
void run();

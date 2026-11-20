import { mount } from "nsh";

import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { ConversationEvent } from "@/lib/chat/conversation-types";
import type { Connection } from "@/lib/api/pi-runtime-types";
import type { PiModel } from "@/lib/api/pi-runtime-types";
import type { ProjectPiModels } from "@/lib/api/pi-models-types";
import type { Project } from "@/lib/api/projects-types";
import type { SessionIndexEntry } from "@/lib/api/sessions-types";
import type { ThemeSettings } from "@/lib/theme-settings-types";
import "../app/fonts";
import { AppShell } from "../app/AppShell";
import { initializeI18n } from "../app/i18n";
import {
	conversationContext,
	followOpenSession,
	followRunConfig,
} from "../app/open-chat";
import { AppStore } from "../state/app-store";
import { ComposerStore } from "../composer/composer-store";
import { ChatRunConfigStore } from "../state/chat-run-config";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { ModelCatalogStore } from "../state/model-catalog";
import { composerStubClient } from "./composer-fixture";
import { fixtureThemeFamily } from "./fixture-theme";
import { scriptedClient } from "./scripted-app-client";

const gpt5: PiModel = {
	id: "gpt-5",
	name: "GPT-5",
	provider: "openai",
	reasoning: true,
	thinkingLevels: ["low", "high"],
	defaultThinkingLevel: "high",
};
const sonnet: PiModel = {
	id: "sonnet-4.5",
	name: "Sonnet 4.5",
	provider: "anthropic",
	reasoning: true,
	thinkingLevels: ["minimal", "high"],
	defaultThinkingLevel: "minimal",
};

const catalog: ProjectPiModels = {
	projectId: "pilo",
	models: [
		{ ...gpt5, scopeOrder: 0, scopeThinkingLevel: "high" },
		{ ...sonnet, scopeOrder: 1, scopeThinkingLevel: "minimal" },
	],
	commands: [],
	defaultModel: gpt5,
	defaultThinkingLevel: "high",
	refreshedAtMs: 1,
};

const session: SessionIndexEntry = {
	connectionId: "local",
	projectId: "pilo",
	piSessionId: "s4",
	sessionPath: "/sessions/s4.jsonl",
	name: "Resize the sidebar",
	cwd: "/code/pilo",
	createdAt: "2026-11-04T09:00:00Z",
	updatedAt: "2026-11-04T09:00:00Z",
	messageCount: 4,
	lastMessageAt: "2026-11-04T09:00:00Z",
	firstUserMessagePreview: "Resize the sidebar",
	fileSize: 1,
	fileMtimeNs: "0",
	lastOffset: 1,
	indexedAtMs: 0,
	pinned: false,
	titleOverride: null,
};

const turn = (minute: number, prompt: string, reply: string) => {
	const timestampMs = Date.UTC(2026, 10, 4, 9, minute);
	return [
		{ type: "user_message_start", text: prompt, timestampMs },
		{ type: "assistant_message_start", timestampMs },
		{ type: "assistant_text_delta", delta: reply, timestampMs },
		{ type: "assistant_turn_end", stopReason: "stop", timestampMs },
	] as ConversationEvent[];
};

const replies: Record<string, unknown> = {
	get_state: {
		model: gpt5,
		thinkingLevel: "high",
		isStreaming: false,
		isCompacting: false,
		sessionId: "s4",
		sessionFile: "/sessions/s4.jsonl",
		sessionName: "Resize the sidebar",
		messageCount: 4,
		pendingMessageCount: 0,
	},
	get_session_stats: {
		tokens: { input: 1200, output: 300, total: 1500 },
		cost: 0.04,
		contextUsage: { tokens: 42000, contextWindow: 200000, percent: 21 },
	},
	get_available_thinking_levels: { levels: ["low", "high"] },
	set_model: null,
	set_thinking_level: null,
};

async function run() {
	const themeSettings = {
		revision: 1,
		theme: "system",
		themeFamily: await fixtureThemeFamily(),
	} as ThemeSettings;
	let entry = session;
	let runtime!: ReturnType<typeof scriptedClient>;
	runtime = scriptedClient({
		projects: [
			{
				id: "pilo",
				name: "pilo",
				path: "/code/pilo",
				connection: {
					id: "local",
					name: "Local",
					kind: { type: "local" },
				} as Connection,
			} as Project,
		],
		themeSettings,
		sessions: () => Promise.resolve([entry]),
		onUpdateSessionUiState: (sessionPath, update) => {
			entry = {
				...entry,
				sessionPath,
				pinned: update.pinned,
				titleOverride: update.titleOverride,
			};
			runtime.emit({ type: "sessions_indexed", projectId: "pilo" });
			return entry;
		},
		history: () => Promise.resolve(turn(0, "Resize the sidebar", "Done.")),
		historyMeta: {
			model: { provider: "openai", id: "gpt-5" },
			thinkingLevel: "high",
			name: "Resize the sidebar",
		},
		chatSessions: [
			{
				sessionKey: "k4",
				projectId: "pilo",
				sessionPath: "/sessions/s4.jsonl",
				activeTurn: false,
				snapshot: { generation: 1, state: "running" },
			} as ChatSessionRuntimeState,
		],
		models: { pilo: catalog },
		modelScopes: { pilo: { projectId: "pilo", models: null, updatedAtMs: 1 } },
		onCommand: (_sessionKey, command) => {
			const data = replies[command.type as string];
			if (data === undefined) return undefined;
			if (command.type === "get_state") {
				return {
					data: { ...data, sessionName: entry.titleOverride ?? session.name },
				};
			}
			return { data };
		},
	});
	const chat = new ChatTranscriptStore(runtime.client, conversationContext());
	const store = new AppStore(runtime.client, chat);
	const composer = new ComposerStore({
		client: composerStubClient(runtime.client),
		app: store.state,
	});
	const models = new ModelCatalogStore(runtime.client);
	const runConfig = new ChatRunConfigStore(runtime.client, models.state);
	followOpenSession(store, chat);
	followRunConfig(store, runConfig, models);
	mount(AppShell, {
		store,
		chat,
		composer,
		runConfig,
		catalog: models,
		onRenameSession: (projectId, sessionPath, title) =>
			void runtime.client.updateSessionUiState(
				sessionPath,
				{ pinned: false, titleOverride: title },
				projectId,
			),
	});
	await store.start();
}

initializeI18n();
void run();

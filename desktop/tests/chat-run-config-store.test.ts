import { expect, test } from "nsh/test";
import { signal } from "nsh";

import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { ProjectPiModels } from "@/lib/api/pi-models-types";
import type { PiAgentState, PiModel } from "@/lib/api/pi-runtime-types";
import type { SessionHistory } from "@/lib/api/sessions-types";
import type { AppScript } from "./scripted-app-client";
import { scriptedClient } from "./scripted-app-client";
import { ChatRunConfigStore } from "../state/chat-run-config";
import type { ModelCatalogState } from "../state/model-catalog";

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

const agentState = (over: Partial<PiAgentState> = {}): PiAgentState => ({
	model: gpt5,
	thinkingLevel: "high",
	isStreaming: false,
	isCompacting: false,
	sessionId: "s1",
	sessionFile: "/s.jsonl",
	sessionName: "Session",
	messageCount: 2,
	pendingMessageCount: 0,
	...over,
});

const runningChat = (sessionKey = "k1") =>
	({
		sessionKey,
		projectId: "p1",
		prepared: true,
		initialized: true,
		activeTurn: false,
		snapshot: { state: "running", generation: 1 },
	}) as ChatSessionRuntimeState;

const statsReply = {
	tokens: { input: 10, output: 5 },
	cost: 0.01,
	contextUsage: { tokens: 9000, contextWindow: 200000, percent: 4.5 },
};

function setup(
	options: {
		state?: PiAgentState;
		historyMeta?: Partial<SessionHistory>;
		catalog?: ModelCatalogState | null;
		extraReplies?: Record<string, unknown>;
	} = {},
) {
	const catalog = signal<ModelCatalogState | null>(options.catalog ?? null);
	const replies: Record<string, unknown> = {
		get_state: options.state ?? agentState(),
		get_session_stats: statsReply,
		get_available_thinking_levels: { levels: ["low", "high"] },
		set_model: null,
		set_thinking_level: null,
		...options.extraReplies,
	};
	const sent: Record<string, unknown>[] = [];
	const script: AppScript = {
		historyMeta: options.historyMeta,
		onCommand: (_sessionKey, command) => {
			sent.push(command);
			const data = replies[command.type as string];
			return data === undefined ? undefined : { data };
		},
	};
	const scripted = scriptedClient(script);
	const store = new ChatRunConfigStore(scripted.client, catalog);
	return {
		store,
		emit: scripted.emit,
		sent,
		script,
		catalog,
	};
}

test("a running chat adopts Pi's config and shows session usage", async () => {
	const { store, script } = setup();
	script.chatSessions = [runningChat()];
	await store.open({
		sessionKey: "k1",
		projectId: "p1",
		sessionPath: "/s.jsonl",
	});
	const state = store.state()!;
	expect(state.ready).toBe(true);
	expect(state.model?.id).toBe("gpt-5");
	expect(state.thinkingLevel).toBe("high");
	expect(state.thinkingLevels).toEqual(["low", "high"]);
	expect(state.session?.contextTokens).toBe(9000);
	expect(state.session?.contextPercent).toBe(4.5);
	expect(state.session?.name).toBe("Session");
	expect(state.compacting).toBe(false);
});

test("history metadata seeds a saved session's config", async () => {
	const { store } = setup({
		catalog: {
			projectId: "p1",
			catalog: {
				projectId: "p1",
				models: [gpt5, sonnet],
				commands: [],
				defaultModel: gpt5,
				defaultThinkingLevel: "high",
				refreshedAtMs: 1,
			} as ProjectPiModels,
			scope: { projectId: "p1", models: null, updatedAtMs: 1 },
			loaded: true,
			refreshing: false,
			savingScope: false,
			error: null,
		},
		historyMeta: {
			model: { provider: "anthropic", id: "sonnet-4.5" },
			thinkingLevel: "minimal",
			name: "Old chat",
			headerMissing: false,
			stats: {
				userMessages: 4,
				assistantMessages: 4,
				toolCalls: 2,
				toolResults: 2,
				totalMessages: 8,
				tokens: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					total: 150,
				},
				cost: 0.2,
				contextTokens: 7000,
			},
		},
	});
	await store.open({
		sessionKey: "k1",
		projectId: "p1",
		sessionPath: "/s.jsonl",
	});
	const state = store.state()!;
	expect(state.model?.id).toBe("sonnet-4.5");
	expect(state.thinkingLevel).toBe("minimal");
	expect(state.thinkingLevels).toEqual(["minimal", "high"]);
	expect(state.session?.name).toBe("Old chat");
	expect(state.session?.contextTokens).toBe(7000);
	expect(state.session?.cost).toBe(0.2);
});

test("a saved session's picks stay local until Pi runs, then get pushed", async () => {
	const { store, sent, script } = setup();
	script.chatSessions = [];
	await store.open({
		sessionKey: "k1",
		projectId: "p1",
		sessionPath: "/s.jsonl",
	});
	expect(store.state()!.ready).toBe(true);
	await store.setModel(sonnet);
	expect(sent.filter((command) => command.type === "set_model")).toHaveLength(
		0,
	);
	expect(store.state()!.model?.id).toBe("sonnet-4.5");
	expect(store.state()!.modelDirty).toBe(true);

	// Pi starts and reports a different config: the dirty pick is pushed.
	script.chatSessions = [runningChat()];
	await store.refresh();
	expect(sent.map((command) => command.type)).toContain("set_model");
	expect(store.state()!.model?.id).toBe("sonnet-4.5");
});

test("a saved session's thinking pick is pushed on the next sync", async () => {
	const { store, sent, script } = setup();
	script.chatSessions = [runningChat()];
	await store.open({
		sessionKey: "k1",
		projectId: "p1",
		sessionPath: "/s.jsonl",
	});
	sent.length = 0;
	await store.setThinkingLevel("low");
	expect(sent.map((command) => command.type)).not.toContain(
		"set_thinking_level",
	);
	expect(store.state()!.thinkingLevel).toBe("low");
	await store.refresh();
	expect(sent.map((command) => command.type)).toContain("set_thinking_level");
	expect(store.state()!.thinkingDirty).toBe(true);
});

test("a live chat's picks reach Pi immediately", async () => {
	const { store, sent, script } = setup();
	script.chatSessions = [runningChat("new")];
	await store.open({ sessionKey: "new", projectId: "p1" });
	sent.length = 0;
	await store.setThinkingLevel("low");
	expect(sent.map((command) => command.type)).toContain("set_thinking_level");
	expect(store.state()!.thinkingLevel).toBe("low");
	expect(store.state()!.thinkingDirty).toBe(true);
});

test("compaction events mark the chat and refresh usage", async () => {
	const { store, emit, script } = setup();
	script.chatSessions = [runningChat()];
	await store.open({
		sessionKey: "k1",
		projectId: "p1",
		sessionPath: "/s.jsonl",
	});
	emit({
		type: "compaction_start",
		sessionKey: "k1",
		generation: 1,
		reason: "auto",
	});
	expect(store.state()!.compacting).toBe(true);
	emit({
		type: "compaction_end",
		sessionKey: "k1",
		generation: 1,
		reason: "auto",
		result: null,
		aborted: false,
		willRetry: false,
		errorMessage: null,
	});
	expect(store.state()!.compacting).toBe(false);
	// refreshStats ran; a later compaction without usage keeps the last one.
	expect(store.state()!.session?.contextPercent).toBe(4.5);
});

test("a new chat pushes its scope default once, then keeps it", async () => {
	const { store, sent, script } = setup({
		state: agentState({ model: sonnet, thinkingLevel: "minimal" }),
	});
	script.chatSessions = [runningChat("new")];
	await store.open(
		{ sessionKey: "new", projectId: "p1" },
		{ initialModel: gpt5, initialThinkingLevel: "high" },
	);
	const state = store.state()!;
	expect(state.model?.id).toBe("gpt-5");
	expect(state.modelDirty).toBe(true);
	expect(state.thinkingDirty).toBe(true);
	const types = sent.map((command) => command.type);
	expect(types).toContain("set_model");
	expect(types).toContain("set_thinking_level");
});

test("a scope default arriving late is adopted until the user picks", async () => {
	const { store, script } = setup();
	script.chatSessions = [runningChat("new")];
	await store.open({ sessionKey: "new", projectId: "p1" });
	store.adoptInitial(sonnet, "minimal");
	expect(store.state()!.model?.id).toBe("sonnet-4.5");
	expect(store.state()!.thinkingLevel).toBe("minimal");
});

test("scope models and cycle only work with a resolved catalog", async () => {
	const catalog: ModelCatalogState = {
		projectId: "p1",
		catalog: {
			projectId: "p1",
			models: [
				{ ...gpt5, scopeOrder: 0, scopeThinkingLevel: "high" },
				{ ...sonnet, scopeOrder: 1, scopeThinkingLevel: "minimal" },
			],
			commands: [],
			defaultModel: gpt5,
			defaultThinkingLevel: "high",
			refreshedAtMs: 1,
		} as ProjectPiModels,
		scope: {
			projectId: "p1",
			models: null,
			updatedAtMs: 1,
		},
		loaded: true,
		refreshing: false,
		savingScope: false,
		error: null,
	};
	const { store, sent, script } = setup({ catalog });
	script.chatSessions = [runningChat()];
	await store.open({
		sessionKey: "k1",
		projectId: "p1",
		sessionPath: "/s.jsonl",
	});
	expect(store.scopeModels.map((model) => model.id)).toEqual([
		"gpt-5",
		"sonnet-4.5",
	]);
	sent.length = 0;
	await store.cycleScopeModel();
	expect(store.state()!.model?.id).toBe("sonnet-4.5");
	expect(store.state()!.thinkingLevel).toBe("minimal");
	expect(sent.map((command) => command.type)).not.toContain("set_model");
	await store.refresh();
	expect(sent.map((command) => command.type)).toContain("set_model");
});

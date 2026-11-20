import { type Accessor, signal } from "nsh";

import type { ProjectPiModels } from "@/lib/api/pi-models-types";
import type {
	PiAgentState,
	PiModel,
	PiSessionStats,
	PiThinkingLevel,
} from "@/lib/api/pi-runtime-types";
import { PI_THINKING_LEVELS } from "@/lib/api/pi-runtime-types";
import type { ChatSessionRuntimeState } from "@/lib/chat/session-stats";
import {
	mergeRefreshedSessionState,
	mergeSessionStats,
} from "@/lib/chat/session-stats";
import {
	findMatchingPiModel,
	getNextPiScopeModel,
	getPiModelThinkingLevels,
	getPiQuickCycleThinkingLevel,
	getProjectScopeModels,
	isPiScopeCatalogResolved,
} from "@/lib/pi-model-selection";
import type { PiloClientEvent } from "@/lib/api/pilo-client";
import { requestPiRpcReply, type PiCommandClient } from "../client/chat-rpc";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import type { ChatTranscriptTarget } from "./chat-transcript-store";
import type { ModelCatalogState } from "./model-catalog";

export type ChatRunConfigClient = PiCommandClient &
	Pick<NshPiloClient, "startChat" | "chatState" | "loadHistory">;

export type ChatRunConfigOptions = {
	/** A new chat's scope-resolved defaults; absent while a scope is pending. */
	initialModel?: PiModel;
	initialThinkingLevel?: PiThinkingLevel;
};

export type ChatRunConfigState = {
	sessionKey: string;
	projectId: string;
	sessionPath?: string;
	model: PiModel | null;
	thinkingLevel: PiThinkingLevel | null;
	thinkingLevels: PiThinkingLevel[];
	/** A manual pick wins over scope defaults and catalog loads. */
	modelDirty: boolean;
	thinkingDirty: boolean;
	/** Session overlay: name, token/cost and context usage. */
	session: ChatSessionRuntimeState | null;
	/** The saved session's header has no metadata. */
	headerMissing: boolean;
	compacting: boolean;
	changing: boolean;
	/** The first config read for this chat finished (or Pi was unreachable). */
	ready: boolean;
	error: string | null;
};

const RPC_TIMEOUT_MS = 10_000;

/**
 * The open chat's runtime configuration — model, thinking level, session
 * overlay and compaction state — driven by Pi RPCs and session events.
 *
 * Saved sessions (`sessionPath` set) seed from history metadata and keep the
 * selection local until Pi runs, when a dirty selection is pushed. A chat
 * without `sessionPath` is live: picks reach Pi immediately, and a new chat
 * applies its scope default once on the first agent state.
 */
export class ChatRunConfigStore {
	private readonly current = signal<ChatRunConfigState | null>(null);
	readonly state: Accessor<ChatRunConfigState | null> = this.current;

	private readonly client: ChatRunConfigClient;
	private readonly catalog: Accessor<ModelCatalogState | null>;
	private disconnect: (() => void) | undefined;
	private opens = 0;
	private requests = 0;
	/** A new chat's initial config, pushed on the first agent state. */
	private pendingInitial: {
		model: PiModel | null;
		level: PiThinkingLevel | null;
	} | null = null;

	constructor(
		client: ChatRunConfigClient,
		catalog: Accessor<ModelCatalogState | null>,
	) {
		this.client = client;
		this.catalog = catalog;
	}

	/** Opens the chat's configuration and subscribes to its session events. */
	async open(
		target: ChatTranscriptTarget,
		options: ChatRunConfigOptions = {},
	): Promise<void> {
		const open = ++this.opens;
		this.disconnect?.();
		this.pendingInitial = target.sessionPath
			? null
			: {
					model: options.initialModel ?? null,
					level: options.initialThinkingLevel ?? null,
				};
		this.current.set({
			sessionKey: target.sessionKey,
			projectId: target.projectId,
			sessionPath: target.sessionPath ?? undefined,
			model: options.initialModel ?? null,
			thinkingLevel: options.initialThinkingLevel ?? null,
			thinkingLevels: [...getPiModelThinkingLevels(options.initialModel)],
			modelDirty: false,
			thinkingDirty: false,
			session: null,
			headerMissing: false,
			compacting: false,
			changing: false,
			ready: false,
			error: null,
		});
		this.disconnect = await this.client.connectEvents({
			onMessage: (message) => {
				if (message.type !== "events") return;
				for (const event of message.events) {
					if (event.sessionKey === target.sessionKey) this.applyEvent(event);
				}
			},
			onStatus: () => {},
		});
		if (target.sessionPath) {
			void this.applyHistoryMetadata(open, target);
		}
		await this.refresh(open);
	}

	/**
	 * A scope default that arrived after `open` still becomes the new chat's
	 * initial config — until Pi's first agent state applied it, and only
	 * while the user has not picked anything.
	 */
	adoptInitial(model: PiModel | null, level: PiThinkingLevel | null): void {
		const initial = this.pendingInitial;
		const state = this.current();
		if (!initial || !state || state.modelDirty || state.thinkingDirty) return;
		initial.model = model ?? initial.model;
		initial.level = level ?? initial.level;
		this.update({
			model: initial.model,
			thinkingLevel: initial.level,
			thinkingLevels: [...getPiModelThinkingLevels(initial.model)],
		});
	}

	close(): void {
		this.opens += 1;
		this.disconnect?.();
		this.disconnect = undefined;
		this.current.set(null);
	}

	/** A saved session's model, thinking and stats seed the selection. */
	private async applyHistoryMetadata(
		open: number,
		target: ChatTranscriptTarget,
	): Promise<void> {
		if (!target.sessionPath) return;
		const result = await this.client
			.loadHistory(target.projectId, target.sessionPath)
			.catch(() => null);
		if (!result || open !== this.opens) return;
		const { history } = result;
		let historicalModel: PiModel | null = null;
		if (history.model) {
			historicalModel = findMatchingPiModel(
				this.catalogModels(),
				history.model,
			) ?? {
				provider: history.model.provider,
				id: history.model.id,
				name: history.model.id,
				reasoning: false,
			};
		}
		const stats = history.stats;
		const previous = this.current()?.session;
		this.update({
			headerMissing: history.headerMissing ?? false,
			session: {
				...previous,
				name: history.name ?? previous?.name,
				tokens: stats?.tokens ?? previous?.tokens,
				cost: stats?.cost ?? previous?.cost,
				contextTokens: stats?.contextTokens ?? previous?.contextTokens,
			},
			...(historicalModel ? { model: historicalModel } : {}),
			...(history.thinkingLevel &&
			PI_THINKING_LEVELS.includes(history.thinkingLevel as PiThinkingLevel)
				? { thinkingLevel: history.thinkingLevel as PiThinkingLevel }
				: {}),
			thinkingLevels: [...getPiModelThinkingLevels(historicalModel)],
		});
	}

	private catalogModels(): readonly PiModel[] {
		return this.catalog()?.catalog?.models ?? [];
	}

	/** Whether the catalog knows every model's Scope membership. */
	get catalogReady(): boolean {
		const state = this.catalog();
		if (
			!state?.catalog ||
			state.catalog.projectId !== this.current()?.projectId
		)
			return false;
		return (
			state.scope?.models != null ||
			isPiScopeCatalogResolved(state.catalog.models)
		);
	}

	/** The Scope's effective model list, empty until the catalog is ready. */
	get scopeModels(): readonly PiModel[] {
		const state = this.catalog();
		if (!this.catalogReady || !state?.catalog) return [];
		return getProjectScopeModels(state.catalog.models, state.scope);
	}

	/**
	 * Re-reads Pi's state and stats and merges them. A dirty selection is
	 * pushed to a running Pi; otherwise the live values are adopted.
	 */
	async refresh(open = this.opens): Promise<void> {
		const state = this.current();
		if (!state) return;
		const request = ++this.requests;
		const runtime = await this.client
			.chatState(state.sessionKey)
			.catch(() => null);
		if (request !== this.requests || open !== this.opens) return;
		if (!runtime || runtime.snapshot.state !== "running") {
			this.update({ ready: true, compacting: runtime?.compacting ?? false });
			return;
		}
		const agentState = await this.rpc<PiAgentState>({ type: "get_state" });
		if (request !== this.requests || open !== this.opens) return;
		if (!agentState) {
			this.update({ ready: true });
			return;
		}
		let changed = false;
		const latest = this.current();
		if (!latest) return;
		if (latest.sessionPath) {
			if (
				latest.modelDirty &&
				latest.model &&
				(agentState.model?.provider !== latest.model.provider ||
					agentState.model.id !== latest.model.id)
			) {
				await this.rpc({
					type: "set_model",
					provider: latest.model.provider,
					modelId: latest.model.id,
				});
				changed = true;
			}
			if (
				latest.thinkingDirty &&
				latest.thinkingLevel &&
				agentState.thinkingLevel !== latest.thinkingLevel
			) {
				await this.rpc({
					type: "set_thinking_level",
					level: latest.thinkingLevel,
				});
				changed = true;
			}
		} else if (this.pendingInitial?.model || this.pendingInitial?.level) {
			const initial = this.pendingInitial!;
			this.pendingInitial = null;
			if (
				initial.model &&
				(agentState.model?.provider !== initial.model.provider ||
					agentState.model.id !== initial.model.id)
			) {
				await this.rpc({
					type: "set_model",
					provider: initial.model.provider,
					modelId: initial.model.id,
				});
				changed = true;
			}
			if (
				initial.level &&
				(changed || agentState.thinkingLevel !== initial.level)
			) {
				await this.rpc({ type: "set_thinking_level", level: initial.level });
				changed = true;
			}
			// 已确定的初始配置也按手动选择处理，目录晚到不再覆盖。
			this.update({ modelDirty: true, thinkingDirty: true });
		}
		const [liveState, stats, thinking] = await Promise.all([
			changed
				? this.rpc<PiAgentState>({ type: "get_state" })
				: Promise.resolve(agentState),
			this.rpc<PiSessionStats>({ type: "get_session_stats" }),
			this.rpc<{ levels: PiThinkingLevel[] }>({
				type: "get_available_thinking_levels",
			}),
		]);
		if (request !== this.requests || open !== this.opens) return;
		const current = this.current();
		if (!current) return;
		const patch: Partial<ChatRunConfigState> = { ready: true };
		if (!current.modelDirty && liveState?.model) {
			patch.model = liveState.model;
			patch.thinkingLevels = [...getPiModelThinkingLevels(liveState.model)];
		}
		if (!current.thinkingDirty && liveState) {
			patch.thinkingLevel = liveState.thinkingLevel;
		}
		if (thinking?.levels) patch.thinkingLevels = thinking.levels;
		const overlay: ChatSessionRuntimeState = {
			sessionId: liveState?.sessionId ?? agentState.sessionId,
			sessionPath: liveState?.sessionFile ?? agentState.sessionFile,
			name: liveState?.sessionName ?? agentState.sessionName,
			tokens: stats?.tokens,
			cost: stats?.cost,
			contextTokens: stats?.contextUsage?.tokens,
			contextWindow: stats?.contextUsage?.contextWindow,
			contextPercent: stats?.contextUsage?.percent,
		};
		patch.session = mergeRefreshedSessionState(current.session, overlay);
		this.update(patch);
	}

	/** Session events move compaction state and refresh stats at turn ends. */
	private applyEvent(event: PiloClientEvent): void {
		switch (event.type) {
			case "compaction_start":
				this.update({ compacting: true });
				return;
			case "compaction_end":
				this.update({ compacting: false });
				void this.refreshStats();
				return;
			case "pi_reattached":
				this.update({ compacting: event.compacting });
				void this.refresh();
				return;
			case "process_state":
				if (event.state === "running") void this.refresh();
				return;
			case "assistant_message_end":
				void this.refreshStats();
				return;
		}
	}

	/** Re-reads stats alone; a post-compaction unknown keeps the last usage. */
	async refreshStats(): Promise<void> {
		const state = this.current();
		if (!state) return;
		const request = ++this.requests;
		const stats = await this.rpc<PiSessionStats>({ type: "get_session_stats" });
		if (request !== this.requests || !stats || !this.current()) return;
		this.update({
			session: mergeSessionStats(this.current()!.session, stats),
		});
	}

	/** Picks a model; pushed to a running Pi, local for a saved session. */
	async setModel(model: PiModel): Promise<void> {
		const state = this.current();
		if (!state || state.changing) return;
		this.update({
			modelDirty: true,
			thinkingDirty: false,
			error: null,
		});
		if (state.sessionPath) {
			this.update({
				model,
				thinkingLevels: [...getPiModelThinkingLevels(model)],
				thinkingLevel: model.defaultThinkingLevel ?? state.thinkingLevel,
			});
			return;
		}
		const previousModel = state.model;
		const request = ++this.requests;
		this.update({ changing: true, model });
		try {
			await this.ensurePi(state);
			await this.rpcOrThrow({
				type: "set_model",
				provider: model.provider,
				modelId: model.id,
			});
			const [liveState, thinking] = await Promise.all([
				this.rpc<PiAgentState>({ type: "get_state" }),
				this.rpc<{ levels: PiThinkingLevel[] }>({
					type: "get_available_thinking_levels",
				}),
			]);
			if (request !== this.requests) return;
			this.update({
				model: liveState?.model ?? model,
				thinkingLevel: liveState?.thinkingLevel ?? state.thinkingLevel,
				...(thinking?.levels ? { thinkingLevels: thinking.levels } : {}),
				changing: false,
			});
		} catch (error) {
			if (request !== this.requests) return;
			this.update({
				model: previousModel,
				changing: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/** Picks a thinking level with the same saved/live split as the model. */
	async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
		const state = this.current();
		if (!state || state.changing) return;
		this.update({ thinkingDirty: true, thinkingLevel: level, error: null });
		if (state.sessionPath) return;
		const request = ++this.requests;
		this.update({ changing: true });
		try {
			await this.ensurePi(state);
			await this.rpcOrThrow({ type: "set_thinking_level", level });
			if (request !== this.requests) return;
			this.update({ changing: false });
		} catch (error) {
			if (request !== this.requests) return;
			this.update({
				changing: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * Cycles to the Scope's next model with its scope thinking level. Does
	 * nothing while the catalog or scope is unresolved.
	 */
	async cycleScopeModel(): Promise<void> {
		const state = this.current();
		const catalog = this.catalog();
		if (!state || state.changing || !this.catalogReady || !catalog?.scope)
			return;
		const next = getNextPiScopeModel(this.scopeModels, state.model);
		if (!next) return;
		const level = getPiQuickCycleThinkingLevel(next);
		this.update({ modelDirty: true, thinkingDirty: false, error: null });
		if (state.sessionPath) {
			this.update({
				model: next,
				thinkingLevels: [...getPiModelThinkingLevels(next)],
				...(level != null ? { thinkingLevel: level } : {}),
			});
			return;
		}
		const request = ++this.requests;
		this.update({ changing: true, model: next });
		try {
			await this.ensurePi(state);
			await this.rpcOrThrow({
				type: "set_model",
				provider: next.provider,
				modelId: next.id,
			});
			if (level != null) {
				await this.rpcOrThrow({ type: "set_thinking_level", level });
			}
			const liveState = await this.rpc<PiAgentState>({ type: "get_state" });
			if (request !== this.requests) return;
			this.update({
				model: next,
				thinkingLevel:
					liveState?.thinkingLevel ??
					next.scopeThinkingLevel ??
					state.thinkingLevel,
				changing: false,
			});
		} catch (error) {
			if (request !== this.requests) return;
			this.update({
				changing: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async ensurePi(state: ChatRunConfigState): Promise<void> {
		await this.client.startChat({
			projectId: state.projectId,
			sessionKey: state.sessionKey,
			sessionPath: state.sessionPath,
		});
	}

	private rpc<T>(command: Record<string, unknown>): Promise<T | undefined> {
		return requestPiRpcReply<T>(
			this.client,
			this.current()?.sessionKey ?? "",
			command,
			RPC_TIMEOUT_MS,
		).then((reply) => reply?.data);
	}

	private async rpcOrThrow(command: Record<string, unknown>): Promise<void> {
		const reply = await requestPiRpcReply(
			this.client,
			this.current()?.sessionKey ?? "",
			command,
			RPC_TIMEOUT_MS,
		);
		if (reply === null) throw new Error("Pi command timed out");
	}

	private update(patch: Partial<ChatRunConfigState>): void {
		const state = this.current();
		if (state) this.current.set({ ...state, ...patch });
	}
}

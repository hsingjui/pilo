import { type Accessor, signal } from "nsh";

import type { ProjectPiModels } from "@shared/api/pi-models-types";
import type {
	PiAgentState,
	PiModel,
	PiSessionStats,
	PiThinkingLevel,
} from "@shared/api/pi-runtime-types";
import { PI_THINKING_LEVELS } from "@shared/api/pi-runtime-types";
import type { SessionHistory } from "@shared/api/sessions-types";
import type { ChatSessionRuntimeState } from "@shared/chat/session-stats";
import { chatRpcRenamesSession } from "@shared/chat/chat-session-runtime-model";
import { mergeSessionStats } from "@shared/chat/session-stats";
import {
	findMatchingPiModel,
	getNextPiScopeModel,
	getPiModelThinkingLevels,
	getPiQuickCycleThinkingLevel,
	getProjectScopeModels,
	isPiScopeCatalogResolved,
} from "@shared/pi-model-selection";
import type { PiloClientEvent } from "@shared/api/pilo-client";
import { requestPiRpcReply, type PiCommandClient } from "../client/chat-rpc";
import type { HostClient } from "@shared/api/host-client";
import { t } from "../shell/i18n";
import { isTemporarySessionKey } from "./app-state";
import type { ChatTranscriptTarget } from "./chat-transcript-store";
import type { ModelCatalogState } from "./model-catalog";

export type SessionHistoryMetadata = Pick<
	SessionHistory,
	"model" | "thinkingLevel" | "name" | "headerMissing" | "stats"
>;

export type ChatRunConfigClient = PiCommandClient &
	Pick<HostClient, "startChat" | "chatState" | "loadHistory">;

type InitialSelectionSource = "pending" | "pi" | "scope";

export type ChatRunConfigOptions = {
	/** A new chat's scope-resolved defaults; absent while a scope is pending. */
	initialModel?: PiModel;
	initialThinkingLevel?: PiThinkingLevel;
	/** Pending defaults block startup; a Pi preview never overrides live Pi. */
	initialSource?: InitialSelectionSource;
	/** This unindexed draft already has an initialized Pi; read its live selection. */
	readLiveDraft?: boolean;
	/** Skip a separate `loadHistory` call when the transcript store supplies history metadata. */
	skipHistoryLoad?: boolean;
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

type InitialSelection = {
	model: PiModel | null;
	level: PiThinkingLevel | null;
	source: InitialSelectionSource;
};

type BackgroundSend = {
	open: number;
	state: ChatRunConfigState;
	initial: InitialSelection | null;
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
	private statsRequests = 0;
	private applying:
		| { promise: Promise<void>; inBackground: boolean; pick: boolean }
		| undefined;
	private readonly backgroundSends = new Map<
		string,
		BackgroundSend & { ready: Promise<boolean> }
	>();
	/** A new chat's initial config, pushed on the first agent state. */
	private pendingInitial: InitialSelection | null = null;

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
		this.disconnect = undefined;
		this.applying = undefined;
		const background = this.backgroundSends.get(target.sessionKey);
		const model = background
			? background.state.model
			: (options.initialModel ?? null);
		this.pendingInitial =
			target.sessionPath || background || options.readLiveDraft
				? null
				: {
						model: options.initialModel ?? null,
						level: options.initialThinkingLevel ?? null,
						source: options.initialSource ?? "scope",
					};
		this.current.set({
			sessionKey: target.sessionKey,
			projectId: target.projectId,
			sessionPath: target.sessionPath ?? undefined,
			model,
			thinkingLevel: background
				? background.state.thinkingLevel
				: (options.initialThinkingLevel ?? null),
			thinkingLevels: [...getPiModelThinkingLevels(model)],
			modelDirty: false,
			thinkingDirty: false,
			session: null,
			headerMissing: false,
			compacting: false,
			changing: !!background,
			ready: false,
			error: null,
		});
		const disconnect = await this.client.connectEvents({
			onMessage: (message) => {
				if (open !== this.opens || message.type !== "events") return;
				for (const event of message.events) {
					if (event.sessionKey === target.sessionKey) this.applyEvent(event);
				}
			},
			onStatus: () => {},
		});
		if (open !== this.opens) {
			disconnect();
			return;
		}
		this.disconnect = disconnect;
		if (target.sessionPath && !options.skipHistoryLoad) {
			void this.applyHistoryMetadata(open, target);
		}
		if (background) {
			// The original send owns Pi's selection even if this chat is reopened.
			const ready = await background.ready.catch(() => false);
			if (open !== this.opens) return;
			if (!ready) {
				this.pendingInitial = background.initial;
				this.update({
					model: background.state.model,
					thinkingLevel: background.state.thinkingLevel,
					thinkingLevels: background.state.thinkingLevels,
					modelDirty: background.state.modelDirty,
					thinkingDirty: background.state.thinkingDirty,
				});
			}
			this.update({ changing: false });
		}
		await this.refresh(open, !background);
	}

	/** A late catalog can update the defaults until Pi or a manual pick takes over. */
	adoptInitial(
		model: PiModel | null,
		level: PiThinkingLevel | null,
		source: InitialSelectionSource = "scope",
	): void {
		const initial = this.pendingInitial;
		const state = this.current();
		if (!initial || !state || state.changing || state.modelDirty) return;
		Object.assign(initial, { model, level, source });
		this.update({
			model,
			thinkingLevel: state.thinkingDirty ? state.thinkingLevel : level,
			thinkingLevels: [...getPiModelThinkingLevels(model)],
		});
	}

	/** Enriches a saved chat's model when its project catalog arrives. */
	enrichSavedModel(): void {
		const state = this.current();
		if (!state?.sessionPath || !state.model || state.session?.sessionId) return;
		const model = findMatchingPiModel(
			this.catalogModels(state.projectId),
			state.model,
		);
		if (!model || model === state.model) return;
		this.update({
			model,
			thinkingLevels: [...getPiModelThinkingLevels(model)],
		});
	}

	/**
	 * The open new chat now has the file Pi saves it to. It is the same chat:
	 * the selection and a write of it in flight are kept, and Pi is started
	 * on that file from now on.
	 */
	adoptSessionPath(sessionPath: string): void {
		if (this.current()) this.update({ sessionPath });
	}

	close(): void {
		this.opens += 1;
		this.disconnect?.();
		this.disconnect = undefined;
		this.applying = undefined;
		this.pendingInitial = null;
		this.current.set(null);
	}

	/** Applies metadata from an already loaded history without a second read. */
	applyHistory(history: SessionHistoryMetadata, sessionKey?: string): void {
		const current = this.current();
		if (
			!current ||
			(sessionKey !== undefined && current.sessionKey !== sessionKey)
		)
			return;
		let historicalModel: PiModel | null = null;
		if (history.model) {
			historicalModel = findMatchingPiModel(
				this.catalogModels(current.projectId),
				history.model,
			) ?? {
				provider: history.model.provider,
				id: history.model.id,
				name: history.model.id,
				reasoning: false,
			};
		}
		const stats = history.stats;
		const previous = current.session;
		const live = Boolean(previous?.sessionId);
		this.update({
			headerMissing: history.headerMissing ?? false,
			session: {
				...previous,
				name: live
					? (previous?.name ?? history.name ?? undefined)
					: (history.name ?? previous?.name ?? undefined),
				tokens: live
					? (previous?.tokens ?? stats?.tokens)
					: (stats?.tokens ?? previous?.tokens),
				cost: live
					? (previous?.cost ?? stats?.cost)
					: (stats?.cost ?? previous?.cost),
				contextTokens: live
					? (previous?.contextTokens ?? stats?.contextTokens)
					: (stats?.contextTokens ?? previous?.contextTokens),
			},
			...(!current.modelDirty && !live && historicalModel
				? {
						model: historicalModel,
						thinkingLevels: [...getPiModelThinkingLevels(historicalModel)],
					}
				: {}),
			...(!current.thinkingDirty &&
			!live &&
			history.thinkingLevel &&
			PI_THINKING_LEVELS.includes(history.thinkingLevel as PiThinkingLevel)
				? { thinkingLevel: history.thinkingLevel as PiThinkingLevel }
				: {}),
		});
	}

	/** A saved session's model, thinking and stats seed the selection. */
	private async applyHistoryMetadata(
		open: number,
		target: ChatTranscriptTarget,
	): Promise<void> {
		if (!target.sessionPath) return;
		const result = await this.client
			.loadHistory(target.projectId, target.sessionPath, {
				// An empty event window still includes the header and stats.
				startMessage: Number.MAX_SAFE_INTEGER,
				messageLimit: 1,
				includeMessageIndex: false,
			})
			.catch(() => null);
		if (!result || open !== this.opens) return;
		this.applyHistory(result.history, target.sessionKey);
	}

	private catalogModels(projectId: string): readonly PiModel[] {
		const catalog = this.catalog()?.catalog;
		return catalog?.projectId === projectId ? catalog.models : [];
	}

	/** Whether the catalog knows every model's Scope membership. */
	get catalogReady(): boolean {
		const state = this.catalog();
		if (
			!state?.catalog ||
			!state.scope ||
			state.catalog.projectId !== this.current()?.projectId
		)
			return false;
		return (
			state.scope.models !== null ||
			(!state.provisional && isPiScopeCatalogResolved(state.catalog.models))
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
	async refresh(open = this.opens, apply = true): Promise<void> {
		const state = this.current();
		if (!state || open !== this.opens) return;
		const { sessionKey } = state;
		const background = this.backgroundSends.get(sessionKey);
		if (background && background.open !== open) return;
		const request = ++this.requests;
		const runtime = await this.client
			.chatState(state.sessionKey)
			.catch(() => null);
		if (request !== this.requests || open !== this.opens) return;
		if (!runtime || runtime.snapshot.state !== "running") {
			this.update({ ready: true, compacting: runtime?.compacting ?? false });
			return;
		}
		if (apply && runtime.initialized) {
			await this.applySelection().catch(() => {});
			if (request !== this.requests || open !== this.opens) return;
		}
		const agentState = await this.rpc<PiAgentState>(sessionKey, {
			type: "get_state",
		});
		if (request !== this.requests || open !== this.opens) return;
		if (!agentState) {
			this.update({ ready: true });
			return;
		}
		const current = this.current();
		if (!current) return;
		// Pi's identity and title are usable before the slower stats requests finish.
		const patch: Partial<ChatRunConfigState> = {
			ready: true,
			session: {
				...current.session,
				sessionId: agentState.sessionId,
				sessionPath: agentState.sessionFile,
				name: agentState.sessionName,
			},
		};
		// Only a resolved Pi preview yields to live Pi. Keep unresolved defaults pending.
		const followsPi = this.pendingInitial?.source === "pi";
		if (followsPi) this.pendingInitial = null;
		const initial = this.pendingInitial;
		const defaultsPending = initial?.source === "pending";
		if (
			!defaultsPending &&
			!current.modelDirty &&
			!initial?.model &&
			(followsPi || agentState.model)
		) {
			patch.model = agentState.model ?? null;
			patch.thinkingLevels = [...getPiModelThinkingLevels(agentState.model)];
		}
		if (
			!defaultsPending &&
			!current.thinkingDirty &&
			!initial?.level &&
			!current.changing
		) {
			patch.thinkingLevel = agentState.thinkingLevel;
		}
		this.update(patch);
		const [, thinking] = await Promise.all([
			this.refreshStats(),
			defaultsPending || initial?.model
				? undefined
				: this.rpc<{ levels: PiThinkingLevel[] }>(sessionKey, {
						type: "get_available_thinking_levels",
					}),
		]);
		if (
			request === this.requests &&
			open === this.opens &&
			thinking?.levels &&
			!this.pendingInitial?.model &&
			this.pendingInitial?.source !== "pending" &&
			!this.current()?.changing
		) {
			this.update({ thinkingLevels: thinking.levels });
		}
	}

	/** Session events move compaction state and refresh stats during a turn. */
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
			// At stream start Pi has the prompt; a snapshot marks a model response
			// ending, even if the agent is still running tools in the same turn.
			case "assistant_message_start":
			case "assistant_text_snapshot":
			case "assistant_message_end":
				void this.refreshStats();
				return;
			case "rpc_message":
				// The header shows Pi's new session name, as from automatic naming.
				if (chatRpcRenamesSession(event.message))
					void this.refresh(this.opens, false);
				return;
		}
	}

	/** Re-reads stats alone; a post-compaction unknown keeps the last usage. */
	async refreshStats(): Promise<void> {
		const state = this.current();
		if (!state) return;
		const open = this.opens;
		const request = ++this.statsRequests;
		const stats = await this.rpc<PiSessionStats>(state.sessionKey, {
			type: "get_session_stats",
		});
		if (request !== this.statsRequests || open !== this.opens || !stats) return;
		this.update({
			session: mergeSessionStats(this.current()?.session ?? null, stats),
		});
	}

	/** Waits for the target Pi to confirm the selection before sending. */
	async prepareToSend(
		sessionKey: string,
		ensureReady?: () => Promise<boolean>,
		inBackground = false,
	): Promise<boolean> {
		const open = this.opens;
		const state = this.current();
		if (state?.sessionKey !== sessionKey) return false;
		const requireDefaults = (initial: InitialSelection | null) => {
			if (initial?.source !== "pending") return;
			const catalog = this.catalog();
			const projectCatalog =
				catalog?.projectId === state.projectId ? catalog : null;
			throw new Error(
				projectCatalog?.error ??
					(projectCatalog?.loaded && !projectCatalog.scope
						? t("chat.modelScopeLoadFailed")
						: t("chat.modelDefaultsPending")),
			);
		};
		requireDefaults(this.pendingInitial);
		if (!inBackground || !ensureReady) {
			if (ensureReady && !(await ensureReady())) return false;
			if (open !== this.opens) return false;
			requireDefaults(this.pendingInitial);
			await this.applySelection();
			return open === this.opens;
		}
		const background = { open, state, initial: this.pendingInitial };
		const ready = Promise.resolve().then(async () => {
			if (!(await ensureReady())) return false;
			requireDefaults(
				open === this.opens ? this.pendingInitial : background.initial,
			);
			await this.applySelection(false, background);
			return true;
		});
		this.backgroundSends.set(sessionKey, { ...background, ready });
		try {
			return await ready;
		} finally {
			if (this.backgroundSends.get(sessionKey)?.ready === ready)
				this.backgroundSends.delete(sessionKey);
		}
	}

	/** Picks a model; pushed to a live chat, kept local for a saved session. */
	async setModel(model: PiModel): Promise<void> {
		await this.choose({
			model,
			modelDirty: true,
			thinkingDirty: false,
			thinkingLevels: [...getPiModelThinkingLevels(model)],
			thinkingLevel:
				model.defaultThinkingLevel ?? this.current()?.thinkingLevel ?? null,
		});
	}

	async setThinkingLevel(level: PiThinkingLevel): Promise<void> {
		await this.choose({ thinkingDirty: true, thinkingLevel: level });
	}

	/** Cycles to the next model and thinking level in the resolved Scope. */
	async cycleScopeModel(): Promise<void> {
		if (!this.catalogReady || !this.catalog()?.scope) return;
		const next = getNextPiScopeModel(
			this.scopeModels,
			this.current()?.model ?? null,
		);
		if (!next) return;
		const level = getPiQuickCycleThinkingLevel(next);
		await this.choose({
			model: next,
			modelDirty: true,
			thinkingDirty: level != null,
			thinkingLevels: [...getPiModelThinkingLevels(next)],
			...(level != null ? { thinkingLevel: level } : {}),
		});
	}

	private async choose(patch: Partial<ChatRunConfigState>): Promise<void> {
		const state = this.current();
		// A send owns Pi's selection; only an earlier pick's write (such as a
		// new chat's Pi starting) lets another pick follow it.
		if (
			!state ||
			(state.changing && (!this.applying?.pick || this.applying.inBackground))
		)
			return;
		const open = this.opens;
		this.requests += 1;
		if (patch.modelDirty) this.pendingInitial = null;
		this.update({ ...patch, error: null });
		if (state.sessionPath) return;
		try {
			// The earlier write captured the old selection; push the latest after it.
			while (this.applying && open === this.opens)
				await this.applying.promise.catch(() => {});
			if (open !== this.opens) return;
			await this.applySelection(true);
			await this.refresh(open, false);
		} catch {
			// The selection stays pending and sending reports a failed write.
		}
	}

	/** Startup refresh and sending share one config write for the open chat. */
	private async applySelection(
		start = false,
		background?: BackgroundSend,
	): Promise<void> {
		const open = background?.open ?? this.opens;
		const isOpen = () => open === this.opens;
		if (isOpen() && this.applying) {
			if (background) this.applying.inBackground = true;
			return this.applying.promise;
		}
		const state = isOpen() ? this.current() : background?.state;
		if (!state) return;
		const pending = isOpen() ? this.pendingInitial : background?.initial;
		if (pending?.source === "pending") return;
		const initial = pending?.source === "scope" ? pending : null;
		const model = state.modelDirty ? state.model : initial?.model;
		const level = state.thinkingDirty ? state.thinkingLevel : initial?.level;
		if (!model && !level) return;
		const { projectId, sessionKey, sessionPath } = state;
		const canApply = () => application.inBackground || isOpen();
		const promise = Promise.resolve()
			.then(async () => {
				if (!canApply()) return;
				if (start)
					await this.client.startChat({
						projectId,
						sessionKey,
						sessionPath,
						...(isTemporarySessionKey(sessionKey) ? { noSession: true } : {}),
					});
				if (!canApply()) return;
				const agent = await this.rpc<PiAgentState>(sessionKey, {
					type: "get_state",
				});
				if (!canApply()) return;
				if (!agent) throw new Error("Pi did not return its run configuration");
				const modelChanged =
					model &&
					(agent.model?.provider !== model.provider ||
						agent.model.id !== model.id);
				if (modelChanged) {
					await this.rpcOrThrow(sessionKey, {
						type: "set_model",
						provider: model.provider,
						modelId: model.id,
					});
					if (!canApply()) return;
				}
				if (level && (modelChanged || agent.thinkingLevel !== level)) {
					await this.rpcOrThrow(sessionKey, {
						type: "set_thinking_level",
						level,
					});
				}
				if (initial && isOpen()) {
					this.pendingInitial = null;
					this.update({
						modelDirty: state.modelDirty || initial.model !== null,
						thinkingDirty: state.thinkingDirty || initial.level !== null,
					});
				}
			})
			.catch((error: unknown) => {
				if (isOpen()) {
					this.update({
						error: error instanceof Error ? error.message : String(error),
					});
				}
				if (canApply()) throw error;
			})
			.finally(() => {
				if (!isOpen()) return;
				this.applying = undefined;
				this.update({ changing: false });
			});
		const application = { promise, inBackground: !!background, pick: start };
		if (isOpen()) {
			this.applying = application;
			this.update({ changing: true, error: null });
		}
		return promise;
	}

	private rpc<T>(
		sessionKey: string,
		command: Record<string, unknown>,
	): Promise<T | undefined> {
		return requestPiRpcReply<T>(
			this.client,
			sessionKey,
			command,
			RPC_TIMEOUT_MS,
		).then(
			(reply) => reply?.data,
			() => undefined,
		);
	}

	private async rpcOrThrow(
		sessionKey: string,
		command: Record<string, unknown>,
	): Promise<void> {
		const reply = await requestPiRpcReply(
			this.client,
			sessionKey,
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

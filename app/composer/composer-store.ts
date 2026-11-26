import {
	type Accessor,
	batch,
	computed,
	effect,
	platform,
	signal,
	untracked,
} from "nsh";
import { Storage } from "nsh";

import { chatSessionKey } from "@shared/api/chat-session-key";
import type { ChatSessionRuntimeState } from "@shared/api/chat-session-types";
import { bytesToBase64 } from "@shared/base64";
import type {
	PiCommand,
	PiCompactionResult,
	PiPromptResult,
} from "@shared/api/pi-runtime-types";
import {
	discardRemovedChatFiles,
	registerChatFile,
	retainChatFiles,
} from "@shared/chat/chat-file-lifecycle";
import {
	fileMentionValue,
	readChatMentionDraft,
	removeChatMention,
} from "@shared/chat/chat-mentions";
import {
	CHAT_INPUT_HISTORY_LIMIT,
	isChatInputHistoryCursorValid,
	moveChatInputHistory,
	type ChatInputHistoryDirection,
} from "@shared/chat/chat-input-history-cursor";
import {
	createChatSubmission,
	formatChatImageSize,
	resolveChatImageMimeType,
	summarizeChatImages,
	toPiImageContents,
	chatSubmissionHasContent,
	chatSubmissionMessage,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_IMAGE_COUNT,
	MAX_CHAT_IMAGE_TOTAL_BYTES,
	type ChatImageAttachment,
	type ChatSubmission,
} from "@shared/chat/chat-submission";
import {
	createPiCommandSuggestions,
	createPiExtensionCommandNames,
	mergePiCommands,
	parseSlashCommand,
} from "@shared/chat/pi-command-suggestions";
import {
	COMPOSER_SEND_MODE_STORAGE_KEY,
	DEFAULT_COMPOSER_SEND_MODE,
	isPersistedComposerSendMode,
	type ComposerSendMode,
	type PersistedComposerSendMode,
} from "@shared/chat/send-mode";
import { piModelSupportsImages } from "@shared/pi-model-selection";
import type { PiModel } from "@shared/api/pi-runtime-types";
import {
	sessionMentionValue,
	type SessionMention,
} from "@shared/chat/session-mentions";
import type { ComposerSuggestion } from "@shared/chat/composer-suggestions";
import {
	chatRuntimeHasOpenTurn,
	runtimeSessionPathKey,
} from "@shared/chat/chat-session-runtime-model";
import { appLocale, t } from "../shell/i18n";
import { rememberLocalChatImages } from "../chat/chat-user-image-cache";
import { requestPiRpc, requestPiRpcOutcome } from "../client/chat-rpc";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import {
	type AppState,
	isExternalTurnOpen,
	isTemporarySessionKey,
} from "../state/app-state";
import type { ChatTranscriptStore } from "../state/chat-transcript-store";
import type { ModelCatalogStore } from "../state/model-catalog";

/** The open chat the composer talks to. */
export type ComposerTarget = {
	sessionKey: string;
	projectId: string;
	sessionPath?: string | null;
};

export type ComposerClient = Pick<
	NshPiloClient,
	| "startChat"
	| "chatState"
	| "sendChatCommand"
	| "connectEvents"
	| "searchProjectFiles"
	| "uploadChatFile"
	| "removeChatFile"
> &
	// Optional so test stand-ins without native file reads still fit.
	Partial<Pick<NshPiloClient, "readLocalFile">>;

export type ComposerViewState = {
	value: string;
	caret: number;
	composing: boolean;
	sending: boolean;
	dragging: boolean;
	sendMode: ComposerSendMode;
	images: ChatImageAttachment[];
	status: string | null;
};

export type ComposerQueueKind = "steer" | "follow_up";

export type ComposerQueueEnqueueResult =
	| "queued"
	| "started"
	| "handled"
	| "cancelled";

/** Tracks queued messages per session for edits, replay, and stop/send-now coordination. */
export type ComposerQueue = {
	readonly queueOwner?: string;
	busy: (sessionKey: string) => boolean;
	enqueue: (
		target: ComposerTarget,
		kind: ComposerQueueKind,
		submission: ChatSubmission,
		canDispatch?: () => boolean,
		beforeSend?: () => Promise<boolean>,
	) => Promise<ComposerQueueEnqueueResult | void>;
	adoptQueued?: (
		sessionKey: string,
		kind: ComposerQueueKind,
		submission: ChatSubmission,
	) => void;
	sendNow?: (
		target: ComposerTarget,
		submission: ChatSubmission,
		composer: ComposerStore,
		canDispatchPrompt: () => boolean,
	) => Promise<boolean>;
	clearForStop?: (
		target: ComposerTarget,
		composer: ComposerStore,
	) => Promise<void>;
};

type PrepareToSend = (
	sessionKey: string,
	ensureReady?: () => Promise<boolean>,
	inBackground?: boolean,
) => Promise<boolean>;

type ComposerDraft = Pick<ComposerViewState, "value" | "images">;

type ComposerDraftTextStorage = {
	read: (target: ComposerTarget) => string | null;
	write: (target: ComposerTarget, value: string) => boolean;
};

const EMPTY_DRAFT: ComposerDraft = { value: "", images: [] };

/** Toast-like feedback emitted by slash commands (e.g. `/compact`). */
export type ComposerNotice = {
	variant?: "default" | "success" | "info" | "warning" | "error";
	title: string;
	description?: string;
};

/** Where a prompt that starts a turn shows before Pi echoes it. */
export type ComposerTranscript = Pick<
	ChatTranscriptStore,
	"submitLocal" | "setLocalStatus" | "dropLocal"
> &
	Partial<Pick<ChatTranscriptStore, "hasLiveTurn">>;

/** How long Pi may take to accept a prompt, as the WebUI waits. */
const PROMPT_REPLY_TIMEOUT_MS = 120_000;

const INPUT_HISTORY_KEY = "pilo.chatInputHistory.v1";
const ATTACHMENT_NAME_LIMIT = 80;

let attachmentSequence = 0;

function attachmentName(uri: string): string {
	try {
		const path = decodeURIComponent(new URL(uri).pathname);
		return path.split("/").filter(Boolean).pop() ?? "file";
	} catch {
		return "file";
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

type HistoryStore = Record<string, string[]>;

/**
 * Draft text and images are isolated per session (`sessionKey`) to avoid
 * cross-talk across parallel chats. History and non-destructive send mode
 * (`steer` / `follow_up`) persist in `Storage`.
 */
export class ComposerStore {
	private readonly client: ComposerClient;
	private readonly app: Accessor<AppState>;
	private readonly activeModel?: Accessor<PiModel | null>;
	private readonly catalog?: Pick<ModelCatalogStore, "state" | "refresh">;
	private readonly beforeSend?: PrepareToSend;
	private readonly waitForStartupApproval?: (
		sessionKey: string,
	) => Promise<boolean>;
	private readonly queue?: ComposerQueue;
	private readonly transcript?: ComposerTranscript;
	private readonly onPendingDraft?: (
		target: ComposerTarget,
		text: string | null,
	) => void;
	private readonly onUnsentDraft?: (
		target: ComposerTarget,
		text: string | null,
	) => void;
	private readonly onPromptStarted?: (
		target: ComposerTarget,
		text: string,
	) => void;
	private readonly onNewChat?: () => void;
	private readonly onCompacted?: (result: PiCompactionResult) => void;
	private readonly onNotice?: (notice: ComposerNotice) => void;
	private readonly draftTextStorage?: ComposerDraftTextStorage;
	private readonly drafts = new Map<string, ComposerDraft>();
	private readonly sessionStatuses = new Map<string, string>();
	private persistedSendMode: PersistedComposerSendMode =
		DEFAULT_COMPOSER_SEND_MODE;
	private readonly pendingCompactMap = signal<ReadonlyMap<string, string>>(
		new Map(),
	);
	private readonly stateSignal = signal<ComposerViewState>({
		value: "",
		caret: 0,
		composing: false,
		sending: false,
		dragging: false,
		sendMode: DEFAULT_COMPOSER_SEND_MODE,
		images: [],
		status: null,
	});
	private readonly targetSignal = signal<ComposerTarget | null>(null);
	private readonly sessionCommandsSignal = signal<{
		sessionKey: string;
		commands: readonly PiCommand[];
	} | null>(null);
	private readonly fileSuggestionsSignal = signal<
		readonly ComposerSuggestion[]
	>([]);
	private draftVersion = 0;
	private readonly histories: HistoryStore = {};
	private historiesLoad: Promise<void> | undefined;
	private readonly removedFilePaths = new Set<string>();
	private historyCursor: number | null = null;
	/**
	 * The blocking send in flight (`/compact`, `send_now`, extension commands,
	 * or sends without a queue), so Stop can end it at any stage.
	 */
	private readonly activeSubmits = signal<
		ReadonlyMap<string, { dispatched: boolean; stopped: boolean }>
	>(new Map());
	/**
	 * A plain prompt that is starting Pi or awaiting Pi's prompt reply while
	 * allowing immediate follow-up/steer messages to queue behind it.
	 */
	private readonly startingPrompts = new Map<
		string,
		{ dispatched: boolean; stopped: boolean; settled: Promise<boolean> }
	>();
	private readonly startingPromptSessions = signal<ReadonlySet<string>>(
		new Set(),
	);
	private fileQueryRequest = 0;
	private commandsRequest = 0;
	private sessionCommandsInFlight: string | null = null;

	readonly state: Accessor<ComposerViewState>;
	readonly target: Accessor<ComposerTarget | null>;
	readonly commands: Accessor<readonly ComposerSuggestion[]>;
	readonly fileSuggestions: Accessor<readonly ComposerSuggestion[]>;
	private readonly appProjects: Accessor<AppState["projects"]>;
	private readonly appSessionIndexes: Accessor<AppState["sessionIndexes"]>;
	private readonly sessionMentionsComputed: Accessor<readonly SessionMention[]>;
	private readonly sessionsByValueComputed: Accessor<
		ReadonlyMap<string, SessionMention>
	>;
	private readonly mentionDraftComputed: Accessor<
		ReturnType<typeof readChatMentionDraft>
	>;
	private readonly readOnlyComputed: Accessor<boolean>;

	constructor(deps: {
		client: ComposerClient;
		app: Accessor<AppState>;
		/** The open chat's active model, used to check image input support early. */
		activeModel?: Accessor<PiModel | null>;
		draftTextStorage?: ComposerDraftTextStorage;
		/** The active project's model and command catalog, for `/` suggestions. */
		catalog?: Pick<ModelCatalogStore, "state" | "refresh">;
		beforeSend?: PrepareToSend;
		waitForStartupApproval?: (sessionKey: string) => Promise<boolean>;
		queue?: ComposerQueue;
		/** Shows a prompt that starts a turn at once, before Pi takes it. */
		transcript?: ComposerTranscript;
		/** Keeps a background send's draft navigable until the prompt settles. */
		onPendingDraft?: (target: ComposerTarget, text: string | null) => void;
		/** Keeps unsent new-chat drafts reachable after navigation. */
		onUnsentDraft?: (target: ComposerTarget, text: string | null) => void;
		/** Called once Pi started a turn for a prompt (not a steer or follow-up). */
		onPromptStarted?: (target: ComposerTarget, text: string) => void;
		/** Starts a new chat when the user submits `/new`. */
		onNewChat?: () => void;
		/** Called after `/compact` succeeds so run config / stats can refresh. */
		onCompacted?: (result: PiCompactionResult) => void;
		/** Surfaces slash-command notifications as app toasts. */
		onNotice?: (notice: ComposerNotice) => void;
	}) {
		this.client = deps.client;
		this.app = deps.app;
		this.activeModel = deps.activeModel;
		this.draftTextStorage = deps.draftTextStorage;
		this.catalog = deps.catalog;
		this.beforeSend = deps.beforeSend;
		this.waitForStartupApproval = deps.waitForStartupApproval;
		this.queue = deps.queue;
		this.transcript = deps.transcript;
		this.onPendingDraft = deps.onPendingDraft;
		this.onUnsentDraft = deps.onUnsentDraft;
		this.onPromptStarted = deps.onPromptStarted;
		this.onNewChat = deps.onNewChat;
		this.onCompacted = deps.onCompacted;
		this.onNotice = deps.onNotice;
		this.state = this.stateSignal;
		this.target = this.targetSignal;
		this.commands = computed(() =>
			createPiCommandSuggestions(this.mergedPiCommands()),
		);
		this.fileSuggestions = this.fileSuggestionsSignal;
		this.appProjects = computed(() => this.app().projects);
		this.appSessionIndexes = computed(() => this.app().sessionIndexes);
		this.sessionMentionsComputed = computed(() => {
			const projects = new Map(
				this.appProjects().map((project) => [project.id, project]),
			);
			return Object.values(this.appSessionIndexes())
				.flatMap((index) => index.sessions)
				.flatMap((session): SessionMention[] => {
					const project = projects.get(session.projectId);
					if (!project || !session.sessionPath) return [];
					return [
						{
							connectionId: session.connectionId,
							projectId: session.projectId,
							path: session.sessionPath,
							title:
								session.name ?? session.firstUserMessagePreview ?? "Session",
							projectName: project.name,
							updatedAt: Date.parse(session.lastMessageAt ?? session.updatedAt),
						},
					];
				})
				.sort((a, b) => b.updatedAt - a.updatedAt);
		});
		this.sessionsByValueComputed = computed(
			() =>
				new Map(
					this.sessionMentionsComputed().map((mention) => [
						sessionMentionValue(mention.path),
						mention,
					]),
				),
		);
		this.mentionDraftComputed = computed(() => {
			const value = this.stateSignal().value;
			if (!value.includes("@")) return { text: value, references: [] };
			return readChatMentionDraft(value, this.sessionsByValueComputed());
		});
		this.readOnlyComputed = computed(() => {
			const target = this.targetSignal();
			return (
				!!target &&
				isExternalTurnOpen(this.app(), target.projectId, target.sessionPath)
			);
		});
		void Storage.getItem(COMPOSER_SEND_MODE_STORAGE_KEY)
			.then((stored) => {
				if (isPersistedComposerSendMode(stored)) {
					this.persistedSendMode = stored;
					this.stateSignal.update((s) => ({ ...s, sendMode: stored }));
				}
			})
			.catch(() => {});
	}

	/** Swaps the open chat without losing its draft. */
	setTarget(target: ComposerTarget | null) {
		const previous = this.targetSignal();
		if (previous?.sessionKey === target?.sessionKey) {
			if (previous && target && previous.sessionPath !== target.sessionPath) {
				batch(() => {
					this.targetSignal.set(target);
					if (!previous.sessionPath && target.sessionPath) {
						this.adoptDraftPath(previous, target);
					}
				});
			}
			return;
		}
		if (previous) {
			this.sessionStatuses.delete(previous.sessionKey);
		}
		const draft = target ? this.draftFor(target) : EMPTY_DRAFT;
		batch(() => {
			this.clearFileSuggestions();
			this.commandsRequest++;
			this.sessionCommandsSignal.set(null);
			this.sessionCommandsInFlight = null;
			if (previous?.projectId !== target?.projectId) {
				this.historyCursor = null;
			}
			this.draftVersion++;
			this.targetSignal.set(target);
			this.stateSignal.update((s) => ({
				...s,
				...draft,
				caret: draft.value.length,
				// 切会话时复位临时的一次性打断模式，回到安全记忆模式。
				sendMode: this.persistedSendMode,
				status: target
					? (this.sessionStatuses.get(target.sessionKey) ?? null)
					: null,
				composing: false,
				dragging: false,
				sending: target ? this.activeSubmits().has(target.sessionKey) : false,
			}));
		});
	}

	/** Identity of the draft, including edits that were undone and chat switches. */
	get draftRevision() {
		return this.draftVersion;
	}

	private updateDraft(change: (state: ComposerViewState) => ComposerViewState) {
		batch(() => {
			const cached = untracked(() => {
				const current = this.stateSignal();
				const next = change(current);
				const changed =
					next.value !== current.value || next.images !== current.images;
				if (changed) this.draftVersion++;
				const target = changed ? this.targetSignal() : null;
				this.stateSignal.set(next);
				return target ? { target, next } : null;
			});
			// Persist and notify external draft observers only after `stateSignal` holds `next`.
			if (cached) this.cacheDraft(cached.target, cached.next);
		});
	}

	setValue(value: string, caret?: number) {
		// Native undo can restore a reference whose uploaded file has been removed.
		if (this.removedFilePaths.size && value.includes("@")) {
			const sessions = this.sessionsByValue();
			for (const reference of readChatMentionDraft(value, sessions)
				.references) {
				if (
					reference.kind === "file" &&
					this.removedFilePaths.has(reference.path)
				) {
					value = removeChatMention(value, reference, sessions);
				}
			}
		}
		const previous = this.stateSignal().value;
		if (previous !== value) {
			this.historyCursor = null;
			discardRemovedChatFiles(previous, value);
		}
		this.updateDraft((s) => ({
			...s,
			value,
			caret: Math.min(caret ?? value.length, value.length),
			status: previous !== value ? null : s.status,
		}));
	}

	setCaret(caret: number) {
		this.stateSignal.update((s) => ({ ...s, caret }));
	}

	setComposing(composing: boolean) {
		this.stateSignal.update((s) => ({ ...s, composing }));
	}

	setDragging(dragging: boolean) {
		this.stateSignal.update((s) => ({ ...s, dragging }));
	}

	setStatus(status: string | null, sessionKey?: string) {
		if (
			sessionKey !== undefined &&
			this.targetSignal()?.sessionKey !== sessionKey
		)
			return;
		this.stateSignal.update((s) => ({ ...s, status }));
	}

	/** Surfaces an operational error via toast when wired, otherwise session status. */
	reportError(title: string, description?: string, sessionKey?: string) {
		if (this.onNotice) {
			this.notify({ variant: "error", title, description });
			return;
		}
		this.setStatus(
			description && description !== title ? `${title}: ${description}` : title,
			sessionKey,
		);
	}

	setSendMode(sendMode: ComposerSendMode) {
		this.stateSignal.update((s) => ({ ...s, sendMode }));
		// 仅持久化无损发送方式；破坏性的“打断并发送”仅作为单次显式动作，不全局记忆。
		if (isPersistedComposerSendMode(sendMode)) {
			this.persistedSendMode = sendMode;
			void Storage.setItem(COMPOSER_SEND_MODE_STORAGE_KEY, sendMode).catch(
				() => {},
			);
		}
	}

	/** 发送或退出运行态后将一次性 `send_now` 复位回已记忆的无损发送方式。 */
	resetTransientSendMode() {
		if (this.stateSignal().sendMode === "send_now") {
			this.stateSignal.update((s) => ({
				...s,
				sendMode: this.persistedSendMode,
			}));
		}
	}

	pendingCompact(
		sessionKey = this.targetSignal()?.sessionKey ?? null,
	): boolean {
		return sessionKey !== null && this.pendingCompactMap().has(sessionKey);
	}

	cancelPendingCompact(sessionKey = this.targetSignal()?.sessionKey ?? null) {
		if (!sessionKey || !this.pendingCompactMap().has(sessionKey)) return;
		this.pendingCompactMap.update((map) => {
			const next = new Map(map);
			next.delete(sessionKey);
			return next;
		});
	}

	/** 立即压缩当前会话上下文；若正在回复，则自动安排在本轮结束后执行。 */
	async compact(customInstructions = "") {
		const target = this.targetSignal();
		if (
			!target ||
			this.readOnly() ||
			this.compacting() ||
			this.activeSubmits().has(target.sessionKey) ||
			this.queue?.busy(target.sessionKey)
		) {
			return;
		}
		if (this.running()) {
			this.pendingCompactMap.update((map) =>
				new Map(map).set(target.sessionKey, customInstructions),
			);
			this.notify({
				variant: "info",
				title: t("chat.compactScheduled"),
			});
			return;
		}
		await this.executeCompact(target, customInstructions);
	}

	/** Keeps draft promotion and scheduled work independent of the visible composer. */
	followBackgroundSessions() {
		effect(() => {
			const { unsentDrafts, chatSessions, sessionIndexes } = this.app();
			if (!unsentDrafts?.size) return;
			for (const { sessionKey, projectId, sessionPath } of chatSessions) {
				if (!sessionPath || !unsentDrafts.has(sessionKey)) continue;
				if (this.isIndexedDraftPath(sessionIndexes, projectId, sessionPath)) {
					untracked(() =>
						this.adoptDraftPath(
							{ sessionKey, projectId },
							{ sessionKey, projectId, sessionPath },
						),
					);
				}
			}
		});
		effect(() => {
			const pending = this.pendingCompactMap();
			if (!pending.size || this.app().status.type !== "ready") return;
			for (const sessionKey of pending.keys())
				void this.flushPendingCompact(sessionKey);
		});
	}

	async flushPendingCompact(sessionKey = this.targetSignal()?.sessionKey) {
		if (!sessionKey) return;
		const instructions = this.pendingCompactMap().get(sessionKey);
		if (instructions === undefined) return;
		if (
			this.running(sessionKey) ||
			this.activeSubmits().has(sessionKey) ||
			this.queue?.busy(sessionKey)
		)
			return;
		const chat = this.chatState(sessionKey);
		if (
			!chat?.initialized ||
			(chat.snapshot && chat.snapshot.state !== "running")
		) {
			untracked(() => this.cancelPendingCompact(sessionKey));
			return;
		}
		if (
			isTemporarySessionKey(sessionKey) &&
			this.targetSignal()?.sessionKey !== sessionKey
		)
			return;
		const { projectId, sessionPath } = chat;
		if (isExternalTurnOpen(this.app(), projectId, sessionPath)) return;
		await untracked(() =>
			batch(() => {
				this.cancelPendingCompact(sessionKey);
				return this.executeCompact(
					{ sessionKey, projectId, sessionPath },
					instructions,
					{ scheduled: chat },
				);
			}),
		);
	}

	/** The open chat's runtime state, as the app store last reported it. */
	chatState(
		sessionKey = this.targetSignal()?.sessionKey,
	): ChatSessionRuntimeState | null {
		if (!sessionKey) return null;
		return (
			this.app().chatSessions.find(
				(session) => session.sessionKey === sessionKey,
			) ?? null
		);
	}

	private setStartingPrompt(
		sessionKey: string,
		entry: {
			dispatched: boolean;
			stopped: boolean;
			settled: Promise<boolean>;
		} | null,
	) {
		if (entry) {
			this.startingPrompts.set(sessionKey, entry);
			this.startingPromptSessions.update((set) => new Set(set).add(sessionKey));
		} else {
			this.startingPrompts.delete(sessionKey);
			this.startingPromptSessions.update((set) => {
				if (!set.has(sessionKey)) return set;
				const next = new Set(set);
				next.delete(sessionKey);
				return next;
			});
		}
	}

	private setActiveSubmit(
		sessionKey: string,
		submit: { dispatched: boolean; stopped: boolean } | null,
	) {
		this.activeSubmits.update((submits) => {
			const next = new Map(submits);
			if (submit) next.set(sessionKey, submit);
			else next.delete(sessionKey);
			return next;
		});
	}

	private finishActiveSubmit(sessionKey: string) {
		batch(() => {
			this.setActiveSubmit(sessionKey, null);
			if (this.targetSignal()?.sessionKey === sessionKey) {
				this.stateSignal.update((s) => ({ ...s, sending: false }));
			}
		});
	}

	/** A turn or compaction is running (or starting) on the target chat. */
	running(sessionKey = this.targetSignal()?.sessionKey): boolean {
		if (!sessionKey) return false;
		const chat = this.chatState(sessionKey);
		return Boolean(
			chat?.activeTurn ||
			chat?.compacting ||
			this.startingPromptSessions().has(sessionKey) ||
			this.transcript?.hasLiveTurn?.(sessionKey),
		);
	}

	compacting(): boolean {
		return Boolean(this.chatState()?.compacting);
	}

	/**
	 * An external Pi runs a turn in the open chat's session, so it is read-only
	 * here, as in the WebUI.
	 */
	readOnly(): boolean {
		return this.readOnlyComputed();
	}

	/** Sessions the `@` menu offers, newest first, as mention draft entries. */
	sessionMentions(): readonly SessionMention[] {
		return this.sessionMentionsComputed();
	}

	/** Mention tokens in the current draft, keyed by their written form. */
	sessionsByValue(): ReadonlyMap<string, SessionMention> {
		return this.sessionsByValueComputed();
	}

	mentionDraft() {
		return this.mentionDraftComputed();
	}

	private async appendHistory(projectId: string, text: string) {
		const entry = text.trim();
		if (!entry) return;
		await this.loadHistories();
		const current = this.histories[projectId] ?? [];
		if (current[current.length - 1] === entry) return;
		this.histories[projectId] = [...current, entry].slice(
			-CHAT_INPUT_HISTORY_LIMIT,
		);
		void Storage.setItem(
			INPUT_HISTORY_KEY,
			JSON.stringify(this.histories),
		).catch(() => {});
	}

	loadHistories(): Promise<void> {
		return (this.historiesLoad ??= Storage.getItem(INPUT_HISTORY_KEY)
			.then((raw) => {
				if (!raw) return;
				const parsed: unknown = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
					return;
				for (const [projectId, entries] of Object.entries(parsed)) {
					if (Array.isArray(entries)) {
						this.histories[projectId] = entries
							.filter((entry): entry is string => typeof entry === "string")
							.map((entry) => entry.trim())
							.filter(Boolean)
							.slice(-CHAT_INPUT_HISTORY_LIMIT);
					}
				}
			})
			.catch(() => {
				// History is a convenience; a corrupt store starts empty.
			}));
	}

	/** 当前是否允许通过上下方向键翻阅历史（草稿为空且无图片，或正处于有效历史条目上）。 */
	canNavigateHistory(): boolean {
		const target = this.targetSignal();
		if (!target) return false;
		const { value, images } = this.stateSignal();
		if (images.length > 0) return false;
		if (value.length === 0) return true;
		if (this.historyCursor === null) return false;
		const entries = this.histories[target.projectId] ?? [];
		return isChatInputHistoryCursorValid(entries, this.historyCursor, value);
	}

	/**
	 * Recalls an earlier submission of this project on ArrowUp/Down, the way the
	 * WebUI composer does: only from an empty draft, and back to empty past the
	 * newest entry. Returns whether the key was consumed.
	 */
	async navigateHistory(direction: ChatInputHistoryDirection): Promise<{
		handled: boolean;
	}> {
		const target = this.targetSignal();
		if (!target) return { handled: false };
		const { value, images } = this.stateSignal();
		if (images.length) return { handled: false };
		const version = this.draftVersion;
		if (this.historyCursor !== null) {
			const entries = this.histories[target.projectId] ?? [];
			if (!isChatInputHistoryCursorValid(entries, this.historyCursor, value)) {
				this.historyCursor = null;
				return { handled: false };
			}
		} else if (value.length > 0) {
			return { handled: false };
		}
		await this.loadHistories();
		if (this.draftVersion !== version) return { handled: false };
		const entries = this.histories[target.projectId] ?? [];
		const result = moveChatInputHistory(entries, this.historyCursor, direction);
		if (!result.handled) {
			this.historyCursor = null;
			return { handled: false };
		}
		this.historyCursor = result.cursor;
		this.updateDraft((s) => ({
			...s,
			value: result.value,
			caret: result.value.length,
		}));
		return { handled: true };
	}

	/** File paths matching the query for the `@` menu (debounced by the caller). */
	async searchFileSuggestions(query: string) {
		const target = this.targetSignal();
		if (!target) return;
		const request = ++this.fileQueryRequest;
		try {
			const paths = await this.client.searchProjectFiles(
				target.projectId,
				query,
			);
			if (this.fileQueryRequest !== request) return;
			this.fileSuggestionsSignal.set(
				paths.slice(0, 5).map((path) => {
					const slash = path.lastIndexOf("/");
					return {
						kind: "file" as const,
						value: fileMentionValue(path),
						label: slash >= 0 ? path.slice(slash + 1) : path,
						detail: slash >= 0 ? path.slice(0, slash) : undefined,
					};
				}),
			);
		} catch {
			if (this.fileQueryRequest === request) this.fileSuggestionsSignal.set([]);
		}
	}

	clearFileSuggestions() {
		this.fileQueryRequest++;
		this.fileSuggestionsSignal.set([]);
	}

	private catalogCommands(): readonly PiCommand[] | null {
		const target = this.targetSignal();
		const catalogState = this.catalog?.state();
		if (!target || catalogState?.catalog?.projectId !== target.projectId) {
			return null;
		}
		return catalogState.catalog.commands ?? null;
	}

	private currentSessionCommands(): readonly PiCommand[] | null {
		const target = this.targetSignal();
		const session = this.sessionCommandsSignal();
		if (!target || session?.sessionKey !== target.sessionKey) return null;
		return session.commands;
	}

	private mergedPiCommands(): PiCommand[] {
		return mergePiCommands(
			this.catalogCommands(),
			this.currentSessionCommands(),
		);
	}

	private notify(notice: ComposerNotice) {
		this.onNotice?.(notice);
	}

	/**
	 * Refreshes cached project commands if missing, and merges live session
	 * commands (including user extension commands) only when Pi is already running.
	 */
	async loadCommands() {
		const target = this.targetSignal();
		if (!target) return;
		const catalogState = this.catalog?.state();
		if (
			this.catalog &&
			catalogState?.projectId === target.projectId &&
			catalogState.loaded &&
			!catalogState.refreshing &&
			(!catalogState.catalog || catalogState.catalog.commands == null)
		) {
			void this.catalog.refresh();
		}
		if (
			this.readOnly() ||
			this.sessionCommandsSignal()?.sessionKey === target.sessionKey ||
			this.sessionCommandsInFlight === target.sessionKey
		) {
			return;
		}
		const request = ++this.commandsRequest;
		this.sessionCommandsInFlight = target.sessionKey;
		try {
			const chat = await this.client.chatState(target.sessionKey);
			if (
				this.commandsRequest !== request ||
				this.targetSignal()?.sessionKey !== target.sessionKey
			) {
				return;
			}
			// Passive `/` completion must never start a stopped Pi process.
			if (
				!chat?.initialized ||
				(chat.snapshot && chat.snapshot.state !== "running")
			) {
				return;
			}
			const reply = await requestPiRpc<{ commands: PiCommand[] }>(
				this.client,
				target.sessionKey,
				{ type: "get_commands" },
			);
			if (
				this.commandsRequest !== request ||
				this.targetSignal()?.sessionKey !== target.sessionKey ||
				!reply?.commands
			) {
				return;
			}
			this.sessionCommandsSignal.set({
				sessionKey: target.sessionKey,
				commands: reply.commands,
			});
		} catch {
			// Keep cached commands and allow retry once Pi is running.
		} finally {
			if (this.commandsRequest === request) {
				this.sessionCommandsInFlight = null;
			}
		}
	}

	private draftKey({ sessionKey, projectId, sessionPath }: ComposerTarget) {
		return sessionPath
			? `file:${chatSessionKey(projectId, runtimeSessionPathKey(sessionPath))}`
			: sessionKey;
	}

	private adoptDraftPath(previous: ComposerTarget, saved: ComposerTarget) {
		const key = this.draftKey(previous);
		const draft = this.draftFor(previous);
		if (draft !== EMPTY_DRAFT) {
			this.drafts.set(this.draftKey(saved), draft);
			this.drafts.delete(key);
			if (draft.value && this.draftTextStorage?.write(saved, draft.value)) {
				this.draftTextStorage.write(previous, "");
			}
		}
		this.onUnsentDraft?.(saved, null);
	}

	private draftFor(target: ComposerTarget): ComposerDraft {
		const key = this.draftKey(target);
		const cached = this.drafts.get(key);
		if (cached) return cached;
		const value = this.draftTextStorage?.read(target);
		if (!value) return EMPTY_DRAFT;
		const restored = { ...EMPTY_DRAFT, value };
		this.drafts.set(key, restored);
		return restored;
	}

	private cacheDraft(target: ComposerTarget, { value, images }: ComposerDraft) {
		const key = this.draftKey(target);
		const previous = this.drafts.get(key)?.value ?? "";
		// Keep empty drafts in memory when a failed storage write could leave stale text.
		if (value || images.length || this.draftTextStorage)
			this.drafts.set(key, { value, images });
		else this.drafts.delete(key);
		if (value !== previous) this.draftTextStorage?.write(target, value);
		if (!target.sessionPath)
			this.onUnsentDraft?.(
				target,
				value.trim() || images.length ? value : null,
			);
	}

	private writeDraft(target: ComposerTarget, draft: ComposerDraft) {
		target = this.resolveDraftTarget(target);
		const previous = this.draftFor(target).value;
		if (previous !== draft.value)
			discardRemovedChatFiles(previous, draft.value);
		const current = this.targetSignal();
		if (!current || this.draftKey(current) !== this.draftKey(target)) {
			this.cacheDraft(target, draft);
			return;
		}
		if (previous !== draft.value) this.historyCursor = null;
		this.updateDraft((s) => ({
			...s,
			...draft,
			caret: s.value === draft.value ? s.caret : draft.value.length,
		}));
	}

	private resolveDraftTarget(target: ComposerTarget): ComposerTarget {
		const current = this.targetSignal();
		if (current?.sessionKey === target.sessionKey) return current;
		if (target.sessionPath) return target;
		const path = this.chatState(target.sessionKey)?.sessionPath;
		if (
			path &&
			this.isIndexedDraftPath(this.app().sessionIndexes, target.projectId, path)
		) {
			return { ...target, sessionPath: path };
		}
		return target;
	}

	private isIndexedDraftPath(
		indexes: AppState["sessionIndexes"],
		projectId: string,
		path: string,
	) {
		const key = runtimeSessionPathKey(path);
		return indexes[projectId]?.sessions.some(
			(entry) => runtimeSessionPathKey(entry.sessionPath) === key,
		);
	}

	/** Inserts files into the requesting draft and returns whether any were attached. */
	async addFiles(
		files: readonly File[],
		target = this.targetSignal(),
		reportFailure = true,
		collectedErrors?: string[],
	): Promise<boolean> {
		if (!target) return false;
		const { sessionKey, projectId } = target;
		const errors = collectedErrors ?? [];
		const rejectFile = (message: string) => {
			if (reportFailure && !errors.includes(message)) errors.push(message);
		};
		let attached = false;
		if (files.length > MAX_CHAT_IMAGE_COUNT) {
			rejectFile(t("chat.maxFiles", { count: MAX_CHAT_IMAGE_COUNT }));
		}
		let batchBytes = 0;
		for (const file of files.slice(0, MAX_CHAT_IMAGE_COUNT)) {
			const mime = resolveChatImageMimeType(file);
			if (mime && !piModelSupportsImages(this.activeModel?.())) {
				rejectFile(t("chat.imageUnsupported"));
				continue;
			}
			if (file.size > MAX_CHAT_IMAGE_BYTES) {
				rejectFile(
					mime
						? t("chat.imageTooLarge", { name: file.name || "image" })
						: t("chat.fileTooLarge", {
								name: file.name || "file",
								size: formatChatImageSize(MAX_CHAT_IMAGE_BYTES),
							}),
				);
				continue;
			}
			batchBytes += file.size;
			if (batchBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
				rejectFile(
					t("chat.filesTooLarge", {
						size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
					}),
				);
				break;
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (mime) {
					const draft = this.draftFor(this.resolveDraftTarget(target));
					const { images } = draft;
					const limit =
						images.length >= MAX_CHAT_IMAGE_COUNT
							? t("chat.maxImages", { count: MAX_CHAT_IMAGE_COUNT })
							: images.reduce((total, image) => total + image.size, 0) +
										bytes.length >
								  MAX_CHAT_IMAGE_TOTAL_BYTES
								? t("chat.imagesTotalLimit", {
										size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
									})
								: null;
					if (limit) {
						rejectFile(limit);
						continue;
					}
					const image: ChatImageAttachment = {
						id: `img-${++attachmentSequence}`,
						name: file.name || "image",
						mimeType: mime,
						size: bytes.length,
						data: bytesToBase64(bytes),
					};
					this.writeDraft(target, { ...draft, images: [...images, image] });
				} else {
					const path = await this.client.uploadChatFile(
						projectId,
						file.name || "file",
						bytes,
					);
					this.removedFilePaths.delete(path);
					registerChatFile(path, () => {
						this.removedFilePaths.add(path);
						return this.client.removeChatFile(projectId, path);
					});
					const draft = this.draftFor(this.resolveDraftTarget(target));
					const { value } = draft;
					const tokenText = fileMentionValue(path);
					const separator = value.length === 0 || /\s$/.test(value) ? "" : " ";
					this.writeDraft(target, {
						...draft,
						value: `${value}${separator}${tokenText} `,
					});
				}
				attached = true;
			} catch (error) {
				rejectFile(
					`${t("chat.uploadFileFailed", { name: file.name || "file" })}: ${errorMessage(error)}`,
				);
			}
		}
		if (!collectedErrors) {
			if (errors.length > 0) {
				this.setStatus(errors.join(" · "), sessionKey);
			} else if (attached) {
				this.setStatus(null, sessionKey);
			}
		}
		return attached;
	}

	addPastedFiles(files: readonly File[], uris: readonly string[]) {
		const [file] = files;
		const [uri] = uris;
		// Windows nsh can report one image as both a file URI and a clipboard image.
		if (
			platform.os === "windows" &&
			files.length === 1 &&
			uris.length === 1 &&
			file &&
			uri &&
			((file.name === "image.bmp" && file.type === "image/bmp") ||
				(file.name === "image.png" && file.type === "image/png")) &&
			resolveChatImageMimeType({ name: attachmentName(uri), type: "" })
		) {
			void this.addUris(uris, file);
			return;
		}
		if (files.length) void this.addFiles(files);
		if (uris.length) void this.addUris(uris);
	}

	/** Pasted or dropped `file:` URIs, read natively and attached like picked files. */
	async addUris(uris: readonly string[], clipboardImage?: File) {
		const target = this.targetSignal();
		if (!target) return;
		// An unsupported clipboard bitmap must not turn an image paste into a file upload.
		const fallback =
			clipboardImage && resolveChatImageMimeType(clipboardImage)
				? clipboardImage
				: undefined;
		const errors: string[] = [];
		const recordError = (message: string) => {
			if (!errors.includes(message)) errors.push(message);
		};
		if (uris.length > MAX_CHAT_IMAGE_COUNT) {
			recordError(t("chat.maxFiles", { count: MAX_CHAT_IMAGE_COUNT }));
		}
		let batchBytes = 0;
		for (const uri of uris.slice(0, MAX_CHAT_IMAGE_COUNT)) {
			try {
				if (!this.client.readLocalFile) throw new Error("no local file reads");
				const bytes = await this.client.readLocalFile(uri);
				if (bytes.length <= MAX_CHAT_IMAGE_BYTES) {
					batchBytes += bytes.length;
					if (batchBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
						recordError(
							t("chat.filesTooLarge", {
								size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
							}),
						);
						break;
					}
				}
				const name = attachmentName(uri);
				const mime = resolveChatImageMimeType({ name, type: "" });
				const attached = await this.addFiles(
					[
						new File([bytes], name.slice(0, ATTACHMENT_NAME_LIMIT), {
							type: mime ?? "",
						}),
					],
					target,
					// With a fallback, report only failure of the final attempt.
					!fallback,
					errors,
				);
				if (attached) continue;
			} catch (error) {
				if (!fallback) {
					recordError(
						`${t("chat.uploadFileFailed", { name: attachmentName(uri) })}: ${errorMessage(error)}`,
					);
				}
			}
			if (fallback) {
				await this.addFiles([fallback], target);
				return;
			}
		}
		if (errors.length > 0) {
			this.setStatus(errors.join(" · "), target.sessionKey);
		}
	}

	removeImage(id: string) {
		this.updateDraft((s) => ({
			...s,
			images: s.images.filter((image) => image.id !== id),
			status: null,
		}));
	}

	/** 从草稿中精确移除指定引用，并保留其余内联引用的原始位置。 */
	removeReference(index: number) {
		const sessions = this.sessionsByValue();
		const draft = readChatMentionDraft(this.stateSignal().value, sessions);
		const target = draft.references[index];
		if (!target) return;
		this.setValue(
			removeChatMention(this.stateSignal().value, target, sessions),
		);
	}

	/** 按类型和路径精确移除指定内联引用。 */
	removeMention(kind: "file" | "session", path: string) {
		const sessions = this.sessionsByValue();
		this.setValue(
			removeChatMention(this.stateSignal().value, { kind, path }, sessions),
		);
	}

	private commandFor(
		mode: ComposerSendMode,
		submission: ReturnType<typeof createChatSubmission>,
	): Record<string, unknown>[] {
		const images =
			submission.images.length > 0
				? { images: toPiImageContents(submission.images) }
				: {};
		const message = chatSubmissionMessage(submission);
		switch (mode) {
			case "steer":
				return [{ type: "steer", message, ...images }];
			case "follow_up":
				return [{ type: "follow_up", message, ...images }];
			case "send_now":
				return [{ type: "abort" }, { type: "prompt", message, ...images }];
		}
	}

	private async ensureStartedForSubmit(
		target: ComposerTarget,
		submit: { stopped: boolean },
		onStarting?: () => void,
		inBackground = false,
	): Promise<boolean> {
		const canSend = () =>
			!submit.stopped &&
			(inBackground || this.targetSignal()?.sessionKey === target.sessionKey);
		const ensureReady = () => this.ensureStarted(target, canSend, onStarting);
		// Let run config check defaults before startup and apply them before sending.
		const ready = this.beforeSend
			? await this.beforeSend(target.sessionKey, ensureReady, inBackground)
			: await ensureReady();
		return ready && canSend();
	}

	private async ensureStarted(
		target: ComposerTarget,
		canSend: () => boolean,
		onStarting?: () => void,
	): Promise<boolean> {
		const chat = await this.client.chatState(target.sessionKey);
		if (!canSend()) return false;
		if (!chat?.initialized) {
			onStarting?.();
			const current = this.targetSignal();
			const { projectId, sessionKey, sessionPath } =
				current?.sessionKey === target.sessionKey ? current : target;
			const input = {
				projectId,
				sessionKey,
				...(sessionPath ? { sessionPath } : {}),
				...(isTemporarySessionKey(sessionKey) ? { noSession: true } : {}),
			};
			for (;;) {
				try {
					await this.client.startChat(input);
					break;
				} catch (error) {
					if (!(await this.waitForStartupApproval?.(sessionKey))) throw error;
					// Retry only startup, never a prompt that may already have reached Pi.
					if (!canSend()) return false;
				}
			}
		}
		return canSend();
	}

	private async fetchLiveSessionCommands(
		sessionKey: string,
	): Promise<readonly PiCommand[] | null> {
		const existing = this.sessionCommandsSignal();
		if (existing?.sessionKey === sessionKey) return existing.commands;
		try {
			const reply = await requestPiRpc<{ commands: PiCommand[] }>(
				this.client,
				sessionKey,
				{ type: "get_commands" },
			);
			if (!reply?.commands) return null;
			if (this.targetSignal()?.sessionKey === sessionKey) {
				this.sessionCommandsSignal.set({
					sessionKey,
					commands: reply.commands,
				});
			}
			return reply.commands;
		} catch {
			return null;
		}
	}

	private async executeCompact(
		target: ComposerTarget,
		customInstructions: string,
		{
			draft,
			scheduled,
		}: { draft?: ComposerDraft; scheduled?: ChatSessionRuntimeState } = {},
	) {
		const submit = { dispatched: false, stopped: false };
		this.setActiveSubmit(target.sessionKey, submit);
		if (draft) {
			this.historyCursor = null;
			this.updateDraft((s) => ({
				...s,
				value: "",
				caret: 0,
				images: [],
				sending: true,
				status: null,
			}));
		} else if (this.targetSignal()?.sessionKey === target.sessionKey) {
			this.stateSignal.update((s) => ({ ...s, sending: true, status: null }));
		}
		let sent = false;
		let failure: string | undefined;
		try {
			// Scheduled work belongs to a live Pi; never wake an old session or apply another chat's selection.
			if (!scheduled && !(await this.ensureStartedForSubmit(target, submit)))
				return;
			const outcome = await requestPiRpcOutcome<PiCompactionResult>(
				this.client,
				target.sessionKey,
				{
					type: "compact",
					...(customInstructions ? { customInstructions } : {}),
				},
				PROMPT_REPLY_TIMEOUT_MS,
				() => {
					if (submit.stopped) return false;
					if (scheduled) {
						const chat = this.chatState(target.sessionKey);
						if (
							!chat?.initialized ||
							this.running(target.sessionKey) ||
							chat.snapshot?.generation !== scheduled.snapshot?.generation ||
							(chat.snapshot && chat.snapshot.state !== "running") ||
							(isTemporarySessionKey(target.sessionKey) &&
								this.targetSignal()?.sessionKey !== target.sessionKey)
						)
							return false;
					}
					submit.dispatched = true;
					return true;
				},
			);
			if (submit.stopped && outcome.type === "not_sent") return;
			if (outcome.type !== "reply" || !outcome.reply.data) {
				failure =
					outcome.type === "unconfirmed"
						? t("chat.promptUnconfirmed")
						: t("chat.compactFailedAction");
				return;
			}
			const result = outcome.reply.data;
			sent = true;
			const locale = appLocale();
			this.notify({
				variant: "success",
				title: t("chat.compactSuccess"),
				description: `${result.tokensBefore.toLocaleString(locale)} → ${result.estimatedTokensAfter.toLocaleString(locale)} tokens`,
			});
			if (this.targetSignal()?.sessionKey === target.sessionKey)
				this.onCompacted?.(result);
			if (draft?.value) await this.appendHistory(target.projectId, draft.value);
		} catch (error) {
			failure = errorMessage(error);
		} finally {
			if (!sent) {
				if (failure) {
					this.notify({
						variant: "error",
						title: t("chat.compactFailedAction"),
						description: failure,
					});
				}
				if (draft) {
					this.restoreDraft(target, draft, this.onNotice ? undefined : failure);
				}
			}
			this.finishActiveSubmit(target.sessionKey);
		}
	}

	/** Sends the draft, optionally forcing a send mode for this send only. */
	async submit(mode?: ComposerSendMode, textWithImageReferences?: string) {
		const target = this.targetSignal();
		const { value, images, sending, composing, sendMode } = this.stateSignal();
		if (!target || sending || composing || this.queue?.busy(target.sessionKey))
			return;
		const submission = createChatSubmission(
			value,
			images,
			textWithImageReferences,
		);
		if (!chatSubmissionHasContent(submission)) return;
		const slash =
			mode === undefined ? parseSlashCommand(submission.text) : null;
		if (slash?.name === "new") {
			this.historyCursor = null;
			this.updateDraft((s) => ({
				...s,
				value: "",
				caret: 0,
				status: null,
			}));
			this.onNewChat?.();
			return;
		}
		if (this.readOnly()) return;
		const running = this.running();
		if (slash?.name === "compact") {
			if (running) {
				this.historyCursor = null;
				this.updateDraft((s) => ({
					...s,
					value: "",
					caret: 0,
					status: null,
				}));
				this.pendingCompactMap.update((map) =>
					new Map(map).set(target.sessionKey, slash.args),
				);
				this.notify({
					variant: "info",
					title: t("chat.compactScheduled"),
				});
				return;
			}
			await this.executeCompact(target, slash.args, {
				draft: { value, images },
			});
			return;
		}
		if (mode === "follow_up" && !running) return;
		// A compaction takes no message; the composer blocks sending meanwhile.
		if (running && this.compacting()) return;

		const knownCommands = !running && slash ? this.mergedPiCommands() : [];
		const knownExtensionCommand =
			!running &&
			slash !== null &&
			createPiExtensionCommandNames(knownCommands).has(slash.name);
		const needsExtensionCheck =
			!running &&
			slash !== null &&
			!knownExtensionCommand &&
			this.currentSessionCommands() === null &&
			!knownCommands.some(
				(command) =>
					command.name === slash.name && command.source !== "extension",
			);

		const delivery = mode ?? sendMode;
		if (delivery === "send_now") {
			this.resetTransientSendMode();
		}
		if (running && this.queue && delivery !== "send_now") {
			this.historyCursor = null;
			this.updateDraft((s) => ({
				...s,
				value: "",
				caret: 0,
				images: [],
				status: null,
			}));
			rememberLocalChatImages(submission.images);
			const pendingStart = this.startingPrompts.get(target.sessionKey);
			try {
				const outcome = await this.queue.enqueue(
					target,
					delivery,
					submission,
					undefined,
					async () => {
						let startedFromPending = false;
						if (pendingStart) {
							startedFromPending = await pendingStart.settled;
							if (!startedFromPending) return false;
						}
						if (
							this.beforeSend &&
							!(await this.beforeSend(target.sessionKey))
						) {
							return false;
						}
						if (
							mode === "follow_up" &&
							((!startedFromPending && !this.running()) || this.compacting())
						) {
							return false;
						}
						return true;
					},
				);
				if (outcome === "cancelled") {
					this.restoreQueuedDraft(target, [submission]);
					return;
				}
				retainChatFiles(submission.text);
				await this.appendHistory(target.projectId, submission.text);
			} catch (error) {
				this.restoreQueuedDraft(target, [submission]);
				this.reportError(
					t("chat.queueFailed"),
					errorMessage(error),
					target.sessionKey,
				);
			}
			return;
		}

		const nonBlockingStart =
			!running &&
			!knownExtensionCommand &&
			!needsExtensionCheck &&
			this.queue !== undefined;
		const inBackground =
			nonBlockingStart &&
			!target.sessionPath &&
			!isTemporarySessionKey(target.sessionKey);
		let resolveSettled: ((ok: boolean) => void) | undefined;
		const submit = { dispatched: false, stopped: false };
		if (nonBlockingStart) {
			const settled = new Promise<boolean>((resolve) => {
				resolveSettled = resolve;
			});
			this.setStartingPrompt(target.sessionKey, {
				get dispatched() {
					return submit.dispatched;
				},
				set dispatched(next: boolean) {
					submit.dispatched = next;
				},
				get stopped() {
					return submit.stopped;
				},
				set stopped(next: boolean) {
					submit.stopped = next;
				},
				settled,
			});
		} else {
			this.setActiveSubmit(target.sessionKey, submit);
		}
		// The draft leaves the composer at once, as in the WebUI; it comes
		// back if it is not sent.
		this.historyCursor = null;
		this.updateDraft((s) => ({
			...s,
			value: "",
			caret: 0,
			images: [],
			sending: nonBlockingStart ? s.sending : true,
			status: null,
		}));
		// A prompt that starts a turn shows in the chat while Pi starts and
		// takes it; known or pending-check extension commands skip the local bubble.
		const message = chatSubmissionMessage(submission);
		rememberLocalChatImages(submission.images);
		let local =
			running || knownExtensionCommand || needsExtensionCheck
				? null
				: (this.transcript?.submitLocal(
						target.sessionKey,
						message,
						summarizeChatImages(submission.images),
					) ?? null);
		const localStatus = (status?: "starting" | "sending") => {
			if (local) this.transcript?.setLocalStatus(local, status);
		};
		let sent = false;
		let isExtensionCommand = knownExtensionCommand;
		let failure: string | undefined;
		try {
			if (inBackground) this.onPendingDraft?.(target, message);
			const pendingStart = running
				? this.startingPrompts.get(target.sessionKey)
				: undefined;
			let pendingStartDispatched = true;
			if (pendingStart) {
				if (delivery === "send_now" && !pendingStart.dispatched) {
					pendingStart.stopped = true;
					pendingStartDispatched = false;
				}
				const started = await pendingStart.settled;
				if (!started) pendingStartDispatched = false;
				if (
					this.targetSignal()?.sessionKey !== target.sessionKey ||
					submit.stopped
				) {
					return;
				}
			}
			const stillRunning =
				running &&
				(pendingStartDispatched ||
					Boolean(
						this.chatState()?.activeTurn ||
						this.chatState()?.compacting ||
						this.transcript?.hasLiveTurn?.(target.sessionKey),
					));
			if (!stillRunning) {
				if (
					!(await this.ensureStartedForSubmit(
						target,
						submit,
						() => localStatus("starting"),
						inBackground,
					))
				) {
					return;
				}
			} else if (
				this.targetSignal()?.sessionKey !== target.sessionKey ||
				submit.stopped ||
				(this.beforeSend && !(await this.beforeSend(target.sessionKey))) ||
				this.targetSignal()?.sessionKey !== target.sessionKey ||
				submit.stopped
			) {
				return;
			}
			if (mode === "follow_up" && (!this.running() || this.compacting()))
				return;

			if (needsExtensionCheck && slash) {
				const liveCommands = await this.fetchLiveSessionCommands(
					target.sessionKey,
				);
				if (
					this.targetSignal()?.sessionKey !== target.sessionKey ||
					submit.stopped
				) {
					return;
				}
				isExtensionCommand =
					liveCommands !== null &&
					createPiExtensionCommandNames(liveCommands).has(slash.name);
				if (!isExtensionCommand) {
					local =
						this.transcript?.submitLocal(
							target.sessionKey,
							message,
							summarizeChatImages(submission.images),
						) ?? null;
				}
			}

			let disposition: PiPromptResult["disposition"] | undefined;
			if (stillRunning) {
				if (this.queue && delivery !== "send_now") {
					submit.dispatched = true;
					await this.queue.enqueue(target, delivery, submission);
				} else {
					const sentWithQueue =
						delivery === "send_now" &&
						(await this.queue?.sendNow?.(target, submission, this, () => {
							if (submit.stopped) return false;
							submit.dispatched = true;
							return true;
						}));
					if (!sentWithQueue) {
						for (const command of this.commandFor(delivery, submission)) {
							if (submit.stopped) return;
							submit.dispatched = true;
							// oxlint-disable-next-line no-await-in-loop -- `abort` must precede `prompt`.
							await this.client.sendChatCommand(target.sessionKey, command);
						}
					}
				}
			} else if (isExtensionCommand && slash) {
				submit.dispatched = true;
				await this.client.sendChatCommand(target.sessionKey, {
					type: "prompt",
					message: slash.raw,
				});
			} else {
				localStatus("sending");
				submit.dispatched = true;
				const queueOwner = this.queue?.queueOwner;
				const outcome = await requestPiRpcOutcome<PiPromptResult>(
					this.client,
					target.sessionKey,
					{
						type: "prompt",
						message,
						...(queueOwner ? { piloQueueOwner: queueOwner } : {}),
						...(submission.images.length > 0
							? { images: toPiImageContents(submission.images) }
							: {}),
					},
					PROMPT_REPLY_TIMEOUT_MS,
				);
				if (outcome.type !== "reply") {
					if (outcome.type === "unconfirmed") {
						// Pi may already reference the files, even if the draft is restored.
						retainChatFiles(submission.text);
						failure = t("chat.promptUnconfirmed");
					} else {
						failure = t("chat.promptNotSent");
					}
					return;
				}
				disposition = outcome.reply.data?.disposition;
				// Stop may have reached Pi before the turn began; end it now.
				if (submit.stopped && disposition !== "handled") {
					void this.client
						.sendChatCommand(target.sessionKey, { type: "abort" })
						.catch((error) =>
							this.setStatus(
								`${t("chat.stopPiFailed")}: ${errorMessage(error)}`,
								target.sessionKey,
							),
						);
				}
			}
			sent = true;
			retainChatFiles(submission.text);
			if (!stillRunning && !isExtensionCommand) {
				if (disposition === "queued") {
					if (local) this.transcript?.dropLocal(local);
					this.queue?.adoptQueued?.(target.sessionKey, "follow_up", submission);
				} else if (disposition !== "handled") {
					localStatus();
					this.onPromptStarted?.(target, submission.text);
				} else if (
					local &&
					!chatRuntimeHasOpenTurn(
						await this.client.chatState(target.sessionKey),
					)
				) {
					// An input handler took the prompt without starting a turn.
					this.transcript?.dropLocal(local);
				}
			}
			await this.appendHistory(target.projectId, submission.text);
		} catch (error) {
			failure = errorMessage(error);
			if (sent) this.setStatus(failure, target.sessionKey);
		} finally {
			if (!sent) {
				if (local) this.transcript?.dropLocal(local);
				if (isExtensionCommand && failure) {
					this.notify({
						variant: "error",
						title: t("chat.executeExtensionFailed"),
						description: failure,
					});
				}
				this.restoreDraft(
					target,
					{ value, images },
					isExtensionCommand && this.onNotice ? undefined : failure,
				);
			}
			if (inBackground) this.onPendingDraft?.(target, null);
			if (nonBlockingStart) {
				this.setStartingPrompt(target.sessionKey, null);
				resolveSettled?.(sent && !submit.stopped);
			} else {
				this.finishActiveSubmit(target.sessionKey);
			}
		}
	}

	/** Retrieves queued messages without overwriting newer draft edits. */
	restoreQueuedDraft(
		target: ComposerTarget,
		submissions: readonly ChatSubmission[],
	) {
		if (submissions.length === 0) return;
		this.restoreDraft(target, {
			value: submissions
				.map((submission) => submission.text)
				.filter(Boolean)
				.join("\n\n"),
			images: submissions.flatMap((submission) => submission.images),
		});
	}

	/** Restores the unsent draft before newer edits in its original scope. */
	private restoreDraft(
		target: ComposerTarget,
		draft: ComposerDraft,
		status?: string,
	) {
		target = this.resolveDraftTarget(target);
		const later = this.draftFor(target);
		this.writeDraft(target, {
			value: [draft.value, later.value].filter(Boolean).join("\n\n"),
			images: [...draft.images, ...later.images],
		});
		if (status === undefined) return;
		if (this.targetSignal()?.sessionKey === target.sessionKey)
			this.setStatus(status);
		else this.sessionStatuses.set(target.sessionKey, status);
	}

	/** Stops the running turn, or the send that is about to start one. */
	async stop() {
		this.resetTransientSendMode();
		const target = this.targetSignal();
		if (!target) return;
		const submit =
			this.activeSubmits().get(target.sessionKey) ??
			this.startingPrompts.get(target.sessionKey);
		if (submit) {
			submit.stopped = true;
			// Nothing has reached Pi yet: cancel any locally queued follow-ups and exit.
			if (
				!submit.dispatched &&
				!this.chatState()?.activeTurn &&
				!this.chatState()?.compacting
			) {
				await this.queue?.clearForStop?.(target, this);
				return;
			}
		}
		if (this.queue?.clearForStop) {
			await this.queue.clearForStop(target, this);
		}
		try {
			await this.client.sendChatCommand(target.sessionKey, {
				type: "abort",
			});
		} catch (error) {
			this.setStatus(
				`${t("chat.stopPiFailed")}: ${errorMessage(error)}`,
				target.sessionKey,
			);
		}
	}
}

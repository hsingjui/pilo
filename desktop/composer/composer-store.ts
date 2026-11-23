import { type Accessor, batch, computed, signal } from "nsh";
import { Storage } from "nsh";

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
	isComposerSendMode,
	type ComposerSendMode,
} from "@shared/chat/send-mode";
import {
	sessionMentionValue,
	type SessionMention,
} from "@shared/chat/session-mentions";
import type { ComposerSuggestion } from "@shared/chat/composer-suggestions";
import { chatRuntimeHasOpenTurn } from "@shared/chat/chat-session-runtime-model";
import { appLocale, t } from "../app/i18n";
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

type ComposerDraft = Pick<ComposerViewState, "value" | "images">;

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
>;

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
 * Desktop draft text and images are shared by all chats of a project. Send
 * feedback stays with its session. History and send mode persist in `Storage`.
 */
export class ComposerStore {
	private readonly client: ComposerClient;
	private readonly app: Accessor<AppState>;
	private readonly catalog?: Pick<ModelCatalogStore, "state" | "refresh">;
	private readonly beforeSend?: (sessionKey: string) => Promise<boolean>;
	private readonly transcript?: ComposerTranscript;
	private readonly onPromptStarted?: (
		target: ComposerTarget,
		text: string,
	) => void;
	private readonly onNewChat?: () => void;
	private readonly onCompacted?: (result: PiCompactionResult) => void;
	private readonly onNotice?: (notice: ComposerNotice) => void;
	private readonly draftScope: "project" | "session";
	private readonly drafts = new Map<string, ComposerDraft>();
	private readonly sessionStatuses = new Map<string, string>();
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
	 * The send in flight, so Stop can end it at any stage: before the prompt
	 * goes out it just stops there; once Pi has it, the turn is aborted.
	 */
	private readonly activeSubmits = new Map<
		string,
		{ dispatched: boolean; stopped: boolean }
	>();
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

	constructor(deps: {
		client: ComposerClient;
		app: Accessor<AppState>;
		draftScope?: "project" | "session";
		/** The active project's model and command catalog, for `/` suggestions. */
		catalog?: Pick<ModelCatalogStore, "state" | "refresh">;
		beforeSend?: (sessionKey: string) => Promise<boolean>;
		/** Shows a prompt that starts a turn at once, before Pi takes it. */
		transcript?: ComposerTranscript;
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
		this.draftScope = deps.draftScope ?? "project";
		this.catalog = deps.catalog;
		this.beforeSend = deps.beforeSend;
		this.transcript = deps.transcript;
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
		void Storage.getItem(COMPOSER_SEND_MODE_STORAGE_KEY)
			.then((stored) => {
				if (isComposerSendMode(stored))
					this.stateSignal.update((s) => ({ ...s, sendMode: stored }));
			})
			.catch(() => {});
	}

	/** Swaps the open chat without losing its draft. */
	setTarget(target: ComposerTarget | null) {
		const previous = this.targetSignal();
		if (previous?.sessionKey === target?.sessionKey) {
			if (previous?.sessionPath !== target?.sessionPath)
				this.targetSignal.set(target);
			return;
		}
		if (previous) {
			const { status } = this.stateSignal();
			if (status !== null)
				this.sessionStatuses.set(previous.sessionKey, status);
			else this.sessionStatuses.delete(previous.sessionKey);
		}
		const draft = target ? this.draftFor(target) : EMPTY_DRAFT;
		batch(() => {
			this.clearFileSuggestions();
			this.commandsRequest++;
			this.sessionCommandsSignal.set(null);
			this.sessionCommandsInFlight = null;
			if (
				!previous ||
				!target ||
				this.draftKey(previous) !== this.draftKey(target)
			) {
				this.historyCursor = null;
			}
			this.draftVersion++;
			this.targetSignal.set(target);
			this.stateSignal.update((s) => ({
				...s,
				...draft,
				caret: draft.value.length,
				status: target
					? (this.sessionStatuses.get(target.sessionKey) ?? null)
					: null,
				composing: false,
				dragging: false,
				sending: target ? this.activeSubmits.has(target.sessionKey) : false,
			}));
		});
	}

	/** Identity of the draft, including edits that were undone and chat switches. */
	get draftRevision() {
		return this.draftVersion;
	}

	private updateDraft(change: (state: ComposerViewState) => ComposerViewState) {
		this.stateSignal.update((current) => {
			const next = change(current);
			if (next.value !== current.value || next.images !== current.images) {
				this.draftVersion++;
				const target = this.targetSignal();
				if (target) this.cacheDraft(this.draftKey(target), next);
			}
			return next;
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

	setSendMode(sendMode: ComposerSendMode) {
		this.stateSignal.update((s) => ({ ...s, sendMode }));
		void Storage.setItem(COMPOSER_SEND_MODE_STORAGE_KEY, sendMode).catch(
			() => {},
		);
	}

	/** The open chat's runtime state, as the app store last reported it. */
	chatState(): ChatSessionRuntimeState | null {
		const target = this.targetSignal();
		if (!target) return null;
		return (
			this.app().chatSessions.find(
				(session) => session.sessionKey === target.sessionKey,
			) ?? null
		);
	}

	/** A turn or compaction is running on the open chat. */
	running(): boolean {
		const chat = this.chatState();
		return Boolean(chat?.activeTurn || chat?.compacting);
	}

	compacting(): boolean {
		return Boolean(this.chatState()?.compacting);
	}

	/**
	 * An external Pi runs a turn in the open chat's session, so it is read-only
	 * here, as in the WebUI.
	 */
	readOnly(): boolean {
		const target = this.targetSignal();
		return (
			!!target &&
			isExternalTurnOpen(this.app(), target.projectId, target.sessionPath)
		);
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

	private draftKey(target: ComposerTarget): string {
		return this.draftScope === "project" ? target.projectId : target.sessionKey;
	}

	private draftFor(target: ComposerTarget): ComposerDraft {
		return this.drafts.get(this.draftKey(target)) ?? EMPTY_DRAFT;
	}

	private cacheDraft(key: string, { value, images }: ComposerDraft) {
		if (value || images.length) this.drafts.set(key, { value, images });
		else this.drafts.delete(key);
	}

	private writeDraft(target: ComposerTarget, draft: ComposerDraft) {
		const key = this.draftKey(target);
		const previous = this.draftFor(target).value;
		if (previous !== draft.value)
			discardRemovedChatFiles(previous, draft.value);
		const current = this.targetSignal();
		if (!current || this.draftKey(current) !== key) {
			this.cacheDraft(key, draft);
			return;
		}
		if (previous !== draft.value) this.historyCursor = null;
		this.updateDraft((s) => ({
			...s,
			...draft,
			caret: s.value === draft.value ? s.caret : draft.value.length,
		}));
	}

	/** Inserts picked/pasted/dropped files into the draft that requested them. */
	async addFiles(files: readonly File[], target = this.targetSignal()) {
		if (!target) return;
		const { sessionKey, projectId } = target;
		if (files.length > MAX_CHAT_IMAGE_COUNT) {
			this.setStatus(
				t("chat.maxFiles", { count: MAX_CHAT_IMAGE_COUNT }),
				sessionKey,
			);
		}
		let batchBytes = 0;
		for (const file of files.slice(0, MAX_CHAT_IMAGE_COUNT)) {
			const mime = resolveChatImageMimeType(file);
			if (file.size > MAX_CHAT_IMAGE_BYTES) {
				this.setStatus(
					mime
						? t("chat.imageTooLarge", { name: file.name || "image" })
						: t("chat.fileTooLarge", {
								name: file.name || "file",
								size: formatChatImageSize(MAX_CHAT_IMAGE_BYTES),
							}),
					sessionKey,
				);
				continue;
			}
			batchBytes += file.size;
			if (batchBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
				this.setStatus(
					t("chat.filesTooLarge", {
						size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
					}),
					sessionKey,
				);
				break;
			}
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (mime) {
					const draft = this.draftFor(target);
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
						this.setStatus(limit, sessionKey);
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
					const draft = this.draftFor(target);
					const { value } = draft;
					const tokenText = fileMentionValue(path);
					const separator = value.length === 0 || /\s$/.test(value) ? "" : " ";
					this.writeDraft(target, {
						...draft,
						value: `${value}${separator}${tokenText} `,
					});
				}
			} catch (error) {
				this.setStatus(
					`${t("chat.uploadFileFailed", { name: file.name || "file" })}: ${errorMessage(error)}`,
					sessionKey,
				);
			}
		}
	}

	/** Pasted or dropped `file:` URIs, read natively and attached like picked files. */
	async addUris(uris: readonly string[]) {
		const target = this.targetSignal();
		if (!target) return;
		if (uris.length > MAX_CHAT_IMAGE_COUNT) {
			this.setStatus(
				t("chat.maxFiles", { count: MAX_CHAT_IMAGE_COUNT }),
				target.sessionKey,
			);
		}
		let batchBytes = 0;
		for (const uri of uris.slice(0, MAX_CHAT_IMAGE_COUNT)) {
			try {
				if (!this.client.readLocalFile) throw new Error("no local file reads");
				const bytes = await this.client.readLocalFile(uri);
				if (bytes.length <= MAX_CHAT_IMAGE_BYTES) {
					batchBytes += bytes.length;
					if (batchBytes > MAX_CHAT_IMAGE_TOTAL_BYTES) {
						this.setStatus(
							t("chat.filesTooLarge", {
								size: formatChatImageSize(MAX_CHAT_IMAGE_TOTAL_BYTES),
							}),
							target.sessionKey,
						);
						break;
					}
				}
				const name = attachmentName(uri);
				const mime = resolveChatImageMimeType({ name, type: "" });
				await this.addFiles(
					[
						new File([bytes], name.slice(0, ATTACHMENT_NAME_LIMIT), {
							type: mime ?? "",
						}),
					],
					target,
				);
			} catch (error) {
				this.setStatus(
					`${t("chat.uploadFileFailed", { name: attachmentName(uri) })}: ${errorMessage(error)}`,
					target.sessionKey,
				);
			}
		}
	}

	removeImage(id: string) {
		this.updateDraft((s) => ({
			...s,
			images: s.images.filter((image) => image.id !== id),
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
	): Promise<boolean> {
		const chat = await this.client.chatState(target.sessionKey);
		const current = this.targetSignal();
		if (current?.sessionKey !== target.sessionKey || submit.stopped) {
			return false;
		}
		if (!chat?.initialized) {
			onStarting?.();
			await this.client.startChat({
				projectId: current.projectId,
				sessionKey: current.sessionKey,
				...(current.sessionPath ? { sessionPath: current.sessionPath } : {}),
				...(isTemporarySessionKey(current.sessionKey)
					? { noSession: true }
					: {}),
			});
		}
		if (
			this.targetSignal()?.sessionKey !== target.sessionKey ||
			submit.stopped
		) {
			return false;
		}
		if (this.beforeSend && !(await this.beforeSend(target.sessionKey))) {
			return false;
		}
		return (
			this.targetSignal()?.sessionKey === target.sessionKey && !submit.stopped
		);
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
		rawValue: string,
		rawImages: ChatImageAttachment[],
	) {
		const submit = { dispatched: false, stopped: false };
		this.activeSubmits.set(target.sessionKey, submit);
		this.historyCursor = null;
		this.updateDraft((s) => ({
			...s,
			value: "",
			caret: 0,
			images: [],
			sending: true,
			status: null,
		}));
		let sent = false;
		let failure: string | undefined;
		try {
			if (!(await this.ensureStartedForSubmit(target, submit))) return;
			submit.dispatched = true;
			const outcome = await requestPiRpcOutcome<PiCompactionResult>(
				this.client,
				target.sessionKey,
				{
					type: "compact",
					...(customInstructions ? { customInstructions } : {}),
				},
				PROMPT_REPLY_TIMEOUT_MS,
			);
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
			this.onCompacted?.(result);
			await this.appendHistory(target.projectId, rawValue);
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
				this.restoreDraft(
					target,
					{ value: rawValue, images: rawImages },
					this.onNotice ? undefined : failure,
				);
			}
			this.activeSubmits.delete(target.sessionKey);
			if (this.targetSignal()?.sessionKey === target.sessionKey) {
				this.stateSignal.update((s) => ({ ...s, sending: false }));
			}
		}
	}

	/** Sends the draft, optionally forcing a follow-up for this send only. */
	async submit(mode?: "follow_up", textWithImageReferences?: string) {
		const target = this.targetSignal();
		const { value, images, sending, composing, sendMode } = this.stateSignal();
		if (!target || sending || composing) return;
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
				images: this.draftScope === "project" ? s.images : [],
				status: null,
			}));
			this.onNewChat?.();
			return;
		}
		if (this.readOnly()) return;
		const running = this.running();
		if (slash?.name === "compact") {
			if (running) {
				this.notify({
					variant: "info",
					title: t("chat.waitCompaction"),
				});
				return;
			}
			await this.executeCompact(target, slash.args, value, images);
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

		const submit = { dispatched: false, stopped: false };
		this.activeSubmits.set(target.sessionKey, submit);
		// The draft leaves the composer at once, as in the WebUI; it comes
		// back if it is not sent.
		this.historyCursor = null;
		this.updateDraft((s) => ({
			...s,
			value: "",
			caret: 0,
			images: [],
			sending: true,
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
			if (!running) {
				if (
					!(await this.ensureStartedForSubmit(target, submit, () =>
						localStatus("starting"),
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
			if (running) {
				for (const command of this.commandFor(mode ?? sendMode, submission)) {
					if (submit.stopped) return;
					submit.dispatched = true;
					await this.client.sendChatCommand(target.sessionKey, command);
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
				const outcome = await requestPiRpcOutcome<PiPromptResult>(
					this.client,
					target.sessionKey,
					{
						type: "prompt",
						message,
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
			if (!running && !isExtensionCommand) {
				if (disposition !== "handled") {
					localStatus();
					if (disposition !== "queued") {
						this.onPromptStarted?.(target, submission.text);
					}
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
			this.activeSubmits.delete(target.sessionKey);
			if (this.targetSignal()?.sessionKey === target.sessionKey) {
				this.stateSignal.update((s) => ({ ...s, sending: false }));
			}
		}
	}

	/** Restores the unsent draft before newer edits in its original scope. */
	private restoreDraft(
		target: ComposerTarget,
		draft: ComposerDraft,
		status?: string,
	) {
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
		const target = this.targetSignal();
		if (!target) return;
		const submit = this.activeSubmits.get(target.sessionKey);
		if (submit) {
			submit.stopped = true;
			// Nothing has reached Pi yet: the send ends at its next step.
			if (!submit.dispatched && !this.running()) return;
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

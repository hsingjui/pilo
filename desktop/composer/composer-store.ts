import { type Accessor, signal } from "nsh";
import { Storage } from "nsh";

import type { ChatSessionRuntimeState } from "@/lib/api/chat-session-types";
import type { PiCommand } from "@/lib/api/pi-runtime-types";
import {
	discardRemovedChatFiles,
	registerChatFile,
	retainChatFiles,
} from "@/lib/chat/chat-file-lifecycle";
import {
	fileMentionValue,
	readChatMentionDraft,
	writeChatMentionDraft,
} from "@/lib/chat/chat-mentions";
import {
	CHAT_INPUT_HISTORY_LIMIT,
	isChatInputHistoryCursorValid,
	moveChatInputHistory,
	type ChatInputHistoryDirection,
} from "@/lib/chat/chat-input-history-cursor";
import {
	createChatSubmission,
	resolveChatImageMimeType,
	toPiImageContents,
	chatSubmissionHasContent,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_IMAGE_COUNT,
	MAX_CHAT_IMAGE_TOTAL_BYTES,
	type ChatImageAttachment,
} from "@/lib/chat/chat-submission";
import {
	COMPOSER_SEND_MODE_STORAGE_KEY,
	DEFAULT_COMPOSER_SEND_MODE,
	isComposerSendMode,
	type ComposerSendMode,
} from "@/lib/chat/send-mode";
import {
	sessionMentionValue,
	type SessionMention,
} from "@/lib/chat/session-mentions";
import type { ComposerSuggestion } from "@/lib/chat/composer-suggestions";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import type { AppState } from "../state/app-state";

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
>;

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

const INPUT_HISTORY_KEY = "pilo.chatInputHistory.v1";
const COMMAND_RPC_TIMEOUT_MS = 5000;
const ATTACHMENT_NAME_LIMIT = 80;

let attachmentSequence = 0;

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(binary);
}

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
 * The composer's state for the open chat: its draft, per-project input
 * history, attachments and the send flow. Drafts live per session so switching
 * chats keeps each one's unsent text. History and the send mode persist in the
 * app's `Storage` under the same keys the Tauri frontend uses.
 */
export class ComposerStore {
	private readonly client: ComposerClient;
	private readonly app: Accessor<AppState>;
	private readonly drafts = new Map<
		string,
		{ value: string; images: ChatImageAttachment[] }
	>();
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
	private readonly commandsSignal = signal<
		readonly ComposerSuggestion[] | null
	>(null);
	private readonly fileSuggestionsSignal = signal<
		readonly ComposerSuggestion[]
	>([]);
	private histories: HistoryStore | null = null;
	private historyCursor: number | null = null;
	private fileQuery: { query: string; request: number } | null = null;
	private rpcSequence = 0;
	private commandsRequest = 0;
	private disconnect: (() => void) | null = null;

	readonly state: Accessor<ComposerViewState>;
	readonly target: Accessor<ComposerTarget | null>;
	readonly commands: Accessor<readonly ComposerSuggestion[] | null>;
	readonly fileSuggestions: Accessor<readonly ComposerSuggestion[]>;

	constructor(deps: { client: ComposerClient; app: Accessor<AppState> }) {
		this.client = deps.client;
		this.app = deps.app;
		this.state = this.stateSignal;
		this.target = this.targetSignal;
		this.commands = this.commandsSignal;
		this.fileSuggestions = this.fileSuggestionsSignal;
		void Storage.getItem(COMPOSER_SEND_MODE_STORAGE_KEY)
			.then((stored) => {
				if (isComposerSendMode(stored))
					this.stateSignal.update((s) => ({ ...s, sendMode: stored }));
			})
			.catch(() => {});
	}

	/** Swaps the open chat; each session keeps its own unsent draft. */
	setTarget(target: ComposerTarget | null) {
		const previous = this.targetSignal();
		if (previous?.sessionKey === target?.sessionKey) return;
		if (previous) {
			const { value, images } = this.stateSignal();
			this.drafts.set(previous.sessionKey, { value, images });
		}
		const next = target ? this.drafts.get(target.sessionKey) : undefined;
		this.fileSuggestionsSignal.set([]);
		this.commandsSignal.set(null);
		this.historyCursor = null;
		this.targetSignal.set(target);
		this.stateSignal.update((s) => ({
			...s,
			value: next?.value ?? "",
			caret: next?.value.length ?? 0,
			images: next?.images ?? [],
			status: null,
		}));
	}

	setValue(value: string, caret = value.length) {
		const previous = this.stateSignal().value;
		if (previous !== value) discardRemovedChatFiles(previous, value);
		this.stateSignal.update((s) => ({ ...s, value, caret }));
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

	setStatus(status: string | null) {
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

	/** Sessions the `@` menu offers, newest first, as mention draft entries. */
	sessionMentions(): readonly SessionMention[] {
		const app = this.app();
		const projects = new Map(
			app.projects.map((project) => [project.id, project]),
		);
		return Object.values(app.sessionIndexes)
			.flatMap((index) => index.sessions)
			.flatMap((session): SessionMention[] => {
				const project = projects.get(session.projectId);
				if (!project || !session.sessionPath) return [];
				return [
					{
						connectionId: session.connectionId,
						projectId: session.projectId,
						path: session.sessionPath,
						title: session.name ?? session.firstUserMessagePreview ?? "Session",
						projectName: project.name,
						updatedAt: Date.parse(session.lastMessageAt ?? session.updatedAt),
					},
				];
			})
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Mention tokens in the current draft, keyed by their written form. */
	private sessionsByValue(): ReadonlyMap<string, SessionMention> {
		return new Map(
			this.sessionMentions().map((mention) => [
				sessionMentionValue(mention.path),
				mention,
			]),
		);
	}

	mentionDraft() {
		return readChatMentionDraft(
			this.stateSignal().value,
			this.sessionsByValue(),
		);
	}

	private async appendHistory(projectId: string, text: string) {
		const entry = text.trim();
		if (!entry) return;
		await this.loadHistories();
		const current = this.histories?.[projectId] ?? [];
		if (current[current.length - 1] === entry) return;
		this.histories ??= {};
		this.histories[projectId] = [...current, entry].slice(
			-CHAT_INPUT_HISTORY_LIMIT,
		);
		void Storage.setItem(
			INPUT_HISTORY_KEY,
			JSON.stringify(this.histories),
		).catch(() => {});
	}

	async loadHistories() {
		if (this.histories) return;
		this.histories = {};
		try {
			const raw = await Storage.getItem(INPUT_HISTORY_KEY);
			if (raw) {
				const parsed: unknown = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					for (const [projectId, entries] of Object.entries(
						parsed as Record<string, unknown>,
					)) {
						if (Array.isArray(entries))
							this.histories[projectId] = entries
								.filter((entry): entry is string => typeof entry === "string")
								.map((entry) => entry.trim())
								.filter(Boolean)
								.slice(-CHAT_INPUT_HISTORY_LIMIT);
					}
				}
			}
		} catch {
			// History is a convenience; a corrupt store starts empty.
		}
	}

	/**
	 * Recalls an earlier submission of this project on ArrowUp/Down, the way the
	 * Tauri composer does: only from an empty draft, and back to empty past the
	 * newest entry. Returns whether the key was consumed.
	 */
	async navigateHistory(direction: ChatInputHistoryDirection): Promise<{
		handled: boolean;
	}> {
		const target = this.targetSignal();
		if (!target) return { handled: false };
		const { value } = this.stateSignal();
		if (this.historyCursor !== null) {
			const entries = this.histories?.[target.projectId] ?? [];
			if (!isChatInputHistoryCursorValid(entries, this.historyCursor, value)) {
				this.historyCursor = null;
				return { handled: false };
			}
		} else if (value.length > 0) {
			return { handled: false };
		}
		await this.loadHistories();
		const entries = this.histories?.[target.projectId] ?? [];
		const result = moveChatInputHistory(entries, this.historyCursor, direction);
		if (!result.handled) {
			this.historyCursor = null;
			return { handled: false };
		}
		this.historyCursor = result.cursor;
		this.stateSignal.update((s) => ({
			...s,
			value: result.value,
			caret: result.value.length,
		}));
		return { handled: true };
	}

	/** File paths matching the query for the `@` menu (debounced by the caller). */
	async searchFileSuggestions(query: string) {
		const target = this.targetSignal();
		const request = ++(this.fileQuery ??= { query: "", request: 0 }).request;
		this.fileQuery.query = query;
		try {
			const paths = await this.client.searchProjectFiles(
				target?.projectId ?? "",
				query,
			);
			if (this.fileQuery.request !== request) return;
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
			if (this.fileQuery.request === request)
				this.fileSuggestionsSignal.set([]);
		}
	}

	clearFileSuggestions() {
		this.fileSuggestionsSignal.set([]);
	}

	/** Pi's command list, cached per chat; `[]` when the chat cannot answer. */
	async loadCommands() {
		const target = this.targetSignal();
		if (!target || this.commandsSignal()) return;
		const request = ++this.commandsRequest;
		const id = `nsh-composer-${++this.rpcSequence}`;
		try {
			const reply = await this.requestPiRpc<{ commands: PiCommand[] }>(
				target.sessionKey,
				{ type: "get_commands", id },
				id,
			);
			if (this.commandsRequest !== request) return;
			const commands = reply?.commands ?? [];
			this.commandsSignal.set(
				commands.map((command) => ({
					kind: "command" as const,
					value: `/${command.name}`,
					label: `/${command.name}`,
					detail: command.description,
				})),
			);
		} catch {
			if (this.commandsRequest === request) this.commandsSignal.set([]);
		}
	}

	/**
	 * A request/response Pi RPC over the command channel: the reply arrives as
	 * an `rpc_message` session event with the command's `id`.
	 */
	private requestPiRpc<T>(
		sessionKey: string,
		command: Record<string, unknown>,
		id: string,
	): Promise<T | null> {
		return new Promise<T | null>((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				finish();
				resolve(null);
			}, COMMAND_RPC_TIMEOUT_MS);
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				this.disconnect?.();
				this.disconnect = null;
			};
			this.client
				.connectEvents({
					onMessage: (message) => {
						if (settled || message.type !== "events") return;
						for (const event of message.events) {
							if (
								event.type !== "rpc_message" ||
								event.sessionKey !== sessionKey
							)
								continue;
							const reply = event.message;
							if (
								typeof reply !== "object" ||
								reply === null ||
								(reply as Record<string, unknown>).type !== "response" ||
								(reply as Record<string, unknown>).id !== id
							)
								continue;
							const data = reply as {
								data?: T;
								success?: boolean;
								error?: string;
							};
							finish();
							if (data.success === false)
								reject(new Error(data.error ?? "Pi command failed"));
							else resolve(data.data ?? null);
							return;
						}
					},
					onStatus: (connected) => {
						if (!connected && !settled) {
							finish();
							resolve(null);
						}
					},
				})
				.then((disconnect) => {
					if (settled) {
						disconnect();
						return;
					}
					this.disconnect = disconnect;
					return this.client.sendChatCommand(sessionKey, command);
				})
				.catch((error: unknown) => {
					finish();
					reject(error instanceof Error ? error : new Error(String(error)));
				});
		});
	}

	/** Inserts picked/dropped files: images as attachments, other files as uploaded `@` mentions. */
	async addFiles(files: readonly File[]) {
		const target = this.targetSignal();
		if (!target) return;
		for (const file of files) {
			const mime = resolveChatImageMimeType(file);
			try {
				const bytes = new Uint8Array(await file.arrayBuffer());
				if (mime) {
					if (
						bytes.length > MAX_CHAT_IMAGE_BYTES ||
						this.stateSignal().images.length >= MAX_CHAT_IMAGE_COUNT ||
						this.stateSignal().images.reduce(
							(total, image) => total + image.size,
							0,
						) +
							bytes.length >
							MAX_CHAT_IMAGE_TOTAL_BYTES
					) {
						this.setStatus(
							`图片超出限制（最多 ${MAX_CHAT_IMAGE_COUNT} 张，单张 ≤10 MB）`,
						);
						continue;
					}
					const image: ChatImageAttachment = {
						id: `img-${++attachmentSequence}`,
						name: file.name || "image",
						mimeType: mime,
						size: bytes.length,
						data: bytesToBase64(bytes),
					};
					this.stateSignal.update((s) => ({
						...s,
						images: [...s.images, image],
					}));
				} else {
					const path = await this.client.uploadChatFile(
						target.projectId,
						file.name || "file",
						bytes,
					);
					registerChatFile(path, () =>
						this.client.removeChatFile(target.projectId, path),
					);
					const draft = this.mentionDraft();
					this.setValue(
						writeChatMentionDraft(
							[...draft.references, { kind: "file" as const, path }],
							draft.text,
						),
					);
				}
			} catch (error) {
				this.setStatus(`添加附件失败：${errorMessage(error)}`);
			}
		}
	}

	/** Dropped `file:` URIs, read as bytes and attached like picked files. */
	async addUris(uris: readonly string[]) {
		for (const uri of uris) {
			try {
				const response = await fetch(uri);
				const bytes = await response.arrayBuffer();
				const name = attachmentName(uri);
				await this.addFiles([
					new File([bytes], name.slice(0, ATTACHMENT_NAME_LIMIT)),
				]);
			} catch (error) {
				this.setStatus(`无法读取拖入的文件：${errorMessage(error)}`);
			}
		}
	}

	removeImage(id: string) {
		this.stateSignal.update((s) => ({
			...s,
			images: s.images.filter((image) => image.id !== id),
		}));
	}

	/** Drops a mention line from the draft's reference block. */
	removeReference(index: number) {
		const draft = this.mentionDraft();
		this.setValue(
			writeChatMentionDraft(
				draft.references.filter((_, i) => i !== index),
				draft.text,
			),
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
		switch (mode) {
			case "steer":
				return [{ type: "steer", message: submission.text, ...images }];
			case "follow_up":
				return [{ type: "follow_up", message: submission.text, ...images }];
			case "send_now":
				return [
					{ type: "abort" },
					{ type: "prompt", message: submission.text, ...images },
				];
		}
	}

	/** Sends the draft: as a prompt, or per send mode while a turn runs. */
	async submit() {
		const target = this.targetSignal();
		const { value, images, sending, composing, sendMode } = this.stateSignal();
		if (!target || sending || composing) return;
		const submission = createChatSubmission(value, images);
		if (!chatSubmissionHasContent(submission)) return;
		const running = this.running();
		if (running && this.compacting()) {
			this.setStatus("会话正在压缩上下文，请稍后");
			return;
		}
		this.stateSignal.update((s) => ({
			...s,
			sending: true,
			status: null,
		}));
		try {
			if (!running) {
				const chat = await this.client.chatState(target.sessionKey);
				if (!chat?.initialized) {
					await this.client.startChat({
						projectId: target.projectId,
						sessionKey: target.sessionKey,
						...(target.sessionPath ? { sessionPath: target.sessionPath } : {}),
					});
				}
			}
			const commands = running
				? this.commandFor(sendMode, submission)
				: [
						{
							type: "prompt",
							message: submission.text,
							...(submission.images.length > 0
								? {
										images: toPiImageContents(submission.images),
									}
								: {}),
						},
					];
			for (const command of commands) {
				await this.client.sendChatCommand(target.sessionKey, command);
			}
			retainChatFiles(submission.text);
			await this.appendHistory(target.projectId, submission.text);
			this.historyCursor = null;
			this.stateSignal.update((s) => ({
				...s,
				value: "",
				caret: 0,
				images: [],
			}));
			const key = target.sessionKey;
			this.drafts.delete(key);
		} catch (error) {
			this.setStatus(`发送失败：${errorMessage(error)}`);
		} finally {
			this.stateSignal.update((s) => ({ ...s, sending: false }));
		}
	}

	/** Stops the running turn. */
	async stop() {
		const target = this.targetSignal();
		if (!target) return;
		try {
			await this.client.sendChatCommand(target.sessionKey, {
				type: "abort",
			});
		} catch (error) {
			this.setStatus(`停止失败：${errorMessage(error)}`);
		}
	}
}

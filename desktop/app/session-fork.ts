import { type Accessor, signal } from "nsh";

import { chatSessionKey } from "@shared/api/chat-session-key";
import type {
	PiAgentState,
	PiSessionEntries,
} from "@shared/api/pi-runtime-types";
import type { ChatMessage } from "@shared/chat/conversation-types";
import { resolveAssistantForkTarget } from "@shared/chat/pi-session-fork";
import { requestPiRpcReply, type PiCommandClient } from "../client/chat-rpc";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import type { ChatTranscriptTarget } from "../state/chat-transcript-store";
import { t } from "./i18n";

export type SessionForkClient = PiCommandClient &
	Pick<NshPiloClient, "startChat" | "stopChat">;

/** A fork outcome worth surfacing; the shell shows it as a toast. */
export type SessionForkNotice = {
	id: number;
	kind: "info" | "error";
	title: string;
	description?: string;
};

export type SessionForkState = {
	/** The assistant message a fork is running for; forks serialize. */
	forkingMessageId: string | null;
	notice: SessionForkNotice | null;
};

export type SessionForkOptions = {
	/** The open chat (the fork's source); `null` closes the door. */
	target: () => ChatTranscriptTarget | null;
	/** The open chat's messages, as the row that was pressed sees them. */
	messages: () => readonly ChatMessage[];
	/** A turn in flight or an unread transcript disables forking. */
	disabled?: () => boolean;
	/** Called with the forked session once Pi names its file. */
	onForked: (projectId: string, sessionPath: string) => void;
};

const RPC_TIMEOUT_MS = 10_000;
const FORK_TIMEOUT_MS = 30_000;
/** How long a fork notice shows. */
export const NOTICE_MS = 6_000;
let noticeSequence = 0;

/**
 * Forks the open chat at an assistant message, as the Tauri app does: a
 * second chat session attaches to the source session file, runs Pi's `fork`
 * (or `clone`, when the reply ends the branch) and reports the new session's
 * file; the source session is not touched.
 */
export class SessionForker {
	private readonly current = signal<SessionForkState>({
		forkingMessageId: null,
		notice: null,
	});
	readonly state: Accessor<SessionForkState> = this.current;

	private readonly client: SessionForkClient;
	private readonly options: SessionForkOptions;

	constructor(client: SessionForkClient, options: SessionForkOptions) {
		this.client = client;
		this.options = options;
	}

	private notify(notice: Omit<SessionForkNotice, "id">): void {
		const id = ++noticeSequence;
		this.current.set({
			...this.current(),
			notice: {
				id,
				kind: notice.kind,
				title: notice.title,
				description: notice.description,
			},
		});
		setTimeout(() => {
			if (this.current().notice?.id === id) {
				this.current.set({ ...this.current(), notice: null });
			}
		}, NOTICE_MS);
	}

	dismissNotice(): void {
		this.current.set({ ...this.current(), notice: null });
	}

	private rpc<T>(
		sessionKey: string,
		command: Record<string, unknown>,
		timeoutMs = RPC_TIMEOUT_MS,
	) {
		return requestPiRpcReply<T>(
			this.client,
			sessionKey,
			command,
			timeoutMs,
		).then((reply) => {
			if (reply === null) throw new Error("Pi command timed out");
			return reply.data as T;
		});
	}

	/** Forks the open session at the assistant message `messageId`. */
	async forkAssistant(messageId: string): Promise<void> {
		const target = this.options.target();
		const state = this.current();
		if (
			!target ||
			state.forkingMessageId ||
			(this.options.disabled?.() ?? false)
		) {
			return;
		}
		if (!target.sessionPath) {
			this.notify({ kind: "error", title: t("chat.forkUnsaved") });
			return;
		}
		const messages = this.options.messages();
		this.current.set({ forkingMessageId: messageId, notice: null });
		let forkKey: string | null = null;
		try {
			// The source Pi must answer get_state/get_entries; attach it first.
			await this.client.startChat({
				projectId: target.projectId,
				sessionKey: target.sessionKey,
				sessionPath: target.sessionPath,
			});
			const [sourceState, entries] = await Promise.all([
				this.rpc<PiAgentState>(target.sessionKey, { type: "get_state" }),
				this.rpc<PiSessionEntries>(target.sessionKey, {
					type: "get_entries",
				}),
			]);
			if (!sourceState.sessionFile) {
				throw new Error(t("chat.forkUnsaved"));
			}
			const forkTarget = resolveAssistantForkTarget(
				messages,
				messageId,
				entries,
			);
			forkKey = chatSessionKey(
				target.projectId,
				`fork-runtime-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			);
			await this.client.startChat({
				projectId: target.projectId,
				sessionKey: forkKey,
				sessionPath: sourceState.sessionFile,
			});
			const result =
				forkTarget.type === "clone"
					? await this.rpc<{ cancelled: boolean }>(
							forkKey,
							{ type: "clone" },
							FORK_TIMEOUT_MS,
						)
					: await this.rpc<{ cancelled: boolean }>(
							forkKey,
							{ type: "fork", entryId: forkTarget.entryId },
							FORK_TIMEOUT_MS,
						);
			if (result.cancelled) {
				this.notify({ kind: "info", title: t("chat.forkCancelled") });
				return;
			}
			const forked = await this.rpc<PiAgentState>(forkKey, {
				type: "get_state",
			});
			if (!forked.sessionId || !forked.sessionFile) {
				throw new Error(t("chat.forkNoInfo"));
			}
			this.options.onForked(target.projectId, forked.sessionFile);
		} catch (error) {
			this.notify({
				kind: "error",
				title: t("chat.forkFailed"),
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			if (forkKey) {
				await this.client
					.stopChat(forkKey, "fork_cleanup")
					.catch(() => undefined);
			}
			if (this.current().forkingMessageId === messageId) {
				this.current.set({
					...this.current(),
					forkingMessageId: null,
				});
			}
		}
	}
}

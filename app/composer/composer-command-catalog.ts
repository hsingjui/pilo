import type { Accessor } from "nsh";
import { signal } from "nsh";

import type { HostClient } from "@shared/api/host-client";
import type { PiCommand } from "@shared/api/pi-runtime-types";
import { mergePiCommands } from "@shared/chat/pi-command-suggestions";

import { requestPiRpc } from "../client/chat-rpc";
import type { ModelCatalogStore } from "../state/model-catalog";
import type { ComposerTarget } from "./composer-drafts";

type CommandCatalogClient = Pick<HostClient, "chatState"> & {
	sendChatCommand: HostClient["sendChatCommand"];
	connectEvents: HostClient["connectEvents"];
	readonly rpcIdPrefix?: string;
};

/**
 * `/` command suggestions: the project catalog merged with commands a running
 * Pi reports for the open session (including user extension commands).
 */
export class ComposerCommandCatalog {
	private readonly sessionCommandsSignal = signal<{
		sessionKey: string;
		commands: readonly PiCommand[];
	} | null>(null);
	private commandsRequest = 0;
	private sessionCommandsInFlight: string | null = null;

	constructor(
		private readonly deps: {
			client: CommandCatalogClient;
			target: Accessor<ComposerTarget | null>;
			catalog?: Pick<ModelCatalogStore, "state" | "refresh">;
			readOnly: () => boolean;
		},
	) {}

	/** Drops cached session commands when the composer target changes. */
	reset() {
		this.commandsRequest++;
		this.sessionCommandsSignal.set(null);
		this.sessionCommandsInFlight = null;
	}

	private catalogCommands(): readonly PiCommand[] | null {
		const target = this.deps.target();
		const catalogState = this.deps.catalog?.state();
		if (!target || catalogState?.catalog?.projectId !== target.projectId) {
			return null;
		}
		return catalogState.catalog.commands ?? null;
	}

	/** Commands the open session reported, or null when Pi is stopped. */
	sessionCommands(): readonly PiCommand[] | null {
		const target = this.deps.target();
		const session = this.sessionCommandsSignal();
		if (!target || session?.sessionKey !== target.sessionKey) return null;
		return session.commands;
	}

	merged(): PiCommand[] {
		return mergePiCommands(this.catalogCommands(), this.sessionCommands());
	}

	/**
	 * Refreshes cached project commands if missing, and merges live session
	 * commands (including user extension commands) only when Pi is already running.
	 */
	async load() {
		const target = this.deps.target();
		if (!target) return;
		const catalogState = this.deps.catalog?.state();
		if (
			this.deps.catalog &&
			catalogState?.projectId === target.projectId &&
			catalogState.loaded &&
			!catalogState.refreshing &&
			(!catalogState.catalog || catalogState.catalog.commands == null)
		) {
			void this.deps.catalog.refresh();
		}
		if (
			this.deps.readOnly() ||
			this.sessionCommandsSignal()?.sessionKey === target.sessionKey ||
			this.sessionCommandsInFlight === target.sessionKey
		) {
			return;
		}
		const request = ++this.commandsRequest;
		this.sessionCommandsInFlight = target.sessionKey;
		try {
			const chat = await this.deps.client.chatState(target.sessionKey);
			if (
				this.commandsRequest !== request ||
				this.deps.target()?.sessionKey !== target.sessionKey
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
				this.deps.client,
				target.sessionKey,
				{ type: "get_commands" },
			);
			if (
				this.commandsRequest !== request ||
				this.deps.target()?.sessionKey !== target.sessionKey ||
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

	/** Queries commands from a live Pi, caching them when still targeted. */
	async fetchLive(sessionKey: string): Promise<readonly PiCommand[] | null> {
		const existing = this.sessionCommandsSignal();
		if (existing?.sessionKey === sessionKey) return existing.commands;
		try {
			const reply = await requestPiRpc<{ commands: PiCommand[] }>(
				this.deps.client,
				sessionKey,
				{ type: "get_commands" },
			);
			if (!reply?.commands) return null;
			if (this.deps.target()?.sessionKey === sessionKey) {
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
}

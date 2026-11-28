import { Storage } from "nsh";

import { CHAT_INPUT_HISTORY_LIMIT } from "@shared/chat/chat-input-history-cursor";
import {
	hostStorageKey,
	LOCAL_HOST_ID,
	readMigratedStorage,
} from "@shared/host-id";

const INPUT_HISTORY_KEY = "pilo.chatInputHistory.v1";

type HistoryStore = Record<string, string[]>;

/** Per-project prompt history persisted under the host-scoped storage key. */
export class ComposerInputHistory {
	private readonly histories: HistoryStore = {};
	private loadPromise: Promise<void> | undefined;

	constructor(private readonly hostId: string) {}

	entries(projectId: string): readonly string[] {
		return this.histories[projectId] ?? [];
	}

	load(): Promise<void> {
		return (this.loadPromise ??= readMigratedStorage(
			Storage,
			hostStorageKey(this.hostId, INPUT_HISTORY_KEY),
			this.hostId === LOCAL_HOST_ID ? INPUT_HISTORY_KEY : undefined,
		)
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

	async append(projectId: string, text: string) {
		const entry = text.trim();
		if (!entry) return;
		await this.load();
		const current = this.histories[projectId] ?? [];
		if (current[current.length - 1] === entry) return;
		this.histories[projectId] = [...current, entry].slice(
			-CHAT_INPUT_HISTORY_LIMIT,
		);
		void Storage.setItem(
			hostStorageKey(this.hostId, INPUT_HISTORY_KEY),
			JSON.stringify(this.histories),
		).catch(() => {});
	}
}

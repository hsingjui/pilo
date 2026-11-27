import {
	chatSessionKey,
	parseChatSessionKey,
} from "@shared/api/chat-session-key";
import { runtimeSessionPathKey } from "@shared/chat/chat-session-runtime-model";
import {
	hostStorageKey,
	hostStoragePrefix,
	type KeyValueStorage,
	LOCAL_HOST_ID,
	readMigratedStorageSync,
} from "@shared/host-id";
import type { ComposerTarget } from "../app/composer/composer-store";
import {
	createDraftSessionId,
	isDraftSessionId,
	isTemporarySessionKey,
} from "../app/state/app-state";

const ACTIVE_PROJECT_KEY = "pilo.web.activeProject.v1";
const DRAFT_TEXT_KEY_PREFIX = "pilo.web.draftText.v3:";
const SAVED_DRAFT_TEXT_KEY_PREFIX = "pilo.web.savedDraftText.v1:";
const LEGACY_SESSION_TEXT_PREFIX = "pilo.web.draftText.v2:";
const LEGACY_PROJECT_PREFIXES = [
	"pilo.web.draftText.v1:",
	`${LEGACY_SESSION_TEXT_PREFIX}draft:`,
];

type TabStorage = KeyValueStorage & {
	readonly length: number;
	key(index: number): string | null;
};

export function createWebWorkspaceStorage(
	storage: TabStorage,
	hostId = LOCAL_HOST_ID,
) {
	const isLocal = hostId === LOCAL_HOST_ID;
	const activeProjectKey = hostStorageKey(hostId, ACTIVE_PROJECT_KEY);
	const draftPrefix = hostStoragePrefix(hostId, DRAFT_TEXT_KEY_PREFIX);
	const savedDraftPrefix = hostStoragePrefix(
		hostId,
		SAVED_DRAFT_TEXT_KEY_PREFIX,
	);
	const legacyKeys = (...keys: string[]) => (isLocal ? keys : []);
	const read = (key: string, ...legacy: string[]) => {
		try {
			return readMigratedStorageSync(storage, key, ...legacy);
		} catch {
			return null;
		}
	};
	const write = (key: string, text: string, ...legacy: string[]) => {
		try {
			if (text) storage.setItem(key, text);
			else storage.removeItem(key);
			for (const previous of legacy) storage.removeItem(previous);
			return true;
		} catch {
			// Browser storage may be disabled or full; keep the live draft usable.
			return false;
		}
	};
	const draftKeys = ({
		sessionKey,
		projectId,
		sessionPath,
	}: ComposerTarget) => {
		if (isTemporarySessionKey(sessionKey)) return null;
		if (!sessionPath)
			return [
				draftPrefix + sessionKey,
				...legacyKeys(DRAFT_TEXT_KEY_PREFIX + sessionKey),
			] as const;
		const suffix = chatSessionKey(
			projectId,
			runtimeSessionPathKey(sessionPath),
		);
		return [
			savedDraftPrefix + suffix,
			...legacyKeys(
				SAVED_DRAFT_TEXT_KEY_PREFIX + suffix,
				LEGACY_SESSION_TEXT_PREFIX + sessionKey,
			),
		] as const;
	};

	return {
		readActiveProject: () =>
			read(activeProjectKey, ...legacyKeys(ACTIVE_PROJECT_KEY)),
		writeActiveProject: (projectId: string) =>
			write(activeProjectKey, projectId),
		draftText: {
			read(target: ComposerTarget) {
				const keys = draftKeys(target);
				return keys ? read(...keys) : null;
			},
			write(target: ComposerTarget, text: string) {
				const keys = draftKeys(target);
				return keys ? write(keys[0], text, ...keys.slice(1)) : false;
			},
		},
		restoreDrafts(onDraft: (target: ComposerTarget, text: string) => void) {
			let keys: (string | null)[];
			try {
				keys = Array.from({ length: storage.length }, (_, index) =>
					storage.key(index),
				);
			} catch {
				return;
			}
			const seen = new Set<string>();
			for (const key of keys) {
				if (!key) continue;
				const prefix = [draftPrefix, ...legacyKeys(DRAFT_TEXT_KEY_PREFIX)].find(
					(prefix) => key.startsWith(prefix),
				);
				if (prefix) {
					const sessionKey = key.slice(prefix.length);
					if (seen.has(sessionKey)) continue;
					seen.add(sessionKey);
					const text = read(
						draftPrefix + sessionKey,
						...legacyKeys(DRAFT_TEXT_KEY_PREFIX + sessionKey),
					);
					if (!text?.trim()) continue;
					const parsed = parseChatSessionKey(sessionKey);
					if (parsed && isDraftSessionId(parsed[1]))
						onDraft({ sessionKey, projectId: parsed[0] }, text);
					continue;
				}
				const legacyPrefix = legacyKeys(...LEGACY_PROJECT_PREFIXES).find(
					(prefix) => key.startsWith(prefix),
				);
				if (!legacyPrefix) continue;
				const text = read(key);
				if (!text?.trim()) continue;
				const projectId = key.slice(legacyPrefix.length);
				const sessionKey = chatSessionKey(projectId, createDraftSessionId());
				if (write(draftPrefix + sessionKey, text, key))
					onDraft({ sessionKey, projectId }, text);
			}
		},
	};
}

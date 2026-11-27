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
	isDraftSessionId,
	isTemporarySessionKey,
} from "../app/state/app-state";

const ACTIVE_PROJECT_KEY = "pilo.web.activeProject.v1";
const DRAFT_TEXT_KEY_PREFIX = "pilo.web.draftText.v3:";
const SAVED_DRAFT_TEXT_KEY_PREFIX = "pilo.web.savedDraftText.v1:";
const LEGACY_SESSION_TEXT_PREFIX = "pilo.web.draftText.v2:";
const LEGACY_PROJECT_DRAFTS = [
	{ prefix: "pilo.web.draftText.v1:", sessionId: "draft-session-legacy-v1" },
	{
		prefix: `${LEGACY_SESSION_TEXT_PREFIX}draft:`,
		sessionId: "draft-session-legacy-v2",
	},
] as const;

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
			if (text) {
				storage.setItem(key, text);
				for (const previous of legacy) removeLegacy(previous);
			} else {
				for (const previous of legacy) storage.removeItem(previous);
				storage.removeItem(key);
			}
			return true;
		} catch {
			// Browser storage may be disabled or full; keep the live draft usable.
			return false;
		}
	};
	const removeLegacy = (key: string) => {
		try {
			storage.removeItem(key);
		} catch {
			// A saved copy wins even when cleanup must wait until the next load.
		}
	};
	const legacyProjectKey = (sessionKey: string) => {
		if (!isLocal) return undefined;
		const parsed = parseChatSessionKey(sessionKey);
		if (!parsed) return undefined;
		const [projectId, sessionId] = parsed;
		const legacy = LEGACY_PROJECT_DRAFTS.find(
			(draft) => draft.sessionId === sessionId,
		);
		return legacy && legacy.prefix + projectId;
	};
	const draftKeys = ({
		sessionKey,
		projectId,
		sessionPath,
	}: ComposerTarget) => {
		if (isTemporarySessionKey(sessionKey)) return null;
		if (!sessionPath) {
			const projectKey = legacyProjectKey(sessionKey);
			return [
				draftPrefix + sessionKey,
				...legacyKeys(DRAFT_TEXT_KEY_PREFIX + sessionKey),
				...(projectKey ? [projectKey] : []),
			] as const;
		}
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

	function readDraft(target: ComposerTarget) {
		const keys = draftKeys(target);
		return keys ? read(...keys) : null;
	}

	return {
		readActiveProject: () =>
			read(activeProjectKey, ...legacyKeys(ACTIVE_PROJECT_KEY)),
		writeActiveProject: (projectId: string) =>
			write(activeProjectKey, projectId),
		draftText: {
			read: readDraft,
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
			const restore = (sessionKey: string) => {
				if (seen.has(sessionKey)) return;
				seen.add(sessionKey);
				const parsed = parseChatSessionKey(sessionKey);
				if (!parsed || !isDraftSessionId(parsed[1])) return;
				const target = { sessionKey, projectId: parsed[0] };
				const projectKey = legacyProjectKey(sessionKey);
				const current = projectKey ? read(draftPrefix + sessionKey) : null;
				if (current !== null && projectKey) removeLegacy(projectKey);
				const text = current ?? readDraft(target);
				if (text?.trim()) onDraft(target, text);
			};
			for (const key of keys) {
				if (!key) continue;
				const prefix = [draftPrefix, ...legacyKeys(DRAFT_TEXT_KEY_PREFIX)].find(
					(prefix) => key.startsWith(prefix),
				);
				if (prefix) {
					restore(key.slice(prefix.length));
					continue;
				}
				const legacy =
					isLocal &&
					LEGACY_PROJECT_DRAFTS.find(({ prefix }) => key.startsWith(prefix));
				if (legacy)
					restore(
						chatSessionKey(key.slice(legacy.prefix.length), legacy.sessionId),
					);
			}
		},
	};
}

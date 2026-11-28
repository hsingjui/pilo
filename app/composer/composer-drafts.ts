import { chatSessionKey } from "@shared/api/chat-session-key";
import type { ChatImageAttachment } from "@shared/chat/chat-submission";
import { runtimeSessionPathKey } from "@shared/chat/chat-session-runtime-model";

/** The open chat the composer talks to. */
export type ComposerTarget = {
	sessionKey: string;
	projectId: string;
	sessionPath?: string | null;
};

export type ComposerDraft = {
	value: string;
	images: ChatImageAttachment[];
};

export type ComposerDraftTextStorage = {
	read: (target: ComposerTarget) => string | null;
	write: (target: ComposerTarget, value: string) => boolean;
};

export const EMPTY_DRAFT: ComposerDraft = { value: "", images: [] };

/**
 * Draft text and images are isolated per session (`sessionKey`) to avoid
 * cross-talk across parallel chats. New-chat drafts additionally persist in
 * `draftTextStorage` so they survive navigation and restarts.
 */
export class ComposerDraftRepository {
	private readonly drafts = new Map<string, ComposerDraft>();

	constructor(
		private readonly deps: {
			draftTextStorage?: ComposerDraftTextStorage;
			onUnsentDraft?: (target: ComposerTarget, text: string | null) => void;
		},
	) {}

	key({ sessionKey, projectId, sessionPath }: ComposerTarget) {
		return sessionPath
			? `file:${chatSessionKey(projectId, runtimeSessionPathKey(sessionPath))}`
			: sessionKey;
	}

	/** Moves a new-chat draft onto its persisted session path once known. */
	adoptPath(previous: ComposerTarget, saved: ComposerTarget) {
		const key = this.key(previous);
		const draft = this.for(previous);
		if (draft !== EMPTY_DRAFT) {
			this.drafts.set(this.key(saved), draft);
			this.drafts.delete(key);
			if (
				draft.value &&
				this.deps.draftTextStorage?.write(saved, draft.value)
			) {
				this.deps.draftTextStorage.write(previous, "");
			}
		}
		this.deps.onUnsentDraft?.(saved, null);
	}

	for(target: ComposerTarget): ComposerDraft {
		const key = this.key(target);
		const cached = this.drafts.get(key);
		if (cached) return cached;
		const value = this.deps.draftTextStorage?.read(target);
		if (!value) return EMPTY_DRAFT;
		const restored = { ...EMPTY_DRAFT, value };
		this.drafts.set(key, restored);
		return restored;
	}

	cache(target: ComposerTarget, { value, images }: ComposerDraft) {
		const key = this.key(target);
		const previous = this.drafts.get(key)?.value ?? "";
		// Keep empty drafts in memory when a failed storage write could leave stale text.
		if (value || images.length || this.deps.draftTextStorage)
			this.drafts.set(key, { value, images });
		else this.drafts.delete(key);
		if (value !== previous) this.deps.draftTextStorage?.write(target, value);
		if (!target.sessionPath)
			this.deps.onUnsentDraft?.(
				target,
				value.trim() || images.length ? value : null,
			);
	}
}

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import type { ChatDraftStore } from "@/components/chat/chat-draft-store";
import type {
	ChatImageAttachment,
	ChatSubmission,
} from "@/lib/chat/chat-submission";

/**
 * Composer-side draft state that survives a failed submission: the image
 * attachments plus the restore/recover callbacks the runtime uses to put a
 * rejected submission back into the composer. Read the latest draft directly
 * from the store so recovery does not subscribe the page to each keystroke.
 */
export function useChatSubmissionRecovery({
	draftStore,
	setDraft,
	active = false,
	projectId,
	readProjectDraft,
}: {
	draftStore: ChatDraftStore;
	setDraft: (value: string) => void;
	active?: boolean;
	projectId?: string;
	readProjectDraft?: (projectId: string) => string;
}) {
	const [composerImages, setComposerImages] = useState<ChatImageAttachment[]>(
		[],
	);
	const composerImagesRef = useRef(composerImages);
	useLayoutEffect(() => {
		composerImagesRef.current = composerImages;
	}, [composerImages]);
	// Drafts live at the project level, so a session that was mounted before the
	// shared draft changed picks up the latest value when it becomes visible.
	useEffect(() => {
		if (!active || !projectId || !readProjectDraft) return;
		const value = readProjectDraft(projectId);
		if (draftStore.getSnapshot() === value) return;
		setDraft(value);
	}, [active, draftStore, projectId, readProjectDraft, setDraft]);
	const restoreSubmission = useCallback(
		(submission: ChatSubmission) => {
			composerImagesRef.current = [...submission.images];
			setDraft(submission.text);
			setComposerImages([...submission.images]);
		},
		[setDraft],
	);
	const recoverSubmission = useCallback(
		(submission: ChatSubmission) => {
			const currentText = draftStore.getSnapshot().trim();
			const nextText = [currentText, submission.text]
				.filter(Boolean)
				.join("\n\n");
			const seenImageIds = new Set<string>();
			const nextImages = [
				...composerImagesRef.current,
				...submission.images,
			].filter((image) => {
				if (seenImageIds.has(image.id)) return false;
				seenImageIds.add(image.id);
				return true;
			});
			composerImagesRef.current = nextImages;
			setDraft(nextText);
			setComposerImages(nextImages);
		},
		[draftStore, setDraft],
	);
	return {
		composerImages,
		setComposerImages,
		restoreSubmission,
		recoverSubmission,
	};
}

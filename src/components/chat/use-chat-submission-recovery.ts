import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import type {
	ChatImageAttachment,
	ChatSubmission,
} from "@/lib/chat-submission";

/**
 * Composer-side draft state that survives a failed submission: the image
 * attachments plus the restore/recover callbacks the runtime uses to put a
 * rejected submission back into the composer. Draft and image refs mirror the
 * latest values so the callbacks stay stable across renders.
 */
export function useChatSubmissionRecovery({
	draft,
	setDraft,
	active = false,
	projectId,
	readProjectDraft,
}: {
	draft: string;
	setDraft: (value: string) => void;
	active?: boolean;
	projectId?: string;
	readProjectDraft?: (projectId: string) => string;
}) {
	const [composerImages, setComposerImages] = useState<ChatImageAttachment[]>(
		[],
	);
	const draftRef = useRef(draft);
	const composerImagesRef = useRef(composerImages);
	useLayoutEffect(() => {
		draftRef.current = draft;
	}, [draft]);
	useLayoutEffect(() => {
		composerImagesRef.current = composerImages;
	}, [composerImages]);
	// Drafts live at the project level, so a session that was mounted before the
	// shared draft changed picks up the latest value when it becomes visible.
	useEffect(() => {
		if (!active || !projectId || !readProjectDraft) return;
		const value = readProjectDraft(projectId);
		if (draftRef.current === value) return;
		draftRef.current = value;
		setDraft(value);
	}, [active, projectId, readProjectDraft, setDraft]);
	const restoreSubmission = useCallback(
		(submission: ChatSubmission) => {
			draftRef.current = submission.text;
			composerImagesRef.current = [...submission.images];
			setDraft(submission.text);
			setComposerImages([...submission.images]);
		},
		[setDraft],
	);
	const recoverSubmission = useCallback(
		(submission: ChatSubmission) => {
			const currentText = draftRef.current.trim();
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
			draftRef.current = nextText;
			composerImagesRef.current = nextImages;
			setDraft(nextText);
			setComposerImages(nextImages);
		},
		[setDraft],
	);
	return {
		composerImages,
		setComposerImages,
		restoreSubmission,
		recoverSubmission,
	};
}

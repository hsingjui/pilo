import {
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
	useCallback,
} from "react";

import { chatUiStateKey } from "@/components/app/app-chat-state";
import type {
	ChatUiStateCache,
	ProjectDraftCache,
} from "@/components/app/chat-ui-state-cache";
import type { ChatSessionRuntimeState } from "@/components/chat/chat-page-utils";
import type { ChatImageAttachment } from "@/lib/chat-submission";
import { createConversationState } from "@/lib/conversation-reducer";
import type { ConversationState } from "@/lib/conversation-types";
import type { PiAgentState, PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import type { SessionIndexEntry } from "@/lib/sessions";
import { randomId } from "@/lib/utils";
import { sessionKey } from "./remote-app-model";
import type { QueuedSubmission } from "./use-remote-chat-transport";

type UseRemoteChatDraftActionsOptions = {
	activeProjectId: string;
	draftId: string;
	draftTemporary: boolean;
	selectedSession: SessionIndexEntry | null;
	identifiedDraftSessionId: string | null;
	selectedSessionPath: string | null;
	rawSessions: SessionIndexEntry[];
	isNarrow: boolean;
	closeMobileNavigation: () => void;
	chatUiStateCache: ChatUiStateCache;
	projectDraftCache: ProjectDraftCache;
	queuedSubmissionsRef: MutableRefObject<Map<string, QueuedSubmission>>;
	autoTitleRequestedRef: MutableRefObject<boolean>;
	refreshProjectSessions: (
		projectId: string,
		showProgress?: boolean,
	) => Promise<void>;
	setSelectedSessionPath: Dispatch<SetStateAction<string | null>>;
	setIdentifiedDraftSessionId: Dispatch<SetStateAction<string | null>>;
	setDraftTemporary: Dispatch<SetStateAction<boolean>>;
	setDraftId: Dispatch<SetStateAction<string>>;
	setConversation: Dispatch<SetStateAction<ConversationState>>;
	setRuntimeReady: Dispatch<SetStateAction<boolean>>;
	setReadOnly: Dispatch<SetStateAction<boolean>>;
	setAgentState: Dispatch<SetStateAction<PiAgentState | null>>;
	setChatState: Dispatch<SetStateAction<ChatSessionRuntimeState | null>>;
	setModels: Dispatch<SetStateAction<PiModel[]>>;
	setThinkingLevels: Dispatch<SetStateAction<PiThinkingLevel[]>>;
	setDraftModel: Dispatch<SetStateAction<PiModel | null>>;
	setDraftThinkingLevel: Dispatch<SetStateAction<PiThinkingLevel | null>>;
	setComposer: Dispatch<SetStateAction<string>>;
	setImages: Dispatch<SetStateAction<ChatImageAttachment[]>>;
	setVisualReadyRouteKey: Dispatch<SetStateAction<string | null>>;
	setDraftProjectId: Dispatch<SetStateAction<string>>;
	setRuntimeSessionKeys: Dispatch<SetStateAction<ReadonlyMap<string, string>>>;
};

export function useRemoteChatDraftActions({
	activeProjectId,
	draftId,
	draftTemporary,
	selectedSession,
	identifiedDraftSessionId,
	selectedSessionPath,
	rawSessions,
	isNarrow,
	closeMobileNavigation,
	chatUiStateCache,
	projectDraftCache,
	queuedSubmissionsRef,
	autoTitleRequestedRef,
	refreshProjectSessions,
	setSelectedSessionPath,
	setIdentifiedDraftSessionId,
	setDraftTemporary,
	setDraftId,
	setConversation,
	setRuntimeReady,
	setReadOnly,
	setAgentState,
	setChatState,
	setModels,
	setThinkingLevels,
	setDraftModel,
	setDraftThinkingLevel,
	setComposer,
	setImages,
	setVisualReadyRouteKey,
	setDraftProjectId,
	setRuntimeSessionKeys,
}: UseRemoteChatDraftActionsOptions) {
	const startDraft = useCallback(
		(projectId?: string, temporary = false) => {
			const targetProjectId = projectId ?? activeProjectId ?? "";
			queuedSubmissionsRef.current.clear();
			setSelectedSessionPath(null);
			setIdentifiedDraftSessionId(null);
			setDraftTemporary(temporary);
			setDraftId(randomId());
			setConversation(createConversationState());
			setRuntimeReady(false);
			setReadOnly(false);
			setAgentState(null);
			setChatState(null);
			setModels([]);
			setThinkingLevels([]);
			setDraftModel(null);
			setDraftThinkingLevel(null);
			setComposer(
				!temporary && targetProjectId
					? projectDraftCache.get(targetProjectId)
					: "",
			);
			setImages([]);
			autoTitleRequestedRef.current = false;
			setVisualReadyRouteKey(null);
			if (targetProjectId) setDraftProjectId(targetProjectId);
			if (isNarrow) closeMobileNavigation();
		},
		[
			activeProjectId,
			autoTitleRequestedRef,
			closeMobileNavigation,
			isNarrow,
			projectDraftCache,
			queuedSubmissionsRef,
			setAgentState,
			setChatState,
			setComposer,
			setConversation,
			setDraftId,
			setDraftModel,
			setDraftProjectId,
			setDraftTemporary,
			setDraftThinkingLevel,
			setIdentifiedDraftSessionId,
			setImages,
			setModels,
			setReadOnly,
			setRuntimeReady,
			setSelectedSessionPath,
			setThinkingLevels,
			setVisualReadyRouteKey,
		],
	);

	const startTemporaryDraft = useCallback(
		(projectId?: string) => startDraft(projectId, true),
		[startDraft],
	);

	const toggleTemporaryChat = useCallback(
		(projectId?: string) => {
			if (draftTemporary && !selectedSession) startDraft(projectId);
			else startTemporaryDraft(projectId);
		},
		[draftTemporary, selectedSession, startDraft, startTemporaryDraft],
	);

	const switchDraftProject = useCallback(
		(projectId: string) => {
			queuedSubmissionsRef.current.clear();
			setDraftProjectId(projectId);
			setDraftId(randomId());
			setIdentifiedDraftSessionId(null);
			setConversation(createConversationState());
			setRuntimeReady(false);
			setReadOnly(false);
			setAgentState(null);
			setChatState(null);
			setModels([]);
			setThinkingLevels([]);
			setDraftModel(null);
			setDraftThinkingLevel(null);
			setComposer(projectDraftCache.get(projectId));
			setImages([]);
			autoTitleRequestedRef.current = false;
			setVisualReadyRouteKey(null);
		},
		[
			autoTitleRequestedRef,
			projectDraftCache,
			queuedSubmissionsRef,
			setAgentState,
			setChatState,
			setComposer,
			setConversation,
			setDraftId,
			setDraftModel,
			setDraftProjectId,
			setDraftThinkingLevel,
			setIdentifiedDraftSessionId,
			setImages,
			setModels,
			setReadOnly,
			setRuntimeReady,
			setThinkingLevels,
			setVisualReadyRouteKey,
		],
	);

	const handleSelectSession = useCallback(
		(sessionId: string) => {
			const session = rawSessions.find(
				(candidate) => candidate.piSessionId === sessionId,
			);
			if (!session) return;
			if (
				session.piSessionId === identifiedDraftSessionId &&
				selectedSessionPath === null
			) {
				if (isNarrow) closeMobileNavigation();
				return;
			}
			queuedSubmissionsRef.current.clear();
			setDraftTemporary(false);
			setSelectedSessionPath(session.sessionPath);
			setDraftProjectId(session.projectId);
			setComposer(
				chatUiStateCache.get(
					chatUiStateKey(session.projectId, session.piSessionId),
				).draft,
			);
			setImages([]);
			setVisualReadyRouteKey(null);
			if (isNarrow) closeMobileNavigation();
		},
		[
			chatUiStateCache,
			closeMobileNavigation,
			identifiedDraftSessionId,
			isNarrow,
			queuedSubmissionsRef,
			rawSessions,
			selectedSessionPath,
			setComposer,
			setDraftProjectId,
			setDraftTemporary,
			setImages,
			setSelectedSessionPath,
			setVisualReadyRouteKey,
		],
	);

	const identifyDraftSession = useCallback(
		(state: PiAgentState) => {
			if (selectedSession || !activeProjectId || !state.sessionId) return;
			const previousKey = chatUiStateKey(activeProjectId, draftId);
			const nextKey = chatUiStateKey(activeProjectId, state.sessionId);
			chatUiStateCache.rekey(previousKey, nextKey);
			setRuntimeSessionKeys((current) => {
				const next = new Map(current);
				next.set(state.sessionId!, sessionKey(activeProjectId, draftId));
				return next;
			});
			setIdentifiedDraftSessionId(state.sessionId);
			void refreshProjectSessions(activeProjectId, true);
		},
		[
			activeProjectId,
			chatUiStateCache,
			draftId,
			refreshProjectSessions,
			selectedSession,
			setIdentifiedDraftSessionId,
			setRuntimeSessionKeys,
		],
	);

	return {
		startDraft,
		toggleTemporaryChat,
		switchDraftProject,
		handleSelectSession,
		identifyDraftSession,
	};
}

import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
	createDraftSessionId,
	mergeSidebarSessionsWithOpenChats,
	resolveChatSession,
	syncOpenedChatSessionMetadata,
	touchOpenedChat,
	trimOpenedChats,
	upsertOpenedChat,
	type OpenChat,
} from "@/components/app/app-chat-state";
import {
	createChatUiStateCache,
	createProjectDraftCache,
	type ChatUiStateCache,
	type ChatUiStatePatch,
	type ProjectDraftCache,
} from "@/components/app/chat-ui-state-cache";
import { useAppChatNavigation } from "@/components/app/use-app-chat-navigation";
import { useAppChatSessionActions } from "@/components/app/use-app-chat-session-actions";
import { useAppSessionIndex } from "@/components/app/use-app-session-index";
import { useSessionUnread } from "@/components/app/use-session-unread";
import type { BusyChatControllersRef } from "@/components/app/use-opened-chat-controllers";
import type { ChatSession } from "@/components/chat/chat-page";
import type { ChatSubmission } from "@/lib/chat-submission";
import type { PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import { findReusableChatRuntime } from "@/lib/chat-session-runtime-model";
import type { Project } from "@/lib/projects";

type UseAppChatWorkspaceOptions = {
	projects: Project[];
	projectsReady: boolean;
	firstProject: Project | null;
	openedChats: OpenChat[];
	setOpenedChats: Dispatch<SetStateAction<OpenChat[]>>;
	busyChatControllersRef: BusyChatControllersRef;
	busyChatControllerSince: ReadonlyMap<string, Date>;
	preloadChatPage: () => Promise<unknown>;
};

export function useAppChatWorkspace({
	projects,
	projectsReady,
	firstProject,
	openedChats,
	setOpenedChats,
	busyChatControllersRef,
	busyChatControllerSince,
	preloadChatPage,
}: UseAppChatWorkspaceOptions) {
	const { t } = useTranslation();
	const chatUiStateCacheRef = useRef<ChatUiStateCache | null>(null);
	if (chatUiStateCacheRef.current === null) {
		chatUiStateCacheRef.current = createChatUiStateCache();
	}
	const readChatUiState = useCallback(
		(key: string) => chatUiStateCacheRef.current!.get(key),
		[],
	);
	const writeChatUiState = useCallback(
		(key: string, patch: ChatUiStatePatch) => {
			chatUiStateCacheRef.current!.patch(key, patch);
		},
		[],
	);
	const projectDraftCacheRef = useRef<ProjectDraftCache | null>(null);
	if (projectDraftCacheRef.current === null) {
		projectDraftCacheRef.current = createProjectDraftCache();
	}
	const readProjectDraft = useCallback(
		(projectId: string) => projectDraftCacheRef.current!.get(projectId),
		[],
	);
	const writeProjectDraft = useCallback((projectId: string, value: string) => {
		projectDraftCacheRef.current!.set(projectId, value);
	}, []);

	const pendingLandingSubmissionRef = useRef<{
		submission: ChatSubmission;
		model: PiModel | null;
		thinkingLevel: PiThinkingLevel | null;
	} | null>(null);
	const [draftSessionPrompt, setDraftSessionPrompt] = useState<string | null>(
		null,
	);
	const [draftSessionImages, setDraftSessionImages] = useState<
		ChatSubmission["images"]
	>([]);
	const [draftSessionModel, setDraftSessionModel] = useState<PiModel | null>(
		null,
	);
	const [draftSessionThinkingLevel, setDraftSessionThinkingLevel] =
		useState<PiThinkingLevel | null>(null);
	const [draftSessionStarted, setDraftSessionStarted] = useState(false);
	// 落地页是否处于「临时会话」草稿态：点击临时会话按钮只切到落地页，
	// 直到首条消息发送才真正建立会话。
	const [draftTemporary, setDraftTemporary] = useState(false);
	const [draftSessionId, setDraftSessionId] = useState(createDraftSessionId);
	const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
	const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);

	const clearDraftSession = useCallback(() => {
		setDraftSessionStarted(false);
		setDraftTemporary(false);
		setDraftSessionPrompt(null);
		setDraftSessionImages([]);
		setDraftSessionModel(null);
		setDraftSessionThinkingLevel(null);
	}, []);

	const handleProjectsRemoved = useCallback(
		(removedProjectIds: ReadonlySet<string>, nextProjects: Project[]) => {
			setOpenedChats((current) =>
				current.filter(
					(entry) => !removedProjectIds.has(entry.session.projectRecord.id),
				),
			);
			if (!draftProjectId || !removedProjectIds.has(draftProjectId)) return;
			setDraftProjectId(nextProjects[0]?.id ?? null);
			setSelectedSessionId(null);
			clearDraftSession();
		},
		[clearDraftSession, draftProjectId, setOpenedChats],
	);

	const activeProject =
		projects.find((project) => project.id === draftProjectId) ?? firstProject;
	const focusedProject =
		projects.find((project) => project.id === focusedProjectId) ??
		activeProject;
	const activeProjectId = activeProject?.id ?? null;

	const {
		indexedSessions,
		runtimeStates,
		isExternalOpenTurn,
		refreshProjectSessions,
		refreshingProjectIds,
		sidebarSessions: indexedSidebarSessions,
		updateSession: updateIndexedSession,
		removeSession: removeIndexedSession,
	} = useAppSessionIndex(projects.map((project) => project.id));
	useEffect(() => {
		setOpenedChats((current) =>
			syncOpenedChatSessionMetadata(current, indexedSessions),
		);
	}, [indexedSessions, setOpenedChats]);

	const sidebarSessionsBase = useMemo(
		() =>
			mergeSidebarSessionsWithOpenChats(
				indexedSidebarSessions,
				openedChats,
				busyChatControllerSince,
			),
		[indexedSidebarSessions, openedChats, busyChatControllerSince],
	);

	// 未读标记：agent 从运行中转为空闲时置为未读，打开会话即清除。
	const unreadSessionIds = useSessionUnread(
		sidebarSessionsBase,
		selectedSessionId,
	);

	const sidebarSessions = useMemo(
		() =>
			unreadSessionIds.size === 0
				? sidebarSessionsBase
				: sidebarSessionsBase.map((session) =>
						unreadSessionIds.has(session.id)
							? { ...session, unread: true }
							: session,
					),
		[sidebarSessionsBase, unreadSessionIds],
	);

	const selectedIndexedSession =
		indexedSessions.find(
			(session) => session.piSessionId === selectedSessionId,
		) ?? null;
	const selectedOpenedChat = selectedSessionId
		? (openedChats.find(
				(entry) =>
					entry.session.id === selectedSessionId ||
					entry.piSessionId === selectedSessionId,
			) ?? null)
		: null;
	const selectedRuntimeState = selectedIndexedSession
		? findReusableChatRuntime(
				runtimeStates,
				selectedIndexedSession.projectId,
				selectedIndexedSession.sessionPath,
			)
		: null;
	const selectedOpenedChatBusy = selectedOpenedChat
		? busyChatControllerSince.has(selectedOpenedChat.controllerId) ||
			Boolean(selectedRuntimeState)
		: false;
	const selectedProject = selectedIndexedSession
		? (projects.find(
				(project) => project.id === selectedIndexedSession.projectId,
			) ?? null)
		: null;

	const chatSession = useMemo<ChatSession | null>(
		() =>
			resolveChatSession({
				selectedOpenedChat,
				selectedOpenedChatBusy,
				selectedIndexedSession,
				selectedProject,
				isExternalOpenTurn,
				activeProject: activeProject ?? null,
				draftSessionStarted,
				draftTemporary,
				draftSessionId,
				draftSessionModel,
				draftSessionThinkingLevel,
			}),
		[
			selectedOpenedChat,
			selectedOpenedChatBusy,
			selectedIndexedSession,
			selectedProject,
			isExternalOpenTurn,
			activeProject,
			draftSessionStarted,
			draftTemporary,
			draftSessionId,
			draftSessionModel,
			draftSessionThinkingLevel,
		],
	);

	const renderedOpenedChats = useMemo(
		() =>
			chatSession
				? upsertOpenedChat(
						openedChats,
						chatSession,
						draftSessionPrompt ?? undefined,
						draftSessionImages,
					)
				: openedChats,
		[chatSession, draftSessionImages, draftSessionPrompt, openedChats],
	);

	const startDraftSession = useCallback(
		(
			project: Project,
			submission: ChatSubmission,
			model: PiModel | null,
			thinkingLevel: PiThinkingLevel | null,
		) => {
			const prompt = submission.text;
			const isTemporary = draftTemporary;
			const nextChat: ChatSession = {
				id: draftSessionId,
				title: isTemporary ? t("app.temporaryChat") : t("app.newChat"),
				projectRecord: project,
				temporary: isTemporary || undefined,
				initialModel: model ?? undefined,
				initialThinkingLevel: thinkingLevel ?? undefined,
			};
			setOpenedChats((current) =>
				trimOpenedChats(
					touchOpenedChat(current, nextChat, prompt, submission.images),
					busyChatControllersRef.current,
				),
			);
			setDraftProjectId(project.id);
			setSelectedSessionId(draftSessionId);
			setDraftSessionModel(model);
			setDraftSessionThinkingLevel(thinkingLevel);
			setDraftSessionPrompt(prompt);
			setDraftSessionImages(submission.images);
			setDraftSessionStarted(true);
		},
		[busyChatControllersRef, draftSessionId, draftTemporary, setOpenedChats, t],
	);

	const startLandingSession = useCallback(
		(
			submission: ChatSubmission,
			model: PiModel | null,
			thinkingLevel: PiThinkingLevel | null,
		) => {
			if (!projectsReady) {
				pendingLandingSubmissionRef.current = {
					submission,
					model,
					thinkingLevel,
				};
				return;
			}
			if (!activeProject) {
				toast.info(t("app.addProjectFirst"));
				return;
			}
			startDraftSession(activeProject, submission, model, thinkingLevel);
		},
		[activeProject, projectsReady, startDraftSession, t],
	);

	/* oxlint-disable react/set-state-in-effect -- Replaying a landing submission is intentionally triggered when the asynchronous project catalog becomes ready. */
	useEffect(() => {
		if (!projectsReady) return;
		const pending = pendingLandingSubmissionRef.current;
		if (!pending) return;
		pendingLandingSubmissionRef.current = null;
		if (!activeProject) {
			toast.info(t("app.addProjectFirst"));
			return;
		}
		startDraftSession(
			activeProject,
			pending.submission,
			pending.model,
			pending.thinkingLevel,
		);
	}, [activeProject, projectsReady, startDraftSession, t]);
	/* oxlint-enable react/set-state-in-effect */

	useEffect(() => {
		if (chatSession || !activeProject) return;
		void preloadChatPage().catch(() => undefined);
	}, [activeProject, chatSession, preloadChatPage]);

	const {
		startNewChat,
		startTemporaryChat,
		selectSession,
		switchDraftProject,
		openSearchSession,
	} = useAppChatNavigation({
		projects,
		activeProject: activeProject ?? null,
		focusedProject: focusedProject ?? null,
		openedChats,
		indexedSessions,
		runtimeStates,
		busyChatControllersRef,
		setOpenedChats,
		clearDraftSession,
		setDraftSessionId,
		setDraftTemporary,
		setDraftProjectId,
		setFocusedProjectId,
		setSelectedSessionId,
		refreshProjectSessions,
	});

	const {
		updateSession,
		deleteSession,
		handleSessionIdentified,
		handleForkSessionCreated,
	} = useAppChatSessionActions({
		indexedSessions,
		updateIndexedSession,
		removeIndexedSession,
		setOpenedChats,
		setSelectedSessionId,
		chatUiStateCacheRef,
		draftSessionId,
		setDraftSessionPrompt,
		setDraftSessionImages,
		busyChatControllersRef,
		clearDraftSession,
		setDraftProjectId,
		setFocusedProjectId,
		refreshProjectSessions,
	});

	return {
		activeProject,
		activeProjectId,
		selectedSessionId,
		setFocusedProjectId,
		sidebarSessions,
		refreshingProjectIds,
		refreshProjectSessions,
		chatSession,
		draftTemporary,
		renderedOpenedChats,
		draftSessionId,
		readChatUiState,
		writeChatUiState,
		readProjectDraft,
		writeProjectDraft,
		handleProjectsRemoved,
		startLandingSession,
		startNewChat,
		startTemporaryChat,
		switchDraftProject,
		selectSession,
		openSearchSession,
		updateSession,
		deleteSession,
		handleSessionIdentified,
		handleForkSessionCreated,
	};
}

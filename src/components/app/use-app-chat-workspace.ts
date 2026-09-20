import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type Dispatch,
	type SetStateAction,
} from "react";
import { toast } from "sonner";

import {
	chatUiStateKey,
	createDraftSessionId,
	createTemporarySessionId,
	identifyOpenedChat,
	indexedChatSession,
	mergeSidebarSessionsWithOpenChats,
	syncOpenedChatSessionMetadata,
	touchOpenedChat,
	trimOpenedChats,
	upsertOpenedChat,
	type OpenChat,
} from "@/components/app/app-chat-state";
import {
	createChatUiStateCache,
	type ChatUiStateCache,
	type ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import { useAppSessionIndex } from "@/components/app/use-app-session-index";
import type { BusyChatControllersRef } from "@/components/app/use-opened-chat-controllers";
import type { ChatSession } from "@/components/chat/chat-page";
import { userErrorMessage } from "@/lib/app-error";
import { stopChatSession } from "@/lib/chat-session-client";
import type { ChatSubmission } from "@/lib/chat-submission";
import {
	listenForDesktopNotificationActions,
	type DesktopNotificationSessionTarget,
} from "@/lib/desktop-notifications";
import type { PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import {
	notifyProjectsChanged,
	touchProject,
	type Project,
} from "@/lib/projects";

type UseAppChatWorkspaceOptions = {
	projects: Project[];
	projectsReady: boolean;
	firstProject: Project | null;
	openedChats: OpenChat[];
	setOpenedChats: Dispatch<SetStateAction<OpenChat[]>>;
	busyChatControllersRef: BusyChatControllersRef;
	busyChatControllerIds: ReadonlySet<string>;
	preloadChatPage: () => Promise<unknown>;
};

type SearchSessionTarget = {
	sessionId: string;
	projectId: string;
	sessionPath: string;
	title: string;
};

type ForkSessionTarget = {
	sessionId: string;
	sessionPath: string;
};

export function useAppChatWorkspace({
	projects,
	projectsReady,
	firstProject,
	openedChats,
	setOpenedChats,
	busyChatControllersRef,
	busyChatControllerIds,
	preloadChatPage,
}: UseAppChatWorkspaceOptions) {
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
	const [draftSessionId, setDraftSessionId] = useState(createDraftSessionId);
	const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
	const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);

	const clearDraftSession = useCallback(() => {
		setDraftSessionStarted(false);
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
		externalOpenTurnPaths,
		refreshProjectSessions,
		refreshingProjectIds,
		sidebarSessions: indexedSidebarSessions,
		updateSession: updateIndexedSession,
		removeSession: removeIndexedSession,
	} = useAppSessionIndex(activeProjectId);

	useEffect(() => {
		setOpenedChats((current) =>
			trimOpenedChats(
				syncOpenedChatSessionMetadata(current, indexedSessions),
				busyChatControllersRef.current,
			),
		);
	}, [busyChatControllersRef, indexedSessions, setOpenedChats]);

	const sidebarSessions = useMemo(
		() =>
			mergeSidebarSessionsWithOpenChats(
				indexedSidebarSessions,
				openedChats,
				busyChatControllerIds,
			),
		[indexedSidebarSessions, openedChats, busyChatControllerIds],
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
	const selectedOpenedChatBusy = selectedOpenedChat
		? busyChatControllerIds.has(selectedOpenedChat.controllerId)
		: false;
	const selectedProject = selectedIndexedSession
		? (projects.find(
				(project) => project.id === selectedIndexedSession.projectId,
			) ?? null)
		: null;

	const chatSession = useMemo<ChatSession | null>(() => {
		if (
			selectedOpenedChat &&
			(selectedOpenedChatBusy || !selectedIndexedSession)
		) {
			const sessionPath = selectedOpenedChat.session.sessionPath;
			return {
				...selectedOpenedChat.session,
				externalRunning: sessionPath
					? externalOpenTurnPaths.has(sessionPath)
					: false,
				externalTurnOpen: sessionPath
					? externalOpenTurnPaths.has(sessionPath)
					: false,
			};
		}
		if (selectedIndexedSession && selectedProject) {
			return indexedChatSession(
				selectedIndexedSession,
				selectedProject,
				externalOpenTurnPaths.has(selectedIndexedSession.sessionPath),
				externalOpenTurnPaths.has(selectedIndexedSession.sessionPath),
			);
		}
		if (activeProject && draftSessionStarted) {
			return {
				id: draftSessionId,
				title: "新会话",
				projectRecord: activeProject,
				initialModel: draftSessionModel ?? undefined,
				initialThinkingLevel: draftSessionThinkingLevel ?? undefined,
			};
		}
		return null;
	}, [
		selectedOpenedChat,
		selectedOpenedChatBusy,
		selectedIndexedSession,
		selectedProject,
		externalOpenTurnPaths,
		activeProject,
		draftSessionStarted,
		draftSessionId,
		draftSessionModel,
		draftSessionThinkingLevel,
	]);

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
			const nextChat: ChatSession = {
				id: draftSessionId,
				title: "新会话",
				projectRecord: project,
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
		[busyChatControllersRef, draftSessionId, setOpenedChats],
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
				toast.info("请先新增项目");
				return;
			}
			startDraftSession(activeProject, submission, model, thinkingLevel);
		},
		[activeProject, projectsReady, startDraftSession],
	);

	/* oxlint-disable react/set-state-in-effect -- Replaying a landing submission is intentionally triggered when the asynchronous project catalog becomes ready. */
	useEffect(() => {
		if (!projectsReady) return;
		const pending = pendingLandingSubmissionRef.current;
		if (!pending) return;
		pendingLandingSubmissionRef.current = null;
		if (!activeProject) {
			toast.info("请先新增项目");
			return;
		}
		startDraftSession(
			activeProject,
			pending.submission,
			pending.model,
			pending.thinkingLevel,
		);
	}, [activeProject, projectsReady, startDraftSession]);
	/* oxlint-enable react/set-state-in-effect */

	useEffect(() => {
		if (chatSession || !activeProject) return;
		void preloadChatPage().catch(() => undefined);
	}, [activeProject, chatSession, preloadChatPage]);

	const startNewChat = useCallback(
		(projectId?: string) => {
			const targetProjectId = projectId ?? focusedProject?.id ?? null;
			setOpenedChats((current) =>
				current.filter((entry) => !entry.session.temporary),
			);
			clearDraftSession();
			setDraftSessionId(createDraftSessionId());
			setDraftProjectId(targetProjectId);
			setFocusedProjectId(targetProjectId);
			setSelectedSessionId(null);
			if (targetProjectId) {
				void touchProject(targetProjectId)
					.then(() => notifyProjectsChanged())
					.catch((error) =>
						console.error("Failed to update recent project", error),
					);
			}
		},
		[clearDraftSession, focusedProject?.id, setOpenedChats],
	);

	const startTemporaryChat = useCallback(
		(projectId?: string) => {
			const project =
				projects.find((candidate) => candidate.id === projectId) ??
				activeProject;
			if (!project) {
				toast.info("请先新增项目");
				return;
			}
			const sessionId = createTemporarySessionId();
			const session: ChatSession = {
				id: sessionId,
				title: "临时会话",
				projectRecord: project,
				temporary: true,
			};
			setOpenedChats((current) =>
				trimOpenedChats(
					touchOpenedChat(
						current.filter((entry) => !entry.session.temporary),
						session,
					),
					busyChatControllersRef.current,
				),
			);
			clearDraftSession();
			setDraftProjectId(project.id);
			setSelectedSessionId(sessionId);
		},
		[
			activeProject,
			busyChatControllersRef,
			clearDraftSession,
			projects,
			setOpenedChats,
		],
	);

	const selectSession = useCallback(
		(sessionId: string) => {
			setOpenedChats((current) =>
				current.filter(
					(entry) =>
						!entry.session.temporary ||
						entry.session.id === sessionId ||
						entry.piSessionId === sessionId,
				),
			);
			const opened = openedChats.find(
				(entry) =>
					entry.session.id === sessionId || entry.piSessionId === sessionId,
			);
			const session = indexedSessions.find(
				(candidate) => candidate.piSessionId === sessionId,
			);
			const openedIsBusy = opened
				? busyChatControllersRef.current.has(opened.controllerId)
				: false;
			if (opened && (openedIsBusy || !session)) {
				const projectId = opened.session.projectRecord.id;
				setOpenedChats((current) =>
					trimOpenedChats(
						touchOpenedChat(current, opened.session, opened.initialMessage),
						busyChatControllersRef.current,
					),
				);
				setSelectedSessionId(sessionId);
				clearDraftSession();
				setDraftProjectId(projectId);
				setFocusedProjectId(projectId);
				void touchProject(projectId)
					.then(() => notifyProjectsChanged())
					.catch((error) =>
						console.error("Failed to update recent project", error),
					);
				return;
			}
			if (!session) return;
			const project = projects.find(
				(candidate) => candidate.id === session.projectId,
			);
			if (project) {
				const nextChat = indexedChatSession(session, project);
				setOpenedChats((current) =>
					trimOpenedChats(
						touchOpenedChat(current, nextChat),
						busyChatControllersRef.current,
					),
				);
			}
			setSelectedSessionId(sessionId);
			clearDraftSession();
			setDraftProjectId(session.projectId);
			setFocusedProjectId(session.projectId);
			void touchProject(session.projectId)
				.then(() => notifyProjectsChanged())
				.catch((error) =>
					console.error("Failed to update recent project", error),
				);
		},
		[
			busyChatControllersRef,
			clearDraftSession,
			indexedSessions,
			openedChats,
			projects,
			setOpenedChats,
		],
	);

	const openSearchSession = useCallback(
		(target: SearchSessionTarget) => {
			const project = projects.find(
				(candidate) => candidate.id === target.projectId,
			);
			if (!project) return;
			const session: ChatSession = {
				id: target.sessionId,
				title: target.title || "新会话",
				projectRecord: project,
				sessionPath: target.sessionPath,
			};
			setOpenedChats((current) =>
				trimOpenedChats(
					touchOpenedChat(current, session),
					busyChatControllersRef.current,
				),
			);
			setSelectedSessionId(target.sessionId);
			clearDraftSession();
			setDraftProjectId(target.projectId);
			setFocusedProjectId(target.projectId);
			void refreshProjectSessions(target.projectId).catch((error) =>
				console.error("Failed to refresh searched session project", error),
			);
			void touchProject(target.projectId)
				.then(() => notifyProjectsChanged())
				.catch((error) =>
					console.error("Failed to update recent project", error),
				);
		},
		[
			busyChatControllersRef,
			clearDraftSession,
			projects,
			refreshProjectSessions,
			setOpenedChats,
		],
	);

	const openNotificationSession = useCallback(
		(target: DesktopNotificationSessionTarget) => {
			setOpenedChats((current) =>
				current.filter(
					(entry) =>
						!entry.session.temporary ||
						entry.session.id === target.sessionId ||
						entry.piSessionId === target.sessionId,
				),
			);
			const opened = openedChats.find(
				(entry) =>
					entry.session.projectRecord.id === target.projectId &&
					(entry.session.id === target.sessionId ||
						entry.piSessionId === target.sessionId),
			);
			if (opened) {
				setOpenedChats((current) =>
					trimOpenedChats(
						touchOpenedChat(current, opened.session, opened.initialMessage),
						busyChatControllersRef.current,
					),
				);
			}
			setDraftProjectId(target.projectId);
			setFocusedProjectId(target.projectId);
			setSelectedSessionId(target.sessionId);
			clearDraftSession();
			void touchProject(target.projectId)
				.then(() => notifyProjectsChanged())
				.catch((error) =>
					console.error("Failed to update recent project", error),
				);
		},
		[busyChatControllersRef, clearDraftSession, openedChats, setOpenedChats],
	);

	useEffect(() => {
		let disposed = false;
		let unlisten: (() => void) | undefined;
		void listenForDesktopNotificationActions(openNotificationSession)
			.then((cleanup) => {
				if (disposed) cleanup();
				else unlisten = cleanup;
			})
			.catch((error) =>
				console.warn("Failed to listen for notification actions", error),
			);
		return () => {
			disposed = true;
			unlisten?.();
		};
	}, [openNotificationSession]);

	const updateSession = useCallback(
		async (sessionId: string, update: { title?: string }) => {
			await updateIndexedSession(sessionId, update);
		},
		[updateIndexedSession],
	);

	const deleteSession = useCallback(
		async (sessionId: string) => {
			const session = indexedSessions.find(
				(candidate) => candidate.piSessionId === sessionId,
			);
			if (!session) return;
			try {
				await stopChatSession(session.projectId, sessionId, "session_delete");
				const deleted = await removeIndexedSession(sessionId);
				if (!deleted) return;
				setOpenedChats((current) =>
					current.filter(
						(entry) =>
							entry.session.id !== sessionId && entry.piSessionId !== sessionId,
					),
				);
				setSelectedSessionId((current) =>
					current === sessionId ? null : current,
				);
				toast.success(
					deleted.result.method === "trash" ? "会话已移到回收站" : "会话已删除",
				);
			} catch (error) {
				toast.error("删除会话失败", { description: userErrorMessage(error) });
			}
		},
		[indexedSessions, removeIndexedSession, setOpenedChats],
	);

	const handleSessionIdentified = useCallback(
		(entry: OpenChat, piSessionId: string) => {
			const nextUiStateKey = chatUiStateKey(
				entry.session.projectRecord.id,
				piSessionId,
			);
			chatUiStateCacheRef.current!.rekey(entry.uiStateKey, nextUiStateKey);
			setOpenedChats((current) =>
				identifyOpenedChat(current, entry.controllerId, piSessionId),
			);
			if (entry.session.id === draftSessionId) {
				setDraftSessionPrompt(null);
				setDraftSessionImages([]);
			}
			setSelectedSessionId((current) =>
				current === entry.session.id || current === entry.piSessionId
					? piSessionId
					: current,
			);
		},
		[draftSessionId, setOpenedChats],
	);

	const handleForkSessionCreated = useCallback(
		(entry: OpenChat, { sessionId, sessionPath }: ForkSessionTarget) => {
			const project = entry.session.projectRecord;
			const forkedSession: ChatSession = {
				id: sessionId,
				title: entry.session.title || "新会话",
				projectRecord: project,
				sessionPath,
			};
			setOpenedChats((current) =>
				trimOpenedChats(
					touchOpenedChat(current, forkedSession),
					busyChatControllersRef.current,
				),
			);
			setSelectedSessionId(sessionId);
			clearDraftSession();
			setDraftProjectId(project.id);
			setFocusedProjectId(project.id);
			void refreshProjectSessions(project.id, true).catch((error) =>
				console.error("Failed to index forked session", error),
			);
		},
		[
			busyChatControllersRef,
			clearDraftSession,
			refreshProjectSessions,
			setOpenedChats,
		],
	);

	return {
		activeProject,
		activeProjectId,
		selectedSessionId,
		setFocusedProjectId,
		sidebarSessions,
		refreshingProjectIds,
		refreshProjectSessions,
		chatSession,
		renderedOpenedChats,
		draftSessionId,
		readChatUiState,
		writeChatUiState,
		handleProjectsRemoved,
		startLandingSession,
		startNewChat,
		startTemporaryChat,
		selectSession,
		openSearchSession,
		updateSession,
		deleteSession,
		handleSessionIdentified,
		handleForkSessionCreated,
	};
}

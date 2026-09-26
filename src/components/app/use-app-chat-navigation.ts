import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
	chatUiStateKey,
	createDraftSessionId,
	createTemporarySessionId,
	identifyOpenedChat,
	indexedChatSession,
	touchOpenedChat,
	trimOpenedChats,
	type OpenChat,
} from "@/components/app/app-chat-state";
import type { BusyChatControllersRef } from "@/components/app/use-opened-chat-controllers";
import type { ChatSession } from "@/components/chat/chat-page";
import type { ChatSessionRuntimeState } from "@/lib/chat-session-client";
import {
	findReusableChatRuntime,
	runtimeSessionIdFromKey,
} from "@/lib/chat-session-runtime-model";
import {
	listenForDesktopNotificationActions,
	type DesktopNotificationSessionTarget,
} from "@/lib/desktop-notifications";
import {
	notifyProjectsChanged,
	touchProject,
	type Project,
} from "@/lib/projects";
import type { SessionIndexEntry } from "@/lib/sessions";

type SearchSessionTarget = {
	sessionId: string;
	projectId: string;
	sessionPath: string;
	title: string;
};

type UseAppChatNavigationOptions = {
	projects: Project[];
	activeProject: Project | null;
	focusedProject: Project | null;
	openedChats: OpenChat[];
	indexedSessions: SessionIndexEntry[];
	runtimeStates: ChatSessionRuntimeState[];
	busyChatControllersRef: BusyChatControllersRef;
	setOpenedChats: Dispatch<SetStateAction<OpenChat[]>>;
	clearDraftSession: () => void;
	setDraftSessionId: Dispatch<SetStateAction<string>>;
	setDraftTemporary: Dispatch<SetStateAction<boolean>>;
	setDraftProjectId: Dispatch<SetStateAction<string | null>>;
	setFocusedProjectId: Dispatch<SetStateAction<string | null>>;
	setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
	refreshProjectSessions: (
		projectId: string,
		showProgress?: boolean,
	) => Promise<void>;
};

export function useAppChatNavigation({
	projects,
	activeProject,
	focusedProject,
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
}: UseAppChatNavigationOptions) {
	const { t } = useTranslation();

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
		[
			clearDraftSession,
			focusedProject?.id,
			setDraftProjectId,
			setDraftSessionId,
			setFocusedProjectId,
			setOpenedChats,
			setSelectedSessionId,
		],
	);

	const startTemporaryChat = useCallback(
		(projectId?: string) => {
			const project =
				projects.find((candidate) => candidate.id === projectId) ??
				activeProject;
			if (!project) {
				toast.info(t("app.addProjectFirst"));
				return;
			}
			setOpenedChats((current) =>
				current.filter((entry) => !entry.session.temporary),
			);
			clearDraftSession();
			setDraftSessionId(createTemporarySessionId());
			setDraftProjectId(project.id);
			setFocusedProjectId(project.id);
			setSelectedSessionId(null);
			setDraftTemporary(true);
		},
		[
			activeProject,
			clearDraftSession,
			projects,
			setDraftProjectId,
			setDraftSessionId,
			setDraftTemporary,
			setFocusedProjectId,
			setOpenedChats,
			setSelectedSessionId,
			t,
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
			const runtimeState = session
				? findReusableChatRuntime(
						runtimeStates,
						session.projectId,
						session.sessionPath,
					)
				: null;
			const openedIsBusy = opened
				? busyChatControllersRef.current.has(opened.controllerId) ||
					Boolean(runtimeState)
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
				const indexedChat = indexedChatSession(session, project);
				const runtimeSessionId = runtimeState
					? runtimeSessionIdFromKey(runtimeState.sessionKey, session.projectId)
					: null;
				if (runtimeSessionId) {
					const runtimeChat = { ...indexedChat, id: runtimeSessionId };
					const controllerId = chatUiStateKey(project.id, runtimeSessionId);
					setOpenedChats((current) => {
						const touched = trimOpenedChats(
							touchOpenedChat(current, runtimeChat),
							busyChatControllersRef.current,
						);
						return identifyOpenedChat(
							touched,
							controllerId,
							session.piSessionId,
						);
					});
				} else {
					setOpenedChats((current) =>
						trimOpenedChats(
							touchOpenedChat(current, indexedChat),
							busyChatControllersRef.current,
						),
					);
				}
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
			runtimeStates,
			setDraftProjectId,
			setFocusedProjectId,
			setOpenedChats,
			setSelectedSessionId,
		],
	);

	const switchDraftProject = useCallback(
		(projectId: string) => {
			if (!projects.some((project) => project.id === projectId)) return;
			setDraftProjectId(projectId);
			setFocusedProjectId(projectId);
			void touchProject(projectId)
				.then(() => notifyProjectsChanged())
				.catch((error) =>
					console.error("Failed to update recent project", error),
				);
		},
		[projects, setDraftProjectId, setFocusedProjectId],
	);

	const openSearchSession = useCallback(
		(target: SearchSessionTarget) => {
			const project = projects.find(
				(candidate) => candidate.id === target.projectId,
			);
			if (!project) return;
			const session: ChatSession = {
				id: target.sessionId,
				title: target.title || t("app.newChat"),
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
			setDraftProjectId,
			setFocusedProjectId,
			setOpenedChats,
			setSelectedSessionId,
			t,
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
		[
			busyChatControllersRef,
			clearDraftSession,
			openedChats,
			setDraftProjectId,
			setFocusedProjectId,
			setOpenedChats,
			setSelectedSessionId,
		],
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

	return {
		startNewChat,
		startTemporaryChat,
		selectSession,
		switchDraftProject,
		openSearchSession,
	};
}

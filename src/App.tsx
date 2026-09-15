import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	Group,
	Panel,
	Separator as ResizeSeparator,
	type PanelImperativeHandle,
} from "react-resizable-panels";
import { toast } from "sonner";

import {
	createChatUiStateCache,
	type ChatUiStateCache,
	type ChatUiStatePatch,
} from "@/components/app/chat-ui-state-cache";
import { AppSidebar } from "@/components/sidebar/app-sidebar";
import { AddProjectDialog } from "@/components/sidebar/add-project-dialog";
import {
	chatUiStateKey,
	createDraftSessionId,
	createTemporarySessionId,
	firstProjectInConnectionOrder,
	identifyOpenedChat,
	indexedChatSession,
	mergeSidebarSessionsWithOpenChats,
	projectRelativePath,
	syncOpenedChatSessionMetadata,
	touchOpenedChat,
	trimOpenedChats,
	upsertOpenedChat,
	type OpenChat,
} from "@/components/app/app-chat-state";
import { useAppSessionIndex } from "@/components/app/use-app-session-index";
import { ChatPageLoadingFallback } from "@/components/chat/chat-page-loading-fallback";
import type { ChatSession } from "@/components/chat/chat-page";
import { NewChatLanding } from "@/components/new-chat-landing";
import { SidebarFooter } from "@/components/sidebar-footer";
import { CUSTOM_TITLEBAR, IS_MACOS, TitleBar } from "@/components/title-bar";
import type { EditorOpenRequest } from "@/components/project-editor";
import {
	createChatSessionClient,
	listChatSessionRuntimeStates,
	stopChatSession,
} from "@/lib/chat-session-client";
import type {
	ChatImageAttachment,
	ChatSubmission,
} from "@/lib/chat-submission";
import { userErrorMessage } from "@/lib/app-error";
import { listSessions } from "@/lib/sessions";
import { CONNECTIONS_CHANGED_EVENT } from "@/lib/connection-events";
import { listConnectionCatalog, removeWslConnection } from "@/lib/connections";
import {
	listenForDesktopNotificationActions,
	type DesktopNotificationSessionTarget,
} from "@/lib/desktop-notifications";
import {
	HOME_CONNECTIONS_CHANGED_EVENT,
	listHomeConnectionIds,
	setConnectionShownInHome,
} from "@/lib/home-connections";
import {
	getCachedProjectPiModels,
	hydrateProjectPiModels,
	isProjectPiModelsStale,
	refreshAllProjectPiModels,
	refreshProjectPiModels,
} from "@/lib/pi-models";
import { usePreferences } from "@/lib/preferences-provider";
import type { Connection, PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import {
	addProject,
	connectionLabel,
	listProjects,
	notifyProjectsChanged,
	pickLocalProjectDirectory,
	removeProject,
	reorderProjects,
	touchProject,
	PROJECTS_CHANGED_EVENT,
	type Project,
} from "@/lib/projects";
import { removeSshConnection } from "@/lib/ssh-connections";
import { useKeyboardShortcut } from "@/lib/use-keyboard-shortcut";
import { TooltipProvider } from "@/ui";

const importChatPage = () => import("@/components/chat/chat-page");
const ChatPage = lazy(() =>
	importChatPage().then((module) => ({
		default: module.ChatPage,
	})),
);
const ProjectEditor = lazy(() =>
	import("@/components/project-editor").then((module) => ({
		default: module.ProjectEditor,
	})),
);
const RightSidebar = lazy(() =>
	import("@/components/right-sidebar").then((module) => ({
		default: module.RightSidebar,
	})),
);
const TerminalDock = lazy(() =>
	import("@/components/terminal-dock").then((module) => ({
		default: module.TerminalDock,
	})),
);

// Keep the existing right-sidebar implementation available for future work,
// but do not render or reserve layout space for it for now.
const RIGHT_SIDEBAR_ENABLED = false;

let editorRequestSequence = 0;

function App() {
	const { keyboardShortcuts } = usePreferences();
	const rightPanelRef = useRef<PanelImperativeHandle>(null);
	const [leftSidebarCollapsed, setLeftSidebarCollapsed] = useState(false);
	const [isResizing, setIsResizing] = useState(false);
	const [projects, setProjects] = useState<Project[]>([]);
	const [projectsReady, setProjectsReady] = useState(false);
	const [openedChats, setOpenedChats] = useState<OpenChat[]>([]);
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
	const previousOpenedChatsRef = useRef(new Map<string, OpenChat>());
	const landingPrewarmRef = useRef<{
		projectId: string;
		sessionId: string;
		client: ReturnType<typeof createChatSessionClient>;
	} | null>(null);
	const busyChatControllersRef = useRef(new Set<string>());
	const restoredRuntimeSessionKeysRef = useRef(new Set<string>());
	const [busyChatControllerIds, setBusyChatControllerIds] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const handleChatRuntimeBusyChange = useCallback(
		(controllerId: string, busy: boolean) => {
			const busyControllers = busyChatControllersRef.current;
			const changed = busy
				? !busyControllers.has(controllerId)
				: busyControllers.has(controllerId);
			if (busy) busyControllers.add(controllerId);
			else busyControllers.delete(controllerId);
			if (changed) setBusyChatControllerIds(new Set(busyControllers));
			if (!busy) {
				setOpenedChats((current) => trimOpenedChats(current, busyControllers));
			}
		},
		[],
	);
	const [draftSessionPrompt, setDraftSessionPrompt] = useState<string | null>(
		null,
	);
	const [draftSessionImages, setDraftSessionImages] = useState<
		ChatImageAttachment[]
	>([]);
	const [draftSessionModel, setDraftSessionModel] = useState<PiModel | null>(
		null,
	);
	const [draftSessionThinkingLevel, setDraftSessionThinkingLevel] =
		useState<PiThinkingLevel | null>(null);
	const pendingLandingSubmissionRef = useRef<{
		submission: ChatSubmission;
		model: PiModel | null;
		thinkingLevel: PiThinkingLevel | null;
	} | null>(null);
	const [draftSessionStarted, setDraftSessionStarted] = useState(false);
	const [draftSessionId, setDraftSessionId] = useState(createDraftSessionId);
	const [draftProjectId, setDraftProjectId] = useState<string | null>(null);
	const [focusedProjectId, setFocusedProjectId] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);
	const [addProjectOpen, setAddProjectOpen] = useState(false);
	const [addProjectConnectionId, setAddProjectConnectionId] = useState<
		string | null
	>(null);
	const localProjectPickerPendingRef = useRef(false);
	const [editorRequest, setEditorRequest] = useState<EditorOpenRequest | null>(
		null,
	);
	const [editorVisible, setEditorVisible] = useState(false);
	const [terminalOpenRequest, setTerminalOpenRequest] = useState(0);
	const [terminalMounted, setTerminalMounted] = useState(false);
	const [terminalVisible, setTerminalVisible] = useState(false);
	const [terminalRunning, setTerminalRunning] = useState(false);

	useEffect(() => {
		const next = new Map(
			openedChats.map((entry) => [entry.controllerId, entry] as const),
		);
		let busyChanged = false;
		for (const [controllerId, entry] of previousOpenedChatsRef.current) {
			if (next.has(controllerId)) continue;
			busyChanged =
				busyChatControllersRef.current.delete(controllerId) || busyChanged;
			void stopChatSession(
				entry.session.projectRecord.id,
				entry.session.id,
			).catch((error) =>
				console.warn("Failed to stop evicted chat session", error),
			);
		}
		if (busyChanged) {
			setBusyChatControllerIds(new Set(busyChatControllersRef.current));
		}
		previousOpenedChatsRef.current = next;
	}, [openedChats]);

	useEffect(() => {
		void hydrateProjectPiModels().catch((error) => {
			console.warn("Failed to hydrate Pi model cache", error);
		});
	}, []);

	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const next = await listProjects();
				if (active) {
					setProjects(next);
					setOpenedChats((current) =>
						current.filter((entry) =>
							next.some(
								(project) => project.id === entry.session.projectRecord.id,
							),
						),
					);
				}
			} catch (error) {
				console.error("Failed to load projects", error);
			} finally {
				if (active) setProjectsReady(true);
			}
		};
		void load();
		const handleChanged = () => void load();
		window.addEventListener(PROJECTS_CHANGED_EVENT, handleChanged);
		window.addEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		return () => {
			active = false;
			window.removeEventListener(PROJECTS_CHANGED_EVENT, handleChanged);
			window.removeEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		};
	}, []);

	useEffect(() => {
		if (!projectsReady || projects.length === 0) return;
		let disposed = false;
		void listChatSessionRuntimeStates()
			.then(async (states) => {
				const active = states.filter(
					(state) => state.activeTurn && state.snapshot.state === "running",
				);
				if (active.length === 0) return;
				const projectIds = [...new Set(active.map((state) => state.projectId))];
				const indexedByProject = new Map<
					string,
					Awaited<ReturnType<typeof listSessions>>
				>();
				await Promise.all(
					projectIds.map(async (projectId) => {
						try {
							indexedByProject.set(projectId, await listSessions(projectId));
						} catch {
							indexedByProject.set(projectId, []);
						}
					}),
				);
				if (disposed) return;
				const restored = active.flatMap((state) => {
					if (restoredRuntimeSessionKeysRef.current.has(state.sessionKey)) {
						return [];
					}
					let parsed: unknown;
					try {
						parsed = JSON.parse(state.sessionKey);
					} catch {
						return [];
					}
					if (
						!Array.isArray(parsed) ||
						parsed.length !== 2 ||
						typeof parsed[0] !== "string" ||
						parsed[0] !== state.projectId ||
						typeof parsed[1] !== "string"
					) {
						return [];
					}
					const project = projects.find(
						(candidate) => candidate.id === state.projectId,
					);
					if (!project) return [];
					const indexed = state.sessionPath
						? indexedByProject
								.get(state.projectId)
								?.find((session) => session.sessionPath === state.sessionPath)
						: undefined;
					const sessionId = parsed[1];
					const session: ChatSession = {
						id: sessionId,
						title:
							indexed?.titleOverride ??
							indexed?.name ??
							indexed?.firstUserMessagePreview ??
							"正在进行的对话",
						projectRecord: project,
						sessionPath: state.sessionPath ?? undefined,
					};
					return [{ sessionKey: state.sessionKey, session }];
				});
				if (restored.length === 0) return;
				setOpenedChats((current) => {
					let next = current;
					for (const entry of restored) {
						next = upsertOpenedChat(next, entry.session);
					}
					// Do not trim here: these entries represent live Pi turns and have not
					// mounted their ChatPage controllers yet, so the frontend busy set is
					// intentionally one render behind the backend registry.
					return next;
				});
				for (const entry of restored) {
					restoredRuntimeSessionKeysRef.current.add(entry.sessionKey);
				}
			})
			.catch((error) =>
				console.warn("Failed to restore active chat runtimes", error),
			);
		return () => {
			disposed = true;
		};
	}, [projects, projectsReady]);

	// 首页环境列表只遵循用户的「显示在首页」偏好，和项目关联数量无关。
	const [connectionCatalog, setConnectionCatalog] = useState<Connection[]>([]);
	const [connectionsReady, setConnectionsReady] = useState(false);
	useEffect(() => {
		let active = true;
		const load = async () => {
			try {
				const next = await listConnectionCatalog();
				if (active) setConnectionCatalog(next);
			} catch (error) {
				console.error("Failed to load connections", error);
			} finally {
				if (active) setConnectionsReady(true);
			}
		};
		void load();
		const handleChanged = () => void load();
		window.addEventListener(HOME_CONNECTIONS_CHANGED_EVENT, handleChanged);
		window.addEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		return () => {
			active = false;
			window.removeEventListener(HOME_CONNECTIONS_CHANGED_EVENT, handleChanged);
			window.removeEventListener(CONNECTIONS_CHANGED_EVENT, handleChanged);
		};
	}, []);

	useEffect(() => {
		if (projects.length === 0) return;
		const timer = window.setTimeout(() => {
			void hydrateProjectPiModels()
				.then(() => {
					const staleProjectIds = projects
						.filter((project) => {
							const cached = getCachedProjectPiModels(project.id);
							return !cached || isProjectPiModelsStale(cached);
						})
						.map((project) => project.id);
					if (staleProjectIds.length > 0) {
						void refreshAllProjectPiModels(staleProjectIds);
					}
				})
				.catch((error) =>
					console.warn("Failed to schedule Pi model refresh", error),
				);
		}, 15_000);
		return () => window.clearTimeout(timer);
	}, [projects]);

	useEffect(() => {
		if (projects.length === 0) return;
		const timer = window.setInterval(
			() => {
				void refreshAllProjectPiModels(projects.map((project) => project.id));
			},
			60 * 60 * 1000,
		);
		return () => window.clearInterval(timer);
	}, [projects]);

	const envs = useMemo(() => {
		const shown = listHomeConnectionIds();
		const byId = new Map<string, { id: string; name: string }>();
		for (const connection of connectionCatalog) {
			if (!shown.has(connection.id)) continue;
			byId.set(connection.id, {
				id: connection.id,
				name: connectionLabel(connection),
			});
		}
		const list = [...byId.values()];
		// Local 仅在显示时置顶；其余保持稳定的插入顺序。
		list.sort((a, b) => (a.id === "local" ? -1 : b.id === "local" ? 1 : 0));
		return list;
	}, [connectionCatalog]);

	const sidebarProjects = useMemo(
		() =>
			projects.map((project) => ({
				id: project.id,
				name: project.name,
				path: project.metadata.cwd,
				envId: project.connection.id,
			})),
		[projects],
	);

	const firstProject = useMemo(
		() =>
			connectionsReady
				? firstProjectInConnectionOrder(
						projects,
						envs.map((env) => env.id),
					)
				: null,
		[connectionsReady, envs, projects],
	);
	const activeProject =
		projects.find((project) => project.id === draftProjectId) ?? firstProject;
	const focusedProject =
		projects.find((project) => project.id === focusedProjectId) ??
		activeProject;
	const activeProjectId = activeProject?.id ?? null;
	const toggleTerminal = useCallback(() => {
		if (terminalVisible) {
			setTerminalVisible(false);
			return;
		}
		if (!activeProject) {
			toast.info("请先新增项目");
			return;
		}
		setTerminalMounted(true);
		setTerminalVisible(true);
		setTerminalOpenRequest((request) => request + 1);
	}, [activeProject, terminalVisible]);
	const destroyTerminalDock = useCallback(() => {
		setTerminalVisible(false);
		setTerminalMounted(false);
		setTerminalRunning(false);
	}, []);
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
	}, [indexedSessions]);
	const sidebarSessions = useMemo(
		() =>
			mergeSidebarSessionsWithOpenChats(
				indexedSidebarSessions,
				openedChats,
				busyChatControllerIds,
			),
		[indexedSidebarSessions, openedChats, busyChatControllerIds],
	);
	const openEditorFile = useCallback(
		(candidate: string) => {
			if (!activeProject) return;
			const path = projectRelativePath(activeProject, candidate);
			if (!path) return;
			editorRequestSequence += 1;
			setEditorRequest({
				id: editorRequestSequence,
				projectId: activeProject.id,
				path,
			});
			setEditorVisible(true);
		},
		[activeProject],
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
				title: "新对话",
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
				title: "新对话",
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
		[draftSessionId],
	);

	// 刷新后的首个项目读取是异步的，但 Landing 不应该因此禁用输入框。
	// 如果用户恰好在项目列表返回前发送，先记住这次提交，项目就绪后立即继续。
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

	// 新对话停留在 Landing 时就把 Pi 冷启动完成；这里只 prepare，不创建空 Session。
	// 用 ref 做幂等切换，避免 React StrictMode 的 effect cleanup 把刚预热好的 Pi 杀掉。
	useEffect(() => {
		const current = landingPrewarmRef.current;
		const prewarmWasClaimedByChat =
			current !== null &&
			openedChats.some(
				(entry) =>
					entry.session.projectRecord.id === current.projectId &&
					entry.session.id === current.sessionId,
			);
		if (prewarmWasClaimedByChat) {
			// ChatPage uses the same backend session key. Transfer ownership without
			// stopping the already-warm Pi process when indexing replaces chatSession.
			landingPrewarmRef.current = null;
			return;
		}
		const keepForDraftChat = chatSession?.id === draftSessionId;
		if (!activeProjectId || (chatSession && !keepForDraftChat)) {
			if (current) {
				landingPrewarmRef.current = null;
				void current.client.stop().catch(() => undefined);
			}
			return;
		}
		if (
			current?.projectId === activeProjectId &&
			current.sessionId === draftSessionId
		) {
			return;
		}
		if (current) void current.client.stop().catch(() => undefined);
		const client = createChatSessionClient(activeProjectId, draftSessionId);
		landingPrewarmRef.current = {
			projectId: activeProjectId,
			sessionId: draftSessionId,
			client,
		};
		void client.prepare().catch((error) => {
			if (landingPrewarmRef.current?.client === client) {
				console.warn("Failed to prewarm Pi runtime", error);
			}
		});
	}, [activeProjectId, chatSession, draftSessionId, openedChats]);

	// 落地页提交第一条消息后会立即切到 lazy ChatPage。项目可用后就预热该 chunk，
	// 避免它与真正的发送动作竞争，同时不让无项目的首屏承担这部分加载成本。
	useEffect(() => {
		if (chatSession || !activeProject) return;
		void importChatPage().catch(() => undefined);
	}, [activeProject, chatSession]);

	const startNewChat = useCallback(
		(projectId?: string) => {
			const targetProjectId = projectId ?? focusedProject?.id ?? null;
			setOpenedChats((current) =>
				current.filter((entry) => !entry.session.temporary),
			);
			setDraftSessionStarted(false);
			setDraftSessionPrompt(null);
			setDraftSessionImages([]);
			setDraftSessionModel(null);
			setDraftSessionThinkingLevel(null);
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
		[focusedProject?.id],
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
			setDraftSessionStarted(false);
			setDraftSessionPrompt(null);
			setDraftSessionImages([]);
			setDraftSessionModel(null);
			setDraftSessionThinkingLevel(null);
			setDraftProjectId(project.id);
			setSelectedSessionId(sessionId);
		},
		[activeProject, projects],
	);

	useKeyboardShortcut(keyboardShortcuts["new-chat"], () => startNewChat());
	useKeyboardShortcut(keyboardShortcuts["toggle-sidebar"], () => {
		setLeftSidebarCollapsed((collapsed) => !collapsed);
	});

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
				setDraftSessionStarted(false);
				setDraftSessionPrompt(null);
				setDraftSessionImages([]);
				setDraftSessionModel(null);
				setDraftSessionThinkingLevel(null);
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
			setDraftSessionStarted(false);
			setDraftSessionPrompt(null);
			setDraftSessionImages([]);
			setDraftSessionModel(null);
			setDraftSessionThinkingLevel(null);
			setDraftProjectId(session.projectId);
			setFocusedProjectId(session.projectId);
			void touchProject(session.projectId)
				.then(() => notifyProjectsChanged())
				.catch((error) =>
					console.error("Failed to update recent project", error),
				);
		},
		[indexedSessions, openedChats, projects],
	);

	const openSearchSession = useCallback(
		(target: {
			sessionId: string;
			projectId: string;
			sessionPath: string;
			title: string;
		}) => {
			const project = projects.find(
				(candidate) => candidate.id === target.projectId,
			);
			if (!project) return;
			const session: ChatSession = {
				id: target.sessionId,
				title: target.title || "新对话",
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
			setDraftSessionStarted(false);
			setDraftSessionPrompt(null);
			setDraftSessionImages([]);
			setDraftSessionModel(null);
			setDraftSessionThinkingLevel(null);
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
		[projects, refreshProjectSessions],
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
			setDraftSessionStarted(false);
			setDraftSessionPrompt(null);
			setDraftSessionImages([]);
			setDraftSessionModel(null);
			setDraftSessionThinkingLevel(null);
			void touchProject(target.projectId)
				.then(() => notifyProjectsChanged())
				.catch((error) =>
					console.error("Failed to update recent project", error),
				);
		},
		[openedChats],
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

	const handleAddProject = useCallback(
		async (connectionId?: string) => {
			const connection =
				connectionCatalog.find((item) => item.id === connectionId) ??
				projects.find((project) => project.connection.id === connectionId)
					?.connection ??
				null;
			if (!connection) return;

			if (connection.kind.type !== "local") {
				setAddProjectConnectionId(connection.id);
				setAddProjectOpen(true);
				return;
			}

			if (localProjectPickerPendingRef.current) return;
			localProjectPickerPendingRef.current = true;
			try {
				const selectedPath = await pickLocalProjectDirectory();
				if (!selectedPath) return;
				const project = await addProject(connection.id, selectedPath);
				void refreshProjectPiModels(project.id).catch((error) => {
					console.warn(
						"Failed to refresh Pi models after adding project",
						error,
					);
				});
				notifyProjectsChanged();
				toast.success(`已添加 ${project.name}`, {
					description: `${project.connection.name} · ${project.metadata.cwd}`,
				});
			} catch (error) {
				toast.error("添加项目失败", { description: userErrorMessage(error) });
			} finally {
				localProjectPickerPendingRef.current = false;
			}
		},
		[connectionCatalog, projects],
	);

	const handleReorderProjects = useCallback(
		async (connectionId: string, projectIds: string[]) => {
			const previous = projects;
			const rank = new Map(projectIds.map((id, index) => [id, index]));
			setProjects((current) => {
				const reordered = current.filter(
					(project) => project.connection.id === connectionId,
				);
				reordered.sort(
					(a, b) =>
						(rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
						(rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
				);
				let index = 0;
				return current.map((project) =>
					project.connection.id === connectionId
						? (reordered[index++] ?? project)
						: project,
				);
			});
			try {
				const next = await reorderProjects(connectionId, projectIds);
				setProjects(next);
			} catch (error) {
				setProjects(previous);
				toast.error("项目排序保存失败", {
					description: userErrorMessage(error),
				});
			}
		},
		[projects],
	);

	const handleDeleteProject = useCallback(
		async (projectId: string) => {
			const project = projects.find((candidate) => candidate.id === projectId);
			if (!project) return;
			try {
				const next = await removeProject(projectId);
				setProjects(next);
				setOpenedChats((current) =>
					current.filter(
						(entry) => entry.session.projectRecord.id !== projectId,
					),
				);
				if (draftProjectId === projectId) {
					setDraftProjectId(next[0]?.id ?? null);
					setSelectedSessionId(null);
					setDraftSessionStarted(false);
					setDraftSessionPrompt(null);
					setDraftSessionImages([]);
					setDraftSessionModel(null);
					setDraftSessionThinkingLevel(null);
				}
				notifyProjectsChanged();
				toast.success(`已从 Pilo 移除 ${project.name}`, {
					description: "实际项目文件未删除",
				});
			} catch (error) {
				toast.error("删除项目记录失败", {
					description: userErrorMessage(error),
				});
			}
		},
		[draftProjectId, projects],
	);

	const handleDeleteConnection = useCallback(
		async (connectionId: string) => {
			if (connectionId === "local") return;
			const connection =
				connectionCatalog.find((candidate) => candidate.id === connectionId) ??
				projects.find((project) => project.connection.id === connectionId)
					?.connection;
			if (!connection) return;
			const affectedProjectIds = new Set(
				projects
					.filter((project) => project.connection.id === connectionId)
					.map((project) => project.id),
			);
			try {
				if (connection.kind.type === "wsl") {
					await removeWslConnection(connectionId);
				} else if (connection.kind.type === "ssh") {
					await removeSshConnection(connectionId);
				}
				const nextProjects = await listProjects();
				setConnectionShownInHome(connectionId, false);
				setProjects(nextProjects);
				setOpenedChats((current) =>
					current.filter(
						(entry) => !affectedProjectIds.has(entry.session.projectRecord.id),
					),
				);
				if (draftProjectId && affectedProjectIds.has(draftProjectId)) {
					setDraftProjectId(nextProjects[0]?.id ?? null);
					setSelectedSessionId(null);
					setDraftSessionStarted(false);
					setDraftSessionPrompt(null);
					setDraftSessionImages([]);
					setDraftSessionModel(null);
					setDraftSessionThinkingLevel(null);
				}
				notifyProjectsChanged();
				toast.success(`已从 Pilo 删除 ${connectionLabel(connection)}`, {
					description: "关联项目记录已移除，实际文件未删除",
				});
			} catch (error) {
				toast.error("删除连接记录失败", {
					description: userErrorMessage(error),
				});
			}
		},
		[connectionCatalog, draftProjectId, projects],
	);

	const updateSession = async (
		sessionId: string,
		update: { title?: string },
	) => {
		await updateIndexedSession(sessionId, update);
	};

	const deleteSession = async (sessionId: string) => {
		const session = indexedSessions.find(
			(candidate) => candidate.piSessionId === sessionId,
		);
		if (!session) return;
		try {
			await stopChatSession(session.projectId, sessionId);
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
	};

	return (
		<TooltipProvider>
			<div className="flex h-full bg-background text-foreground">
				<AppSidebar
					collapsed={leftSidebarCollapsed}
					onCollapse={() => setLeftSidebarCollapsed(true)}
					envs={envs}
					projects={sidebarProjects}
					sessions={sidebarSessions}
					selectedProjectId={activeProjectId}
					selectedSessionId={selectedSessionId}
					onSelectSession={selectSession}
					onOpenSearchSession={openSearchSession}
					onUpdateSession={(sessionId, update) => {
						void updateSession(sessionId, update);
					}}
					onDeleteSession={(sessionId) => {
						void deleteSession(sessionId);
					}}
					onDeleteProject={(projectId) => void handleDeleteProject(projectId)}
					onDeleteConnection={(connectionId) =>
						void handleDeleteConnection(connectionId)
					}
					onNewChat={() => startNewChat()}
					onNewChatInProject={(projectId) => startNewChat(projectId)}
					onFocusProject={setFocusedProjectId}
					onReorderProjects={(connectionId, projectIds) =>
						void handleReorderProjects(connectionId, projectIds)
					}
					onAddProject={(connectionId) => void handleAddProject(connectionId)}
					onRefreshProjectSessions={(projectId) => {
						void refreshProjectSessions(projectId, true).catch((error) =>
							console.error("Failed to refresh sessions", error),
						);
					}}
					refreshingProjectIds={refreshingProjectIds}
					footer={<SidebarFooter />}
				/>
				<main className="relative flex min-w-0 flex-1 flex-col">
					{CUSTOM_TITLEBAR && <TitleBar />}
					<Group orientation="horizontal" className="min-h-0 flex-1">
						<Panel
							defaultSize={RIGHT_SIDEBAR_ENABLED ? 560 : "100"}
							minSize={400}
							className="relative min-w-0"
						>
							{renderedOpenedChats.map((entry) => {
								const visible =
									chatSession !== null &&
									entry.session.projectRecord.id ===
										chatSession.projectRecord.id &&
									(entry.session.id === chatSession.id ||
										entry.piSessionId === chatSession.id);
								return (
									<div
										key={entry.controllerId}
										className={visible ? "h-full min-h-0" : "hidden"}
									>
										<Suspense
											fallback={
												<ChatPageLoadingFallback
													session={entry.session}
													initialMessage={entry.initialMessage}
													initialImages={entry.initialImages}
													uiStateKey={entry.uiStateKey}
													readUiState={readChatUiState}
													writeUiState={writeChatUiState}
													reserveWindowControls={CUSTOM_TITLEBAR}
													sidebarCollapsed={leftSidebarCollapsed}
													onOpenTerminal={toggleTerminal}
													terminalRunning={terminalRunning}
													terminalVisible={terminalVisible}
													onNewTemporaryChat={() =>
														startTemporaryChat(entry.session.projectRecord.id)
													}
													onExpandSidebar={() => setLeftSidebarCollapsed(false)}
												/>
											}
										>
											<ChatPage
												session={entry.session}
												controllerId={entry.controllerId}
												uiStateKey={entry.uiStateKey}
												readUiState={readChatUiState}
												writeUiState={writeChatUiState}
												onRuntimeBusyChange={handleChatRuntimeBusyChange}
												active={visible}
												initialMessage={entry.initialMessage}
												initialImages={entry.initialImages}
												onSessionIdentified={(piSessionId) => {
													const nextUiStateKey = chatUiStateKey(
														entry.session.projectRecord.id,
														piSessionId,
													);
													chatUiStateCacheRef.current!.rekey(
														entry.uiStateKey,
														nextUiStateKey,
													);
													setOpenedChats((current) =>
														identifyOpenedChat(
															current,
															entry.controllerId,
															piSessionId,
														),
													);
													setSelectedSessionId((current) =>
														current === entry.session.id ||
														current === entry.piSessionId
															? piSessionId
															: current,
													);
												}}
												onForkSessionCreated={({ sessionId, sessionPath }) => {
													const project = entry.session.projectRecord;
													const forkedSession: ChatSession = {
														id: sessionId,
														title: entry.session.title || "新对话",
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
													setDraftSessionStarted(false);
													setDraftSessionPrompt(null);
													setDraftSessionImages([]);
													setDraftSessionModel(null);
													setDraftSessionThinkingLevel(null);
													setDraftProjectId(project.id);
													setFocusedProjectId(project.id);
													void refreshProjectSessions(project.id, true).catch(
														(error) =>
															console.error(
																"Failed to index forked session",
																error,
															),
													);
												}}
												onOpenChanges={
													RIGHT_SIDEBAR_ENABLED
														? () => rightPanelRef.current?.expand()
														: undefined
												}
												onOpenTerminal={toggleTerminal}
												terminalRunning={terminalRunning}
												terminalVisible={terminalVisible}
												onNewChat={() =>
													startNewChat(entry.session.projectRecord.id)
												}
												onNewTemporaryChat={() =>
													startTemporaryChat(entry.session.projectRecord.id)
												}
												onExpandSidebar={() => setLeftSidebarCollapsed(false)}
												onOpenFile={openEditorFile}
												onSessionChanged={() => {
													void refreshProjectSessions(
														entry.session.projectRecord.id,
													).catch((error) =>
														console.error("Failed to refresh sessions", error),
													);
												}}
												reserveWindowControls={CUSTOM_TITLEBAR}
												sidebarCollapsed={leftSidebarCollapsed}
											/>
										</Suspense>
									</div>
								);
							})}
							{!chatSession ? (
								<NewChatLanding
									key={`landing:${draftSessionId}`}
									sessionId={draftSessionId}
									onNewChat={() => startNewChat(activeProject?.id)}
									projectAvailable={
										projectsReady && connectionsReady
											? Boolean(activeProject)
											: true
									}
									project={activeProject}
									onOpenTerminal={toggleTerminal}
									terminalRunning={terminalRunning}
									terminalVisible={terminalVisible}
									onNewTemporaryChat={() =>
										startTemporaryChat(activeProject?.id)
									}
									onStartSession={(submission, model, thinkingLevel) => {
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
										startDraftSession(
											activeProject,
											submission,
											model,
											thinkingLevel,
										);
									}}
									onExpandSidebar={() => setLeftSidebarCollapsed(false)}
									reserveWindowControls={CUSTOM_TITLEBAR}
									sidebarCollapsed={leftSidebarCollapsed}
								/>
							) : null}
							{activeProject && editorRequest ? (
								<Suspense fallback={null}>
									<ProjectEditor
										key={`editor:${activeProject.id}`}
										project={activeProject}
										request={
											editorRequest?.projectId === activeProject.id
												? editorRequest
												: undefined
										}
										visible={
											editorVisible &&
											editorRequest?.projectId === activeProject.id
										}
										reserveTrafficLights={IS_MACOS && leftSidebarCollapsed}
										onClose={() => setEditorVisible(false)}
									/>
								</Suspense>
							) : null}
						</Panel>
						{RIGHT_SIDEBAR_ENABLED ? (
							<>
								<ResizeSeparator
									className="w-1 bg-transparent transition-colors hover:bg-sidebar-border"
									onPointerDown={() => setIsResizing(true)}
									onPointerUp={() => setIsResizing(false)}
									onPointerCancel={() => setIsResizing(false)}
								/>
								<Suspense
									fallback={
										<Panel
											defaultSize={0}
											minSize={280}
											collapsible
											collapsedSize={0}
										/>
									}
								>
									<RightSidebar
										panelRef={rightPanelRef}
										resizing={isResizing}
										project={activeProject ?? undefined}
										onOpenFile={openEditorFile}
									/>
								</Suspense>
							</>
						) : null}
					</Group>
					{terminalMounted ? (
						<Suspense fallback={null}>
							<TerminalDock
								project={activeProject ?? undefined}
								visible={terminalVisible}
								openRequest={terminalOpenRequest}
								onRunningChange={setTerminalRunning}
								onDestroy={destroyTerminalDock}
							/>
						</Suspense>
					) : null}
				</main>
			</div>
			{addProjectOpen ? (
				<AddProjectDialog
					open
					onOpenChange={setAddProjectOpen}
					connection={
						connectionCatalog.find(
							(connection) => connection.id === addProjectConnectionId,
						) ??
						projects.find(
							(project) => project.connection.id === addProjectConnectionId,
						)?.connection ??
						null
					}
				/>
			) : null}
		</TooltipProvider>
	);
}

export default App;

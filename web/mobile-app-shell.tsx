import {
	type Accessor,
	cleanup,
	computed,
	createMotion,
	effect,
	keyboardFrame,
	PanResponder,
	reduceMotion,
	safeArea,
	signal,
	Text,
	token,
	untracked,
	View,
	windowSize,
} from "nsh";

import {
	chatSessionKey as formatChatSessionKey,
	parseChatSessionKey,
} from "@shared/api/chat-session-key";
import { compactMiddlePath } from "@shared/project-path";
import { userErrorMessage } from "@shared/app-error";
import { resolveMobileComposerBottomPadding } from "@shared/mobile-viewport";
import type { WorkspaceLineRange } from "@shared/project-workspace";
import { webInputFontSize } from "@shared/web-font-scale";

import {
	AppToaster,
	AppToasts,
	AppToastStack,
	showToast,
} from "../app/shell/app-toasts";
import { followSavedAppearance } from "../app/shell/appearance";
import { CommandPalette } from "../app/shell/command-palette";
import { deleteSessionWithToast } from "../app/shell/delete-session";
import { t } from "../app/shell/i18n";
import { SessionLanding } from "../app/shell/landing";
import { openChatTarget } from "../app/shell/open-chat";
import {
	openMarkdownFileLink,
	openToolFilePath,
} from "../app/shell/open-file-link";
import type { SessionForker } from "../app/shell/session-fork";
import { CacheKeepAliveNotice } from "../app/chat/cache-keep-alive-notice";
import { ChatAgentActivityIndicator } from "../app/chat/chat-agent-activity";
import { ChatImageLightbox } from "../app/chat/chat-image-lightbox";
import {
	ChatMarkdown,
	type ChatMarkdownFileLink,
} from "../app/chat/chat-markdown";
import {
	ChatMediaActions,
	type ChatImagePreview,
} from "../app/chat/chat-media-actions";
import { ChatMessageList } from "../app/chat/chat-message-list";
import { ChatPendingQueue } from "../app/chat/chat-pending-queue";
import {
	ChatReadingFont,
	chatReadingFont,
} from "../app/chat/chat-reading-font";
import { ChatTodoCapsule } from "../app/chat/chat-todo-capsule";
import { createChatUserImageReader } from "../app/chat/chat-user-image-cache";
import {
	ConversationColumn,
	ConversationColumnLayout,
} from "../app/chat/conversation-column";
import type { NshPiloClient } from "../app/client/nsh-pilo-client";
import type {
	WebRemoteConnectionState,
	WebRemoteRecoveryState,
} from "./web-remote-client";
import type { ComposerStore } from "../app/composer/composer-store";
import { activeProject, isTemporarySessionId } from "../app/state/app-state";
import type { AppStore } from "../app/state/app-store";
import type { ChatRunConfigStore } from "../app/state/chat-run-config";
import type { ChatTranscriptStore } from "../app/state/chat-transcript-store";
import type { ModelCatalogStore } from "../app/state/model-catalog";
import { Button } from "../app/ui/button";
import { writeClipboardText } from "../app/ui/clipboard";
import { Dialog } from "../app/ui/dialog";
import { DialogDescription } from "../app/ui/dialog-description";
import { DialogTitle } from "../app/ui/dialog-title";
import { Icon } from "../app/ui/icon";
import { Input } from "../app/ui/input";
import { MOTION } from "../app/ui/motion";
import { Spinner } from "../app/ui/spinner";
import { ErrorState } from "../app/ui/state-view";
import { MobileDrawer, mobileDrawerWidth } from "./mobile-drawer";
import { menuListSpacing } from "../app/ui/menu";
import { MobileDropdownItem, MobileDropdownMenu } from "./mobile-dropdown-menu";
import type { RemoteChatQueue } from "./remote-chat-queue";
import {
	RemoteExtensionDialog,
	type RemoteExtensionUi,
} from "./remote-extension-ui";
import {
	MobileComposerSkeleton,
	MobileTextareaComposer,
} from "./mobile-textarea-composer";
import { MobileViewport } from "./mobile-viewport";
import { createWebColorScheme, WebColorScheme } from "./web-color-scheme";
import { createWebFontScale, WebFontScale } from "./web-font-scale";

export { MobileAuthRequiredView } from "./mobile-auth-required-view";

const SWIPE_OPEN_DISTANCE = 64;
const SWIPE_OPEN_VELOCITY = 350;
const SWIPE_OPEN_RATIO = 1.5;

export interface MobileAppShellProps {
	store: AppStore;
	chat: Pick<
		ChatTranscriptStore,
		"state" | "messages" | "refresh" | "loadRange"
	> &
		Partial<
			Pick<
				ChatTranscriptStore,
				"messageCount" | "isPlaceholderFailed" | "retryPlaceholder"
			>
		>;
	composer: ComposerStore;
	initialProjectId?: string | null;
	queue?: RemoteChatQueue;
	extensionUi?: RemoteExtensionUi;
	forker?: Pick<SessionForker, "state" | "forkAssistant">;
	forkDisabled?: Accessor<boolean>;
	runConfig?: Pick<
		ChatRunConfigStore,
		| "state"
		| "setModel"
		| "setThinkingLevel"
		| "cycleScopeModel"
		| "scopeModels"
		| "catalogReady"
	>;
	catalog?: Pick<ModelCatalogStore, "state" | "refresh" | "saveScope">;
	searchSessions?: Pick<NshPiloClient, "searchSessions">;
	connectionState: Accessor<WebRemoteConnectionState>;
	recoveryState: Accessor<WebRemoteRecoveryState>;
	onReconnect?: () => void;
	onSignOut?: () => void;
	onPauseCacheKeepAlive?: (sessionKey: string) => void;
	onDefaultWorkspaceShown?: (connectionId: string, shown: boolean) => void;
	readProjectImage?: (projectId: string, path: string) => Promise<Uint8Array>;
	readHistoryImage?: (
		projectId: string,
		sessionPath: string,
		imageId: string,
	) => Promise<Uint8Array>;
	toasts?: AppToasts;
}

/**
 * Single-column mobile chat workspace for nsh Web, aligned with React's Remote WebUI:
 * - Borderless top header (overlays centered empty landing) with Drawer, New Chat,
 *   Temporary Chat toggle, and Session info menu
 * - Slide-out session drawer (button + left-edge swipe strip) + CommandPalette search
 * - Virtualized conversation with streaming & scroll-following
 * - Floating connection/recovery NoticeCard above the native `<textarea>` composer
 * - Safe-area + software keyboard inset handling for iOS Safari & Android Chrome
 */
export function MobileAppShell(props: MobileAppShellProps) {
	const { store, chat, composer } = props;
	const toasts = props.toasts ?? new AppToasts();
	const drawerOpen = signal(false);
	const drawerDragProgress = signal<number | null>(null);
	const searchOpen = signal(false);
	const previewImage = signal<ChatImagePreview | null>(null);
	const renamingSession = signal<{
		projectId: string;
		sessionPath: string;
		title: string;
	} | null>(null);
	const renameValue = signal("");
	const renaming = signal(false);
	const confirmingHeaderDelete = signal(false);

	const status = computed(() => store.state().status);
	const project = computed(() => activeProject(store.state()));
	const claudeTheme = computed(
		() => store.state().themeSettings?.themeFamily === "claude",
	);
	const conversationLayout = computed(() => {
		const width = windowSize().width;
		return {
			claude: claudeTheme(),
			narrow: width < 640,
			fullWidth: width < 768,
		};
	});

	const webColorScheme = WebColorScheme() ?? createWebColorScheme();
	const webFontScale = WebFontScale() ?? createWebFontScale();
	const readingFontFamily = computed(
		() => store.state().preferences?.values.readingFontFamily,
	);
	const readingFont = computed(() =>
		chatReadingFont({
			readingFontSize: webFontScale.metrics().readingFontSize,
			readingFontFamily: readingFontFamily(),
		}),
	);

	const chatTarget = computed(() => openChatTarget(store.state()), {
		equals: (previous, next) =>
			previous?.sessionKey === next?.sessionKey &&
			previous?.projectId === next?.projectId &&
			previous?.sessionPath === next?.sessionPath,
	});
	const chatSessionKey = computed(() => chatTarget()?.sessionKey ?? null);

	effect(() => {
		const target = chatTarget();
		untracked(() => composer.setTarget(target));
	});

	// After a refresh, reopen an unsent draft in the restored project, not a saved session.
	let restoring = true;
	effect(() => {
		const state = store.state();
		if (state.status.type !== "ready") return;
		const restored =
			restoring &&
			state.projects.find(({ id }) => id === props.initialProjectId);
		const restoreDraft = restoring;
		restoring = false;
		if (state.navigation.session) return;
		const current = restored || activeProject(state);
		if (!current) return;
		const draft =
			restoreDraft &&
			[...(state.unsentDrafts ?? [])].find(
				([, draft]) => draft.projectId === current.id,
			);
		const sessionId = draft && parseChatSessionKey(draft[0])?.[1];
		untracked(() => {
			if (sessionId) store.selectDraft(current.id, sessionId);
			else store.selectProject(current.id);
		});
	});

	followSavedAppearance(store.state, {
		schemeOverride: webColorScheme.preference,
		uiTextScale: () => webFontScale.metrics().uiTextScale,
		codeFontSizeOverride: () => webFontScale.metrics().codeFontSize,
	});

	const openSessionEntry = computed(() => {
		const state = store.state();
		const open = state.navigation.session;
		if (!open?.sessionPath) return null;
		return (
			state.sessionIndexes[open.projectId]?.sessions.find(
				(entry) => entry.sessionPath === open.sessionPath,
			) ?? null
		);
	});
	const temporaryOpen = computed(() =>
		isTemporarySessionId(store.state().navigation.session?.sessionId),
	);
	const savedSessionOpen = computed(
		() =>
			!temporaryOpen() &&
			Boolean(
				store.state().navigation.session?.sessionPath ||
				props.runConfig?.state()?.session?.sessionPath,
			),
	);
	const hasMessages = computed(
		() =>
			(chat.messageCount ? chat.messageCount() : chat.messages().length) > 0,
	);
	const showHeaderTitle = computed(
		() => temporaryOpen() || savedSessionOpen() || hasMessages(),
	);
	const headerOverlay = computed(
		() =>
			status().type === "ready" &&
			!hasMessages() &&
			chat.state().status !== "loading",
	);
	const headerTitle = computed(
		() =>
			openSessionEntry()?.titleOverride ??
			props.runConfig?.state()?.session?.name ??
			openSessionEntry()?.name ??
			openSessionEntry()?.firstUserMessagePreview ??
			(temporaryOpen() ? t("app.temporaryChat") : t("app.newChat")),
	);
	const openSessionId = computed(
		() =>
			openSessionEntry()?.piSessionId ??
			props.runConfig?.state()?.session?.sessionId ??
			null,
	);
	const openSessionPath = computed(
		() =>
			store.state().navigation.session?.sessionPath ??
			props.runConfig?.state()?.session?.sessionPath ??
			null,
	);

	const copyText = (text: string) => {
		void writeClipboardText(text)
			.then(() =>
				showToast(toasts, { variant: "success", title: t("chat.copied") }),
			)
			.catch(() =>
				showToast(toasts, { variant: "error", title: t("chat.copyFailed") }),
			);
	};

	const fileOpenContext = {
		project,
		readProjectImage: props.readProjectImage,
		openImage: (image: ChatImagePreview) => previewImage.set(image),
		toasts,
	};
	const handleFileLink = (link: ChatMarkdownFileLink) =>
		openMarkdownFileLink(fileOpenContext, link);
	const mediaActions = {
		openImage: fileOpenContext.openImage,
		project,
		onFileLink: handleFileLink,
		openFile: (path: string, lineRange?: WorkspaceLineRange) =>
			openToolFilePath(fileOpenContext, path, lineRange),
		sessionMentions: () => composer.sessionsByValue(),
		readUserImage: createChatUserImageReader(() => {
			const session = store.openSession();
			const read = props.readHistoryImage;
			if (!session || !read) return null;
			const { projectId } = session;
			let sessionPath = session.sessionPath;
			if (!sessionPath) {
				const config = props.runConfig?.state();
				if (
					config &&
					config.sessionKey === chatSessionKey() &&
					config.projectId === projectId
				) {
					sessionPath = config.session?.sessionPath;
				}
			}
			return { projectId, sessionPath, sessionKey: chatSessionKey(), read };
		}),
	};

	const newChat = (projectId?: string) => {
		const targetId = projectId ?? activeProject(store.state())?.id;
		if (targetId) store.selectProject(targetId);
	};

	const toggleTemporaryChat = () => {
		const targetId = activeProject(store.state())?.id;
		if (!targetId) return;
		if (temporaryOpen()) {
			store.selectProject(targetId);
		} else {
			store.selectTemporary(targetId);
		}
	};

	const openRenameDialog = (target: {
		projectId: string;
		sessionPath: string;
		title: string;
	}) => {
		renameValue.set(target.title);
		renamingSession.set(target);
	};

	const submitRename = () => {
		const target = renamingSession();
		if (!target || renaming()) return;
		const nextTitle = renameValue().trim();
		if (!nextTitle) return;
		renaming.set(true);
		void store
			.renameSession(target.projectId, target.sessionPath, nextTitle)
			.then(() => {
				renamingSession.set(null);
			})
			.catch((error: unknown) => {
				showToast(toasts, {
					variant: "error",
					title: t("chat.renameSessionFailed"),
					description: userErrorMessage(error),
				});
			})
			.finally(() => {
				renaming.set(false);
			});
	};

	const openExtensionSession = (projectId: string, sessionKey: string) => {
		const state = store.state();
		const active = state.chatSessions.find(
			(item) => item.sessionKey === sessionKey,
		);
		if (active?.sessionPath) {
			store.selectSession(projectId, active.sessionPath);
			return;
		}
		const indexed = state.sessionIndexes[projectId]?.sessions.find(
			(entry) =>
				formatChatSessionKey(projectId, entry.piSessionId) === sessionKey,
		);
		if (indexed?.sessionPath) {
			store.selectSession(projectId, indexed.sessionPath);
			return;
		}
		const parsed = parseChatSessionKey(sessionKey);
		if (parsed && parsed[0] === projectId && parsed[1]) {
			store.selectDraft(projectId, parsed[1]);
			return;
		}
		store.selectProject(projectId);
	};

	const cacheNoticeSessions = computed(() => {
		const sessionKey = chatSessionKey();
		return sessionKey ? [sessionKey] : [];
	});
	const cacheKeepAliveStatusFor = (sessionKey: string) =>
		store.state().chatSessions.find((item) => item.sessionKey === sessionKey)
			?.cacheKeepAlive ?? null;

	// Restrict drawer swipe-open to the left edge (64px) so horizontal gestures
	// inside wide code blocks and tables never accidentally open the drawer, while
	// leaving room past iOS Safari's system back-swipe edge.
	const drawerDragVelocity = signal(0);
	const updateDragProgress = (dx: number) => {
		const width = mobileDrawerWidth(windowSize().width);
		drawerDragProgress.set(Math.max(0, Math.min(1, dx / width)));
	};
	const openPan = PanResponder.create({
		onMoveShouldSetPanResponder: (_event, gesture) =>
			!drawerOpen() &&
			!searchOpen() &&
			!previewImage() &&
			!renamingSession() &&
			!confirmingHeaderDelete() &&
			gesture.numberActiveTouches === 1 &&
			gesture.x0 <= 64 &&
			gesture.dx >= 10 &&
			gesture.dx > Math.abs(gesture.dy) * SWIPE_OPEN_RATIO,
		onPanResponderGrant: (_event, gesture) => {
			drawerDragVelocity.set(0);
			updateDragProgress(gesture.dx);
		},
		onPanResponderMove: (_event, gesture) => {
			updateDragProgress(gesture.dx);
		},
		onPanResponderRelease: (_event, gesture) => {
			const width = mobileDrawerWidth(windowSize().width);
			drawerDragVelocity.set(width > 0 ? gesture.vx / width : 0);
			drawerDragProgress.set(null);
			if (
				gesture.dx >= SWIPE_OPEN_DISTANCE ||
				(gesture.dx >= 24 && gesture.vx > SWIPE_OPEN_VELOCITY)
			) {
				drawerOpen.set(true);
			}
		},
		onPanResponderTerminate: () => {
			drawerDragVelocity.set(0);
			drawerDragProgress.set(null);
		},
		onPanResponderTerminationRequest: () => false,
	});

	const viewport = MobileViewport();
	const composerBottomPadding = computed(() =>
		resolveMobileComposerBottomPadding({
			managed: viewport.managed(),
			keyboardOpen: viewport.keyboardOpen(),
			keyboardHeight: viewport.managed() ? 0 : keyboardFrame().height,
			safeAreaBottom: viewport.safeAreaBottom(),
		}),
	);

	const runConfigProps = props.runConfig
		? {
				config: () => props.runConfig?.state() ?? null,
				models: () => props.catalog?.state()?.catalog?.models ?? [],
				scopeModels: () => props.runConfig?.scopeModels ?? [],
				scope: () => props.catalog?.state()?.scope ?? null,
				scopeReady: () => props.runConfig?.catalogReady ?? false,
				loading: () => {
					const catalog = props.catalog?.state();
					return !catalog?.loaded || catalog.refreshing;
				},
				error: () => props.catalog?.state()?.error ?? null,
				savingScope: () => props.catalog?.state()?.savingScope ?? false,
				onModel: (model: Parameters<ChatRunConfigStore["setModel"]>[0]) =>
					void props.runConfig?.setModel(model),
				onThinking: (
					level: Parameters<ChatRunConfigStore["setThinkingLevel"]>[0],
				) => void props.runConfig?.setThinkingLevel(level),
				onRefresh: props.catalog
					? () => void props.catalog?.refresh()
					: undefined,
				onSaveScope: props.catalog
					? (models: Parameters<ModelCatalogStore["saveScope"]>[0]) =>
							props.catalog!.saveScope(models)
					: undefined,
			}
		: undefined;

	const showConnectionNotice = computed(
		() =>
			props.connectionState() !== "connected" ||
			props.recoveryState() === "recovered",
	);

	const renderConnectionNotice = () => {
		if (!showConnectionNotice()) return null;
		const conn = props.connectionState();
		const recovered =
			conn === "connected" && props.recoveryState() === "recovered";
		const offline = conn === "offline";
		const enter = createMotion({
			enter: reduceMotion()
				? {
						keyframes: { opacity: [0, 1] },
						duration: 80,
						easing: MOTION.easing.standardTuple,
					}
				: {
						keyframes: { opacity: [0, 1], translateY: [6, 0] },
						duration: MOTION.duration.surfaceIn,
						easing: MOTION.easing.standardTuple,
					},
		});
		cleanup(() => enter.stop());
		return (
			<View
				testID="mobile-connection-banner"
				role="alert"
				class="mb-1.5 min-w-0 flex-row items-center gap-2.5 rounded-xl border border-border/60 bg-muted px-3 py-2"
				style={enter.style}
			>
				{recovered ? (
					<Icon name="CircleCheck" size={14} color={token("status-success")} />
				) : offline ? (
					<Icon name="WifiOff" size={14} color={token("status-warning")} />
				) : (
					<Spinner size={14} color={token("muted-foreground")} />
				)}
				<View class="min-w-0 flex-1">
					<Text class="truncate font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug font-medium text-foreground/85">
						{recovered
							? t("settings.remoteConnected")
							: offline
								? t("settings.remoteOffline")
								: t("settings.remoteConnectionLost")}
					</Text>
					{!recovered ? (
						<Text class="mt-0.5 font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-muted-foreground">
							{offline
								? t("settings.remoteOfflineDescription")
								: t("settings.remoteReconnecting")}
						</Text>
					) : null}
				</View>
				{conn !== "connected" && props.onReconnect ? (
					<Button
						testID="mobile-reconnect-button"
						variant="ghost"
						size="sm"
						class="min-h-10 shrink-0 gap-1.5 px-2.5"
						onPress={props.onReconnect}
					>
						<Icon
							name="RefreshCw"
							size={13}
							color={token("muted-foreground")}
						/>
						<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-muted-foreground">
							{() => t("common.retry")}
						</Text>
					</Button>
				) : null}
			</View>
		);
	};

	const renderBackgroundExtensionNotice = () => {
		const pending = props.extensionUi?.backgroundDialog(
			chatSessionKey() ?? undefined,
		);
		if (!pending) return null;
		return (
			<View
				testID="mobile-background-extension-banner"
				role="alert"
				class="mb-1.5 min-w-0 flex-row items-center gap-2 rounded-xl border border-border/60 bg-muted py-1 pl-3 pr-1.5"
			>
				<Icon name="Bell" size={14} color={token("status-warning")} />
				<Text class="min-w-0 flex-1 truncate font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug font-medium text-foreground/85">
					{() => t("chat.extensionPendingInOtherSession")}
				</Text>
				<Button
					testID="mobile-background-extension-open"
					variant="secondary"
					size="sm"
					class="min-h-10 shrink-0 px-3"
					onPress={() =>
						openExtensionSession(
							pending.target.projectId,
							pending.target.sessionKey,
						)
					}
				>
					<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-foreground">
						{() => t("chat.extensionSwitchToSession")}
					</Text>
				</Button>
			</View>
		);
	};

	const renderHeader = () => (
		<View
			testID="mobile-header"
			class={`mt-0.5 h-11 shrink-0 flex-row items-center bg-background px-1.5 ${
				headerOverlay() ? "absolute inset-x-0 top-0 z-30" : "relative"
			}`}
		>
			<Button
				testID="mobile-menu-button"
				variant="ghost"
				size="icon"
				class="size-11 shrink-0 rounded-(--pilo-mobile-radius-md)"
				accessibilityLabel={t("navigation.expandSidebar")}
				onPress={() => drawerOpen.set(true)}
			>
				<Icon name="PanelLeft" size={16} color={token("muted-foreground")} />
			</Button>

			<View class="min-w-0 flex-1 flex-row items-center pr-1">
				{() =>
					showHeaderTitle() ? (
						<View
							class={`min-w-0 max-w-full flex-row items-center gap-1.5 rounded-(--pilo-mobile-radius-md) ${
								temporaryOpen()
									? "h-8 border border-dashed border-border/70 px-2"
									: "pr-2"
							}`}
						>
							{temporaryOpen() ? (
								<Icon
									name="MessageSquareDashed"
									size={14}
									color={token("foreground")}
								/>
							) : null}
							<Text
								testID="mobile-header-title"
								class="min-w-0 shrink truncate font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-foreground"
							>
								{headerTitle}
							</Text>
						</View>
					) : null
				}
			</View>

			<View class="shrink-0 flex-row items-center gap-0.5 pr-0.5">
				<Button
					testID="mobile-new-chat-button"
					variant="ghost"
					size="icon"
					class="size-11 shrink-0 rounded-(--pilo-mobile-radius-md)"
					disabled={!project()}
					accessibilityLabel={t("app.newChat")}
					onPress={() => newChat()}
				>
					<Icon name="SquarePen" size={16} color={token("foreground")} />
				</Button>

				<Button
					testID="mobile-temporary-chat-button"
					variant="ghost"
					size="icon"
					class="size-11 shrink-0 rounded-(--pilo-mobile-radius-md)"
					disabled={!project()}
					selected={temporaryOpen()}
					accessibilityLabel={t("app.temporaryChat")}
					onPress={toggleTemporaryChat}
				>
					<Icon
						name="MessageSquareDashed"
						size={16}
						color={token(temporaryOpen() ? "primary" : "foreground")}
					/>
				</Button>

				{() =>
					savedSessionOpen() ? (
						<MobileDropdownMenu
							align="end"
							popupClass="w-72"
							trigger={
								<Button
									testID="mobile-session-menu-button"
									variant="ghost"
									size="icon"
									class="size-11 shrink-0 rounded-(--pilo-mobile-radius-md)"
									accessibilityLabel={t("chat.sessionMenu")}
								>
									<Icon
										name="MoreHorizontal"
										size={16}
										color={token("foreground")}
									/>
								</Button>
							}
						>
							<View
								testID="mobile-session-menu-popup"
								style={menuListSpacing()}
							>
								<MobileDropdownItem
									testID="mobile-session-copy-id"
									class="px-2.5 py-1.5"
									disabled={!openSessionId()}
									onSelect={() => {
										const id = openSessionId();
										if (id) copyText(id);
									}}
								>
									<View class="min-w-0 flex-1 gap-0.5">
										<View class="flex-row items-center justify-between gap-2">
											<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-foreground">
												{() => t("chat.sessionId")}
											</Text>
											<Icon
												name="Copy"
												size={13}
												color={token("muted-foreground")}
												style={{ opacity: 0.75 }}
											/>
										</View>
										<Text class="min-w-0 truncate font-mono text-xs text-(length:--pilo-ui-text-xs) leading-tight text-muted-foreground">
											{() => openSessionId() ?? "—"}
										</Text>
									</View>
								</MobileDropdownItem>
								<MobileDropdownItem
									testID="mobile-session-copy-path"
									class="px-2.5 py-1.5"
									disabled={!openSessionPath()}
									onSelect={() => {
										const path = openSessionPath();
										if (path) copyText(path);
									}}
								>
									<View class="min-w-0 flex-1 gap-0.5">
										<View class="flex-row items-center justify-between gap-2">
											<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-foreground">
												{() => t("chat.sessionFilePath")}
											</Text>
											<Icon
												name="Copy"
												size={13}
												color={token("muted-foreground")}
												style={{ opacity: 0.75 }}
											/>
										</View>
										<Text
											class={`min-w-0 truncate text-xs text-(length:--pilo-ui-text-xs) leading-tight text-muted-foreground ${
												openSessionPath() ? "font-mono" : "font-sans"
											}`}
										>
											{() => {
												const path = openSessionPath();
												return path
													? compactMiddlePath(path, 34)
													: t("chat.sessionPathUnavailable");
											}}
										</Text>
									</View>
								</MobileDropdownItem>
								<View class="mx-1.5 my-1 h-px bg-(--pilo-menu-edge)" />
								<MobileDropdownItem
									testID="mobile-session-rename"
									class="gap-2.5 px-2.5 py-1.5"
									icon={<Icon name="Pencil" size={14} />}
									disabled={!openSessionPath() || !project()}
									onSelect={() => {
										const currentProject = project();
										const path = openSessionPath();
										if (currentProject && path) {
											openRenameDialog({
												projectId: currentProject.id,
												sessionPath: path,
												title: headerTitle(),
											});
										}
									}}
								>
									<Text class="font-sans text-foreground">
										{() => t("chat.renameSession")}
									</Text>
								</MobileDropdownItem>
								<View class="mx-1.5 my-1 h-px bg-(--pilo-menu-edge)" />
								<MobileDropdownItem
									testID="mobile-session-delete"
									variant="destructive"
									class="gap-2.5 px-2.5 py-1.5"
									icon={<Icon name="Trash2" size={14} />}
									disabled={!openSessionPath() || !project()}
									onSelect={() => confirmingHeaderDelete.set(true)}
								>
									<Text class="font-sans">{() => t("chat.deleteSession")}</Text>
								</MobileDropdownItem>
							</View>
						</MobileDropdownMenu>
					) : null
				}
			</View>
		</View>
	);

	return (
		<AppToaster.Provider value={toasts}>
			<ChatMediaActions.Provider value={mediaActions}>
				<ConversationColumnLayout.Provider value={conversationLayout}>
					<ChatReadingFont.Provider value={readingFont}>
						<View
							testID="mobile-app"
							class="relative flex-1 flex-col bg-background"
							style={{
								paddingTop: viewport.safeAreaTop(),
								paddingLeft: safeArea().left,
								paddingRight: safeArea().right,
							}}
						>
							<View class="relative min-h-0 min-w-0 flex-1 flex-col">
								{renderHeader()}

								{/* Main conversation & composer body */}
								<View class="relative min-h-0 min-w-0 flex-1 flex-col">
									{() => {
										const current = status();
										if (current.type === "starting") {
											return (
												<View class="min-h-0 flex-1 flex-col">
													<View
														testID="mobile-workspace-swipe"
														{...openPan.panHandlers}
														panActivation={{
															activeOffsetX: 14,
															failOffsetY: 12,
														}}
														class="min-h-0 flex-1 justify-center"
													>
														<ConversationColumn>
															<SessionLanding loading touch />
														</ConversationColumn>
													</View>
													<View
														class="w-full shrink-0"
														style={{ paddingBottom: composerBottomPadding() }}
													>
														<ConversationColumn>
															<MobileComposerSkeleton showModel />
														</ConversationColumn>
													</View>
												</View>
											);
										}
										if (current.type === "failed") {
											return (
												<View
													testID="mobile-workspace-swipe"
													{...openPan.panHandlers}
													panActivation={{ activeOffsetX: 14, failOffsetY: 12 }}
													class="flex-1 items-center justify-center p-6"
												>
													<ErrorState
														testID="mobile-startup-failed"
														title={() => t("common.loadFailed")}
														description={() => current.message}
														onRetry={() => store.retry()}
														retryLabel={() => t("common.retry")}
														retryTestID="mobile-startup-retry"
													/>
												</View>
											);
										}
										if (current.type === "closed") {
											return (
												<View
													testID="mobile-workspace-swipe"
													{...openPan.panHandlers}
													panActivation={{ activeOffsetX: 14, failOffsetY: 12 }}
													class="flex-1 items-center justify-center p-6"
												>
													<ErrorState
														testID="mobile-runtime-stopped"
														title={() => t("app.runtimeStopped")}
														description={() =>
															t("app.runtimeStoppedDescription")
														}
													/>
												</View>
											);
										}

										return (
											<View class="min-h-0 min-w-0 flex-1 flex-col">
												<View
													testID="mobile-workspace-swipe"
													{...openPan.panHandlers}
													panActivation={{ activeOffsetX: 14, failOffsetY: 12 }}
													class="min-h-0 min-w-0 flex-1"
												>
													<ChatMessageList
														lastSubmission={composer.lastSubmission}
														assistantText={(text, textKey, streaming) => (
															<ChatMarkdown
																text={text}
																textKey={textKey}
																streaming={streaming}
																project={project}
																readProjectImage={props.readProjectImage}
																onFileLink={handleFileLink}
															/>
														)}
														preferences={() =>
															store.state().preferences?.values
														}
														transcript={chat.state}
														onForkAssistant={
															props.forker
																? (id) => void props.forker?.forkAssistant(id)
																: undefined
														}
														canForkAssistant={() => !!chatTarget()?.sessionPath}
														forkingMessageId={() =>
															props.forker?.state().forkingMessageId ?? null
														}
														forkDisabled={() =>
															(props.forkDisabled?.() ?? false) ||
															!!props.forker?.state().forkingMessageId
														}
														onRetry={() => chat.refresh()}
														onVisibleRangeChange={(start, end) =>
															chat.loadRange(start, end)
														}
														isPlaceholderFailed={(index) =>
															chat.isPlaceholderFailed?.(index) ?? false
														}
														onRetryPlaceholder={(index) =>
															chat.retryPlaceholder?.(index)
														}
														footer={() => (
															<View>
																{() =>
																	props.runConfig?.state()?.compacting ? (
																		<ConversationColumn class="py-3">
																			<ChatAgentActivityIndicator
																				testID="chat-compacting"
																				label={() => t("chat.compacting")}
																			/>
																		</ConversationColumn>
																	) : null
																}
															</View>
														)}
														empty={() => (
															<SessionLanding
																store={store}
																project={project}
																touch
																availableHeight={viewport.availableHeight}
															/>
														)}
													/>
												</View>

												{/* Bottom composer region, lifted smoothly above soft keyboard */}
												<View
													testID="mobile-composer-region"
													class="relative z-20 -mt-4 w-full shrink-0"
													style={{ paddingBottom: composerBottomPadding() }}
												>
													<ConversationColumn class="relative">
														{renderConnectionNotice}
														{renderBackgroundExtensionNotice}
														<Each
															of={cacheNoticeSessions()}
															key={(sessionKey) =>
																`mobile-cache-keep-alive:${sessionKey}`
															}
														>
															{(sessionKey) => (
																<CacheKeepAliveNotice
																	touch
																	status={() =>
																		cacheKeepAliveStatusFor(sessionKey())
																	}
																	onPause={
																		props.onPauseCacheKeepAlive
																			? () => {
																					props.onPauseCacheKeepAlive?.(
																						sessionKey(),
																					);
																				}
																			: undefined
																	}
																/>
															)}
														</Each>
														{() => {
															const sessionKey = chatSessionKey();
															return sessionKey === null ? null : (
																<ChatTodoCapsule
																	sessionKey={sessionKey}
																	transcript={chat.state}
																	running={() => composer.running()}
																/>
															);
														}}
														{props.queue ? (
															<ChatPendingQueue
																queue={props.queue}
																composer={composer}
																sessionKey={chatSessionKey}
																disabled={() =>
																	props.connectionState() !== "connected"
																}
																touch
																availableHeight={viewport.availableHeight}
															/>
														) : null}
														<MobileTextareaComposer
															store={composer}
															sendShortcut={() =>
																store.state().preferences?.values
																	.sendMessageShortcut
															}
															runConfig={runConfigProps}
														/>
													</ConversationColumn>
												</View>
											</View>
										);
									}}
								</View>
							</View>

							<MobileDrawer
								store={store}
								open={drawerOpen}
								onOpenChange={(open) => {
									if (!open) drawerDragVelocity.set(0);
									drawerOpen.set(open);
								}}
								dragProgress={drawerDragProgress}
								dragVelocity={drawerDragVelocity}
								connectionState={props.connectionState}
								colorScheme={webColorScheme.preference}
								onColorSchemeChange={webColorScheme.setPreference}
								fontScale={webFontScale.preference}
								onFontScaleChange={webFontScale.setPreference}
								onReconnect={props.onReconnect}
								onSignOut={props.onSignOut}
								onRenameSession={openRenameDialog}
								onOpenSearch={() => searchOpen.set(true)}
								onNewChat={newChat}
								onDefaultWorkspaceShown={props.onDefaultWorkspaceShown}
							/>

							<CommandPalette
								open={searchOpen}
								store={store}
								shortcuts={() => ({})}
								searchSessions={props.searchSessions}
								onClose={() => searchOpen.set(false)}
							/>

							<ChatImageLightbox
								image={previewImage}
								onClose={() => previewImage.set(null)}
							/>
							{() => {
								const target = renamingSession();
								if (!target) return null;
								return (
									<Dialog
										open
										accessibilityLabel={t("chat.renameDialogTitle")}
										closeOnEscape={!renaming()}
										onOpenChange={({ open }) => {
											if (!open && !renaming()) renamingSession.set(null);
										}}
									>
										<DialogTitle>
											{() => t("chat.renameDialogTitle")}
										</DialogTitle>
										<DialogDescription>
											{() => t("chat.renameDialogDescription")}
										</DialogDescription>
										<Input
											testID="mobile-rename-input"
											autoFocus
											value={renameValue()}
											placeholder={t("sidebar.renamePlaceholder")}
											disabled={renaming()}
											style={{
												fontSize: webInputFontSize(token("pilo-ui-text-sm")),
											}}
											onChange={({ value }) => renameValue.set(value)}
											onSubmit={submitRename}
										/>
										<View class="flex-row justify-end gap-2">
											<Button
												variant="ghost"
												class="min-h-11"
												disabled={renaming()}
												onPress={() => renamingSession.set(null)}
											>
												<Text>{() => t("chat.renameDialogCancel")}</Text>
											</Button>
											<Button
												testID="mobile-rename-confirm"
												class="min-h-11"
												disabled={renaming() || !renameValue().trim()}
												onPress={submitRename}
											>
												<Text>{() => t("chat.renameDialogConfirm")}</Text>
											</Button>
										</View>
									</Dialog>
								);
							}}
							{() => {
								if (!confirmingHeaderDelete()) return null;
								const currentProject = project();
								const path = openSessionPath();
								if (!currentProject || !path) return null;
								return (
									<Dialog
										open
										accessibilityLabel={t("chat.deleteSession")}
										onOpenChange={({ open }) => {
											if (!open) confirmingHeaderDelete.set(false);
										}}
									>
										<DialogTitle>{() => t("chat.deleteSession")}</DialogTitle>
										<DialogDescription>{headerTitle}</DialogDescription>
										<View class="flex-row justify-end gap-2">
											<Button
												variant="ghost"
												class="min-h-11"
												onPress={() => confirmingHeaderDelete.set(false)}
											>
												<Text>{() => t("common.cancel")}</Text>
											</Button>
											<Button
												testID="mobile-header-delete-confirm"
												variant="destructive"
												class="min-h-11"
												onPress={() => {
													confirmingHeaderDelete.set(false);
													void deleteSessionWithToast(
														store,
														toasts,
														currentProject.id,
														path,
													);
												}}
											>
												<Text>
													{() =>
														composer.running()
															? t("sidebar.deleteRunningConfirm")
															: t("common.delete")
													}
												</Text>
											</Button>
										</View>
									</Dialog>
								);
							}}
							{props.extensionUi ? (
								<RemoteExtensionDialog
									ui={props.extensionUi}
									sessionKey={chatSessionKey}
								/>
							) : null}
							<AppToastStack
								toasts={toasts}
								touch
								topInset={viewport.safeAreaTop}
							/>
						</View>
					</ChatReadingFont.Provider>
				</ConversationColumnLayout.Provider>
			</ChatMediaActions.Provider>
		</AppToaster.Provider>
	);
}

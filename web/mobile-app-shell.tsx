import {
	type Accessor,
	Clipboard,
	computed,
	effect,
	keyboardFrame,
	PanResponder,
	safeArea,
	signal,
	Text,
	token,
	untracked,
	View,
	windowSize,
} from "nsh";

import type { ChatConversationImage } from "@shared/chat/conversation-types";
import type { WorkspaceLineRange } from "@shared/project-workspace";

import {
	AppToaster,
	AppToasts,
	AppToastStack,
	showToast,
} from "../app/shell/app-toasts";
import { followSavedAppearance } from "../app/shell/appearance";
import { CommandPalette } from "../app/shell/command-palette";
import { t } from "../app/shell/i18n";
import { SessionLanding } from "../app/shell/landing";
import { openChatTarget } from "../app/shell/open-chat";
import {
	openMarkdownFileLink,
	openToolFilePath,
} from "../app/shell/open-file-link";
import type { SessionForker } from "../app/shell/session-fork";
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
import {
	ChatReadingFont,
	chatReadingFont,
} from "../app/chat/chat-reading-font";
import { ChatTodoCapsule } from "../app/chat/chat-todo-capsule";
import { readChatUserImage } from "../app/chat/chat-user-image-cache";
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
import { Icon } from "../app/ui/icon";
import { Input } from "../app/ui/input";
import { Spinner } from "../app/ui/spinner";
import { ErrorState } from "../app/ui/state-view";
import { styleVar } from "../app/ui/theme-style";
import { MobileDrawer, mobileDrawerWidth } from "./mobile-drawer";
import { MobileDropdownItem, MobileDropdownMenu } from "./mobile-dropdown-menu";
import { MobilePendingQueue } from "./mobile-pending-queue";
import type { RemoteChatQueue } from "./remote-chat-queue";
import {
	RemoteExtensionDialog,
	type RemoteExtensionUi,
} from "./remote-extension-ui";
import {
	MobileComposerSkeleton,
	MobileTextareaComposer,
} from "./mobile-textarea-composer";
import { MOBILE_TEXT } from "./mobile-typography";

const SWIPE_OPEN_DISTANCE = 64;
const SWIPE_OPEN_VELOCITY = 350;
const SWIPE_OPEN_RATIO = 1.5;

export interface AuthExpiryReminder {
	description: string;
	renewing?: boolean;
	renew: () => void;
	dismiss: () => void;
}

export interface MobileAppShellProps {
	store: AppStore;
	chat: Pick<
		ChatTranscriptStore,
		"state" | "messages" | "refresh" | "loadRange"
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
	authExpiryReminder?: Accessor<AuthExpiryReminder | null>;
	onReconnect?: () => void;
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

	const readingFontSize = computed(
		() => store.state().preferences?.values.readingFontSize,
	);
	const readingFontFamily = computed(
		() => store.state().preferences?.values.readingFontFamily,
	);
	const readingFont = computed(() =>
		chatReadingFont({
			readingFontSize: readingFontSize(),
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

	// After a refresh, reopen the project (not the previous session) for its draft.
	let initialProjectId = props.initialProjectId;
	effect(() => {
		const state = store.state();
		if (state.status.type !== "ready") return;
		const restored = state.projects.find(({ id }) => id === initialProjectId);
		initialProjectId = null;
		if (state.navigation.session) return;
		const current = restored ?? activeProject(state);
		if (current) untracked(() => store.selectProject(current.id));
	});

	followSavedAppearance(store.state);

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
	const hasMessages = computed(() => chat.messages().length > 0);
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
		void Clipboard.writeText(text)
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
		readUserImage: (image: ChatConversationImage) => {
			const session = store.state().navigation.session;
			const config = props.runConfig?.state();
			const sessionPath =
				session?.sessionPath ||
				(config &&
				config.sessionKey === chatSessionKey() &&
				config.projectId === session?.projectId
					? config.session?.sessionPath
					: undefined);
			const read = props.readHistoryImage;
			return readChatUserImage(
				image,
				session && sessionPath && read
					? { projectId: session.projectId, sessionPath, read }
					: null,
			);
		},
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

	// Swipe right from anywhere in the left 2/3 of the workspace to drag open
	// the session drawer live, matching React's `useMobileNavigationSwipe`.
	const updateDragProgress = (dx: number) => {
		const width = mobileDrawerWidth(windowSize().width);
		drawerDragProgress.set(Math.max(0, Math.min(1, dx / width)));
	};
	const openPan = PanResponder.create({
		onMoveShouldSetPanResponder: (_event, gesture) =>
			!drawerOpen() &&
			!searchOpen() &&
			!previewImage() &&
			gesture.numberActiveTouches === 1 &&
			gesture.x0 <= (windowSize().width * 2) / 3 &&
			gesture.dx >= 10 &&
			gesture.dx > Math.abs(gesture.dy) * SWIPE_OPEN_RATIO,
		onPanResponderGrant: (_event, gesture) => {
			updateDragProgress(gesture.dx);
		},
		onPanResponderMove: (_event, gesture) => {
			updateDragProgress(gesture.dx);
		},
		onPanResponderRelease: (_event, gesture) => {
			drawerDragProgress.set(null);
			if (
				gesture.dx >= SWIPE_OPEN_DISTANCE ||
				(gesture.dx >= 24 && gesture.vx > SWIPE_OPEN_VELOCITY)
			) {
				drawerOpen.set(true);
			}
		},
		onPanResponderTerminate: () => {
			drawerDragProgress.set(null);
		},
		onPanResponderTerminationRequest: () => false,
	});

	const composerBottomPadding = computed(() => {
		const kb = keyboardFrame().height;
		if (kb > 0) return kb + 8;
		return Math.max(16, safeArea().bottom + 8);
	});

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
		return (
			<View
				testID="mobile-connection-banner"
				role="alert"
				class="mb-1.5 min-w-0 flex-row items-center gap-2.5 rounded-xl border border-border/60 bg-muted px-3 py-2"
			>
				{recovered ? (
					<Icon name="CircleCheck" size={14} color={token("status-success")} />
				) : offline ? (
					<Icon name="WifiOff" size={14} color={token("status-warning")} />
				) : (
					<Spinner size={14} color={token("muted-foreground")} />
				)}
				<View class="min-w-0 flex-1">
					<Text
						class="truncate font-sans font-medium text-foreground/85"
						style={MOBILE_TEXT.xs}
					>
						{recovered
							? t("settings.remoteConnected")
							: offline
								? t("settings.remoteOffline")
								: t("chat.reconnectingTitle")}
					</Text>
					{!recovered ? (
						<Text
							class="mt-0.5 font-sans text-muted-foreground"
							style={MOBILE_TEXT.xs}
						>
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
						<Text
							class="font-sans text-muted-foreground"
							style={MOBILE_TEXT.xs}
						>
							{() => t("common.retry")}
						</Text>
					</Button>
				) : null}
			</View>
		);
	};

	const renderAuthExpiryNotice = () => {
		const reminder = props.authExpiryReminder?.();
		if (!reminder) return null;
		return (
			<View
				testID="mobile-auth-expiry-banner"
				class="mb-1.5 min-w-0 flex-row items-center gap-1 rounded-xl border border-border/60 bg-muted py-1 pl-3 pr-1"
			>
				<View class="min-w-0 flex-1 py-1">
					<Text
						class="truncate font-sans font-medium text-foreground/85"
						style={MOBILE_TEXT.xs}
					>
						{() => t("settings.remoteAuthorizationExpiring")}
					</Text>
					<Text
						class="mt-0.5 font-sans text-muted-foreground"
						style={MOBILE_TEXT.xs}
					>
						{reminder.description}
					</Text>
				</View>
				<Button
					testID="mobile-auth-renew-button"
					variant="secondary"
					size="sm"
					class="min-h-11 min-w-11 shrink-0 px-3"
					disabled={reminder.renewing}
					onPress={reminder.renew}
				>
					<Text class="font-sans text-foreground" style={MOBILE_TEXT.xs}>
						{() => t("settings.remoteAuthorizationRenew")}
					</Text>
				</Button>
				<Button
					testID="mobile-auth-dismiss-button"
					variant="ghost"
					size="icon"
					class="size-11 shrink-0"
					accessibilityLabel={t("common.close")}
					onPress={reminder.dismiss}
				>
					<Icon name="X" size={14} color={token("muted-foreground")} />
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

			<View class="min-w-0 flex-1 flex-row items-center px-1">
				{() =>
					showHeaderTitle() ? (
						<View
							class={`min-w-0 max-w-full flex-row items-center gap-1.5 rounded-(--pilo-mobile-radius-md) px-2 ${
								temporaryOpen()
									? "h-8 border border-dashed border-border/70"
									: ""
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
								class="min-w-0 shrink truncate font-sans text-foreground"
								style={MOBILE_TEXT.sm}
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
							<View testID="mobile-session-menu-popup" class="gap-1">
								<MobileDropdownItem
									testID="mobile-session-copy-id"
									icon={<Icon name="Copy" size={14} />}
									disabled={!openSessionId()}
									onSelect={() => {
										const id = openSessionId();
										if (id) copyText(id);
									}}
								>
									<Text class="shrink-0 font-sans text-muted-foreground">
										{() => t("chat.sessionId")}
									</Text>
									<Text class="min-w-0 flex-1 truncate text-right font-mono text-xs">
										{() => openSessionId() ?? "—"}
									</Text>
								</MobileDropdownItem>
								<MobileDropdownItem
									testID="mobile-session-copy-path"
									icon={<Icon name="Copy" size={14} />}
									disabled={!openSessionPath()}
									onSelect={() => {
										const path = openSessionPath();
										if (path) copyText(path);
									}}
								>
									<Text class="shrink-0 font-sans text-muted-foreground">
										{() => t("chat.sessionFilePath")}
									</Text>
									<Text class="min-w-0 flex-1 truncate text-right font-mono text-xs">
										{() =>
											openSessionPath() ?? t("chat.sessionPathUnavailable")
										}
									</Text>
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
								paddingTop: safeArea().top,
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
															<SessionLanding loading />
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
														assistantText={(text, textKey) => (
															<ChatMarkdown
																text={text}
																textKey={textKey}
																project={project}
																readProjectImage={props.readProjectImage}
																onFileLink={handleFileLink}
															/>
														)}
														preferences={() =>
															store.state().preferences?.values
														}
														transcript={chat.state}
														messages={() => chat.messages()}
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
																onAddProject={() => undefined}
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
														{renderAuthExpiryNotice}
														{renderConnectionNotice}
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
															<MobilePendingQueue
																queue={props.queue}
																composer={composer}
																sessionKey={chatSessionKey}
																connected={() =>
																	props.connectionState() === "connected"
																}
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
								onOpenChange={(open) => drawerOpen.set(open)}
								dragProgress={drawerDragProgress}
								connectionState={props.connectionState}
								onReconnect={props.onReconnect}
								onOpenSearch={() => searchOpen.set(true)}
								onNewChat={newChat}
								onDefaultWorkspaceShown={props.onDefaultWorkspaceShown}
							/>

							{() =>
								searchOpen() ? (
									<CommandPalette
										store={store}
										shortcuts={() => ({})}
										searchSessions={props.searchSessions}
										onClose={() => searchOpen.set(false)}
									/>
								) : null
							}

							<ChatImageLightbox
								image={previewImage}
								onClose={() => previewImage.set(null)}
							/>
							{props.extensionUi ? (
								<RemoteExtensionDialog
									ui={props.extensionUi}
									sessionKey={chatSessionKey}
								/>
							) : null}
							<AppToastStack toasts={toasts} />
						</View>
					</ChatReadingFont.Provider>
				</ConversationColumnLayout.Provider>
			</ChatMediaActions.Provider>
		</AppToaster.Provider>
	);
}

/**
 * Shown when no valid paired device token is present in browser storage.
 * Aligned with React's unauthenticated Remote WebUI card, with optional
 * manual token entry for direct pairing.
 */
export function MobileAuthRequiredView(props: {
	error?: Accessor<string | null>;
	onSubmitToken: (token: string) => void;
}) {
	const tokenDraft = signal("");
	const showTokenInput = signal(false);

	const submit = () => {
		const trimmed = tokenDraft().trim();
		if (!trimmed) return;
		props.onSubmitToken(trimmed);
	};

	return (
		<View
			testID="mobile-auth-required"
			class="flex-1 items-center justify-center bg-background p-6"
			style={{
				paddingTop: Math.max(24, safeArea().top + 16),
				paddingBottom: Math.max(24, safeArea().bottom + 16),
			}}
		>
			<View
				class="w-full max-w-sm gap-4 rounded-2xl border border-border bg-card p-6"
				style={{ boxShadow: styleVar("pilo-shadow-sm") }}
			>
				<View class="items-center">
					<Icon name="WifiOff" size={24} color={token("muted-foreground")} />
					<Text
						class="mt-4 text-center font-sans font-semibold text-foreground"
						style={MOBILE_TEXT.base}
					>
						Pilo Remote
					</Text>
					<Text
						class="mt-2 text-center font-sans text-muted-foreground"
						style={MOBILE_TEXT.smRelaxed}
					>
						{() => props.error?.() || t("settings.remotePairRequired")}
					</Text>
				</View>

				<Button
					testID="mobile-toggle-token-input"
					variant="outline"
					class="min-h-11 w-full"
					onPress={() => showTokenInput.update((v) => !v)}
				>
					<Text class="font-sans text-foreground" style={MOBILE_TEXT.sm}>
						{() => (showTokenInput() ? t("common.cancel") : "Device Token")}
					</Text>
				</Button>

				{() =>
					showTokenInput() ? (
						<View class="gap-2">
							<Input
								testID="mobile-token-input"
								value={tokenDraft()}
								placeholder="Device token..."
								autoCorrect={false}
								autoCapitalize="none"
								class="min-h-11"
								onChange={(event) => tokenDraft.set(event.value)}
								onSubmit={submit}
							/>
							<Button
								testID="mobile-token-submit"
								variant="default"
								class="min-h-11 w-full"
								disabled={!tokenDraft().trim()}
								onPress={submit}
							>
								<Text
									class="font-sans font-medium text-primary-foreground"
									style={MOBILE_TEXT.sm}
								>
									{() => t("common.confirm")}
								</Text>
							</Button>
						</View>
					) : null
				}
			</View>
		</View>
	);
}

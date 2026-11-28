import {
	type Accessor,
	computed,
	createAnimatedValue,
	effect,
	Overlay,
	PanResponder,
	reduceMotion,
	Scroll,
	safeArea,
	signal,
	Text,
	token,
	untracked,
	View,
	windowSize,
} from "nsh";
import { Button as BaseButton } from "nsh/base";

import { isDefaultWorkspace, type Project } from "@shared/api/projects-types";
import type { SidebarSession } from "@shared/sidebar/sidebar-types";
import type { Theme } from "@shared/theme-settings-types";
import type { WebFontScalePreset } from "@shared/web-font-scale";

import { AppToaster } from "../app/shell/app-toasts";
import { setSessionArchivedWithToast } from "../app/shell/archive-session";
import {
	type ArchiveView,
	useArchivedSessions,
} from "../app/shell/archived-sessions";
import { connectionLabel } from "../app/shell/connection-label";
import { deleteSessionWithToast } from "../app/shell/delete-session";
import { t } from "../app/shell/i18n";
import { PiLogo } from "../app/shell/pi-logo";
import {
	recentSessions,
	sessionRowKey,
	sidebarGroups,
	sidebarSessions,
} from "../app/shell/sidebar-projects";
import {
	createSessionAgeClock,
	sessionAgeText,
} from "../app/shell/sidebar-session-age";
import type { WebRemoteConnectionState } from "./web-host-transport";
import type { AppStore } from "../app/state/app-store";
import { Button } from "../app/ui/button";
import { Icon, type IconName } from "../app/ui/icon";
import {
	chevronRotateStyle,
	MOTION,
	springTransition,
	tactileTransition,
} from "../app/ui/motion";
import { Spinner } from "../app/ui/spinner";
import { styleVar } from "../app/ui/theme-style";
import { menuListSpacing } from "../app/ui/menu";
import { MobileDropdownItem, MobileDropdownMenu } from "./mobile-dropdown-menu";
import { mobileSelectedRingStyle } from "./mobile-typography";
import { MobileViewport } from "./mobile-viewport";

export interface MobileDrawerProps {
	store: AppStore;
	open: Accessor<boolean>;
	onOpenChange: (open: boolean) => void;
	/** Live 0..1 drag progress while the user is swiping open from the workspace. */
	dragProgress?: Accessor<number | null>;
	/** Release velocity (in progress/sec) from the open swipe gesture. */
	dragVelocity?: Accessor<number>;
	connectionState: Accessor<WebRemoteConnectionState>;
	colorScheme?: Accessor<Theme>;
	onColorSchemeChange?: (scheme: Theme) => void;
	fontScale?: Accessor<WebFontScalePreset>;
	onFontScaleChange?: (scale: WebFontScalePreset) => void;
	onReconnect?: () => void;
	onSignOut?: () => void;
	onRenameSession?: (target: {
		projectId: string;
		sessionPath: string;
		title: string;
	}) => void;
	onOpenSearch?: () => void;
	onNewChat: (projectId?: string) => void;
	onDefaultWorkspaceShown?: (connectionId: string, shown: boolean) => void;
}

type DrawerTab = "projects" | "recent";

const MAX_DRAWER_WIDTH = 320;
const BACKDROP_RESERVE = 64;
const CLOSE_SWIPE_THRESHOLD = 64;
const CLOSE_SWIPE_VELOCITY = 350;
const DIRECTION_RATIO = 1.4;
const PROJECT_SESSION_BATCH_SIZE = 50;
const ROW_RADIUS_CLASS = "rounded-(--pilo-mobile-radius-md)";
const ROW_ACTION_CLASS = `size-11 shrink-0 ${ROW_RADIUS_CLASS} hover:bg-sidebar-hover active:bg-sidebar-hover`;

export function mobileDrawerWidth(viewportWidth: number): number {
	return Math.max(
		240,
		Math.min(MAX_DRAWER_WIDTH, viewportWidth - BACKDROP_RESERVE),
	);
}

function projectDisplayName(project: Project): string {
	return isDefaultWorkspace(project)
		? t("sidebar.defaultWorkspace")
		: project.name;
}

const COLOR_SCHEME_OPTIONS: readonly {
	value: Theme;
	icon: IconName;
	labelKey: "settings.system" | "settings.light" | "settings.dark";
}[] = [
	{ value: "system", icon: "Monitor", labelKey: "settings.system" },
	{ value: "light", icon: "Sun", labelKey: "settings.light" },
	{ value: "dark", icon: "Moon", labelKey: "settings.dark" },
];

function colorSchemeIcon(scheme: Theme): IconName {
	if (scheme === "dark") return "Moon";
	if (scheme === "light") return "Sun";
	return "Monitor";
}

function colorSchemeLabelKey(
	scheme: Theme,
): "settings.system" | "settings.light" | "settings.dark" {
	if (scheme === "dark") return "settings.dark";
	if (scheme === "light") return "settings.light";
	return "settings.system";
}

const FONT_SCALE_OPTIONS: readonly {
	value: WebFontScalePreset;
	labelKey:
		| "settings.textSizeSmall"
		| "settings.textSizeDefault"
		| "settings.textSizeLarge";
}[] = [
	{ value: "small", labelKey: "settings.textSizeSmall" },
	{ value: "default", labelKey: "settings.textSizeDefault" },
	{ value: "large", labelKey: "settings.textSizeLarge" },
];

function fontScaleLabelKey(
	scale: WebFontScalePreset,
):
	| "settings.textSizeSmall"
	| "settings.textSizeDefault"
	| "settings.textSizeLarge" {
	if (scale === "small") return "settings.textSizeSmall";
	if (scale === "large") return "settings.textSizeLarge";
	return "settings.textSizeDefault";
}

function connectionStatusLabel(state: WebRemoteConnectionState): string {
	switch (state) {
		case "connected":
			return t("settings.remoteConnected");
		case "offline":
			return t("settings.remoteOffline");
		default:
			return t("settings.remoteReconnecting");
	}
}

/**
 * Touch-first slide-out session drawer aligned with React's `RemoteMobileNavigation`:
 * - Rounded edge (theme-driven) + popover shadow + 40% backdrop scrim
 * - Search + Close header actions, New Session row, Projects / Recent segment toggle
 * - Environment, Project, and Session rows with 44pt+ touch targets, active/unread dots,
 *   per-session actions menu, inline delete confirmation, and batched session loading
 * - Footer with connection status, per-browser appearance switch, and sign out
 */
export function MobileDrawer(props: MobileDrawerProps) {
	const { store } = props;
	const viewport = MobileViewport();
	const toasts = AppToaster();
	const mode = signal<DrawerTab>("projects");
	const archiveView = signal<ArchiveView | null>(null);
	const archive = useArchivedSessions(props.store, archiveView);
	const showArchive = (view: ArchiveView | null) => {
		confirmingDeleteKey.set(null);
		archiveView.set(view);
	};
	const sectionOverrides = signal<Record<string, boolean>>({});
	const projectLimits = signal<Record<string, number>>({});
	const confirmingDeleteKey = signal<string | null>(null);
	const confirmingSignOut = signal(false);
	const mounted = signal(false);
	const sessionAgeNow = createSessionAgeClock(mounted);
	const segmentWidth = signal(0);
	const segmentThumbWidth = computed(() => {
		const width = segmentWidth();
		return width > 8 ? (width - 8) / 2 : 0;
	});

	const dockedSidebar = computed(
		() => token("pilo-mobile-selected-ring-width") === 0,
	);

	const drawerWidth = computed(() => mobileDrawerWidth(windowSize().width));

	// 0 = fully closed (-drawerWidth - shadow bleed), 1 = fully open (0).
	const progress = createAnimatedValue(0);
	const translateX = computed(() =>
		progress.interpolate({
			inputRange: [0, 1],
			outputRange: [-drawerWidth() - 24, 0],
			extrapolate: "clamp",
		}),
	);
	const backdropOpacity = progress.interpolate({
		inputRange: [0, 1],
		outputRange: [0, 0.4],
		extrapolate: "clamp",
	});

	let closeVelocity = 0;

	const settleOpen = (velocity = 0) => {
		if (reduceMotion()) {
			progress.set(1);
			return;
		}
		void progress.spring(1, { ...MOTION.spring.smooth, velocity });
	};

	const settleClosed = (velocity = 0) => {
		if (reduceMotion()) {
			progress.set(0);
			if (!props.open() && (props.dragProgress?.() ?? null) === null) {
				mounted.set(false);
			}
			return;
		}
		void progress
			.spring(0, { ...MOTION.spring.smooth, velocity })
			.then(({ finished }) => {
				if (
					finished &&
					!props.open() &&
					(props.dragProgress?.() ?? null) === null
				) {
					mounted.set(false);
				}
			});
	};

	effect(() => {
		const isOpen = props.open();
		const drag = props.dragProgress?.() ?? null;
		untracked(() => {
			if (drag !== null && !isOpen) {
				if (!mounted()) mounted.set(true);
				progress.set(Math.max(0, Math.min(1, drag)));
				return;
			}
			const openVelocity = props.dragVelocity?.() ?? 0;
			if (isOpen) {
				mounted.set(true);
				settleOpen(openVelocity);
			} else {
				confirmingDeleteKey.set(null);
				confirmingSignOut.set(false);
				if (!mounted()) return;
				const velocity = closeVelocity !== 0 ? closeVelocity : openVelocity;
				closeVelocity = 0;
				settleClosed(velocity);
			}
		});
	});

	const closePan = PanResponder.create({
		onMoveShouldSetPanResponder: (_event, gesture) =>
			props.open() &&
			gesture.numberActiveTouches === 1 &&
			gesture.dx < -10 &&
			Math.abs(gesture.dx) > Math.abs(gesture.dy) * DIRECTION_RATIO,
		onPanResponderMove: (_event, gesture) => {
			const width = drawerWidth();
			const ratio = Math.max(0, Math.min(1, 1 + gesture.dx / width));
			progress.set(ratio);
		},
		onPanResponderRelease: (_event, gesture) => {
			const width = drawerWidth();
			const normalizedVelocity = width > 0 ? gesture.vx / width : 0;
			if (
				-gesture.dx >= CLOSE_SWIPE_THRESHOLD ||
				(-gesture.dx >= 24 && gesture.vx < -CLOSE_SWIPE_VELOCITY)
			) {
				closeVelocity = normalizedVelocity;
				props.onOpenChange(false);
			} else {
				settleOpen(normalizedVelocity);
			}
		},
		onPanResponderTerminate: () => {
			if (props.open()) settleOpen(0);
		},
		onPanResponderTerminationRequest: () => false,
	});

	const close = () => props.onOpenChange(false);

	const activeProjectId = computed(() => store.state().navigation.projectId);
	const openSession = computed(() => store.state().navigation.session);
	const defaultWorkspaceShown = computed(
		() => store.state().preferences?.values.defaultWorkspaceVisibility ?? {},
	);
	const groups = computed(() => {
		const shown = defaultWorkspaceShown();
		return sidebarGroups(store.state().projects).map((group) => ({
			...group,
			projects: group.projects.filter(
				(project) =>
					!isDefaultWorkspace(project) || shown[group.connection.id] === true,
			),
		}));
	});
	const projectNameById = computed(
		() =>
			new Map(
				store
					.state()
					.projects.map((project) => [project.id, projectDisplayName(project)]),
			),
	);
	const drawerProjects = computed(() => store.state().projects);
	const drawerIndexes = computed(() => store.state().sessionIndexes);
	const drawerChats = computed(() => store.state().chatSessions);
	const drawerRunningSince = computed(() => store.state().runningSince);
	const drawerExternal = computed(() => store.state().externalActivity);
	const drawerReadStates = computed(() => store.state().readStates);
	const drawerPendingDrafts = computed(() => store.state().pendingDrafts);
	const drawerSentDrafts = computed(() => store.state().sentDrafts);
	const recent = computed(
		() => {
			// Keep the list current during drawer animations, but skip it when hidden.
			if (!mounted() || mode() !== "recent") return [];
			drawerProjects();
			drawerIndexes();
			drawerChats();
			drawerRunningSince();
			drawerExternal();
			drawerReadStates();
			drawerPendingDrafts();
			drawerSentDrafts();
			return recentSessions(untracked(store.state), t("app.newChat"));
		},
		{
			equals: (previous, next) =>
				previous.length === next.length &&
				previous.every((session, at) => session === next[at]),
		},
	);

	// Load sessions for the active project when the drawer opens.
	effect(() => {
		if (!props.open()) return;
		const projectId = activeProjectId();
		if (!projectId) return;
		const existing = untracked(() => store.state().sessionIndexes[projectId]);
		if (!existing) {
			void store.loadSessions(projectId);
		}
	});

	const toggleSection = (key: string, defaultExpanded: boolean) => {
		sectionOverrides.update((current) => ({
			...current,
			[key]: !(current[key] ?? defaultExpanded),
		}));
	};

	const isSessionSelected = (session: SidebarSession) => {
		const open = openSession();
		if (!open || open.projectId !== session.projectId) return false;
		return session.sessionPath
			? open.sessionPath === session.sessionPath
			: !open.sessionPath && open.sessionId === session.id;
	};

	const selectSession = (session: SidebarSession) => {
		confirmingDeleteKey.set(null);
		if (session.sessionPath) {
			store.selectSession(session.projectId, session.sessionPath);
		} else {
			store.selectDraft(session.projectId, session.id);
		}
		close();
	};

	const startNewChat = (projectId?: string) => {
		confirmingDeleteKey.set(null);
		props.onNewChat(projectId ?? activeProjectId() ?? undefined);
		close();
	};

	const selectedRingStyle = () => mobileSelectedRingStyle(dockedSidebar());

	const renderSessionRow = (
		session: SidebarSession,
		showProjectName = false,
	) => {
		const key = sessionRowKey(session);
		const selected = () => isSessionSelected(session);
		const unread =
			session.unread &&
			!store.isViewingSession(session.projectId, session.sessionPath);
		const confirming = () => confirmingDeleteKey() === key;
		const saved = session.sessionPath !== "";
		const archived = session.archivedAt != null;
		const age = computed(() =>
			sessionAgeText(session.latestMessageAt, sessionAgeNow()),
		);
		const projectName = showProjectName
			? projectNameById().get(session.projectId)
			: undefined;

		if (confirming()) {
			return (
				<View
					testID={`mobile-session-confirm:${session.id}`}
					class={`min-h-11 w-full flex-row items-center gap-2 ${ROW_RADIUS_CLASS} pl-2 pr-1 ${
						selected()
							? "bg-(--pilo-mobile-confirm-selected-background)"
							: "bg-sidebar"
					}`}
					style={selected() ? selectedRingStyle() : undefined}
				>
					{!archived && (
						<View class="h-5 w-4 shrink-0 items-center justify-center">
							{!session.active && unread ? (
								<View class="size-1.5 rounded-full bg-sidebar-primary" />
							) : null}
						</View>
					)}
					<Text
						class={`min-w-0 flex-1 truncate font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight ${
							selected()
								? "text-sidebar-selection-foreground"
								: "text-sidebar-foreground"
						}`}
					>
						{session.title}
					</Text>
					<View class="shrink-0 flex-row items-center">
						<Button
							variant="ghost"
							size="sm"
							class="h-11 px-2 hover:bg-sidebar-hover active:bg-sidebar-hover"
							onPress={() => confirmingDeleteKey.set(null)}
						>
							<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-sidebar-foreground">
								{() => t("common.cancel")}
							</Text>
						</Button>
						<Button
							testID={`mobile-session-confirm-delete:${session.id}`}
							variant="ghost"
							size="sm"
							class="h-11 px-2 hover:bg-sidebar-hover/40 active:bg-sidebar-hover/60"
							accessibilityLabel={`${t("common.delete")}: ${session.title}`}
							onPress={() => {
								confirmingDeleteKey.set(null);
								void deleteSessionWithToast(
									store,
									toasts,
									session.projectId,
									session.sessionPath,
								);
							}}
						>
							<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-destructive">
								{() =>
									session.active
										? t("sidebar.deleteRunningConfirm")
										: archived
											? t("sidebar.confirmDelete")
											: t("common.delete")
								}
							</Text>
						</Button>
					</View>
				</View>
			);
		}

		return (
			<View
				class={`min-h-11 w-full flex-row items-center ${ROW_RADIUS_CLASS} ${
					selected() ? "bg-(--pilo-mobile-selected-background)" : ""
				}`}
				style={selected() ? selectedRingStyle() : undefined}
			>
				<BaseButton
					testID={`mobile-session:${session.id}`}
					class={`min-w-0 flex-1 flex-row gap-2 ${ROW_RADIUS_CLASS} p-2 hover:bg-sidebar-hover active:bg-sidebar-hover ${
						projectName ? "min-h-14 items-start" : "min-h-11 items-center"
					}`}
					accessibilityLabel={
						age() ? `${session.title}, ${age()}` : session.title
					}
					onPress={() => selectSession(session)}
				>
					{!archived && (
						<View class="h-5 w-4 shrink-0 items-center justify-center">
							{!session.active && unread ? (
								<View class="size-1.5 rounded-full bg-sidebar-primary" />
							) : null}
						</View>
					)}
					<View class="min-w-0 flex-1">
						<Text
							testID={`mobile-session-title:${session.id}`}
							class={`min-w-0 truncate font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight ${
								selected() || unread ? "font-medium" : ""
							} ${
								selected()
									? "text-sidebar-selection-foreground"
									: "text-sidebar-foreground"
							}`}
						>
							{session.title}
						</Text>
						{projectName ? (
							<View class="mt-1 flex-row items-center gap-1.5">
								<Icon
									name="Folder"
									size={12}
									class="opacity-80"
									color={token("sidebar-foreground-muted")}
								/>
								<Text class="min-w-0 flex-1 truncate font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-sidebar-foreground-muted">
									{projectName}
								</Text>
							</View>
						) : null}
					</View>
					<View class="h-5 shrink-0 flex-row items-center gap-1">
						{session.active ? (
							<View class="size-1.5 animate-pulse rounded-full bg-sidebar-primary" />
						) : archived && unread ? (
							<View class="size-1.5 rounded-full bg-sidebar-primary" />
						) : null}
						{() =>
							age() ? (
								<Text class="shrink-0 whitespace-nowrap font-sans text-xs text-(length:--pilo-ui-text-xs) tabular-nums text-sidebar-foreground-muted">
									{age}
								</Text>
							) : null
						}
					</View>
				</BaseButton>
				{saved && archived ? (
					<>
						<Button
							testID={`mobile-session-unarchive:${session.id}`}
							variant="ghost"
							size="icon"
							class={ROW_ACTION_CLASS}
							accessibilityLabel={t("sidebar.unarchive")}
							onPress={() =>
								void setSessionArchivedWithToast(
									store,
									toasts,
									session.projectId,
									session.sessionPath,
									false,
								)
							}
						>
							<Icon
								name="ArchiveRestore"
								size={16}
								color={token("sidebar-foreground-muted")}
							/>
						</Button>
						<Button
							testID={`mobile-session-delete:${session.id}`}
							variant="ghost"
							size="icon"
							class={ROW_ACTION_CLASS}
							accessibilityLabel={t("sidebar.delete")}
							onPress={() => confirmingDeleteKey.set(key)}
						>
							<Icon
								name="Trash2"
								size={16}
								color={token("sidebar-foreground-muted")}
							/>
						</Button>
					</>
				) : saved ? (
					<MobileDropdownMenu
						align="end"
						popupClass="w-44"
						popupStyle={{ zIndex: 90 }}
						trigger={
							<Button
								testID={`mobile-session-menu:${session.id}`}
								variant="ghost"
								size="icon"
								class={ROW_ACTION_CLASS}
								accessibilityLabel={t("sidebar.moreActions")}
							>
								<Icon
									name="MoreHorizontal"
									size={16}
									color={token("sidebar-foreground-muted")}
								/>
							</Button>
						}
					>
						<View class="gap-1">
							{props.onRenameSession ? (
								<MobileDropdownItem
									testID={`mobile-session-rename:${session.id}`}
									icon={<Icon name="Pencil" size={14} />}
									onSelect={() => {
										close();
										props.onRenameSession?.({
											projectId: session.projectId,
											sessionPath: session.sessionPath,
											title: session.title,
										});
									}}
								>
									<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight">
										{() => t("sidebar.rename")}
									</Text>
								</MobileDropdownItem>
							) : null}
							<MobileDropdownItem
								testID={`mobile-session-refresh:${session.id}`}
								icon={<Icon name="RefreshCw" size={14} />}
								disabled={session.active}
								onSelect={() => void store.loadSessions(session.projectId)}
							>
								<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight">
									{() => t("chat.refreshSession")}
								</Text>
							</MobileDropdownItem>
							<MobileDropdownItem
								testID={`mobile-session-archive:${session.id}`}
								icon={<Icon name="Archive" size={14} />}
								disabled={session.active}
								onSelect={() =>
									void setSessionArchivedWithToast(
										store,
										toasts,
										session.projectId,
										session.sessionPath,
										true,
									)
								}
							>
								<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight">
									{() =>
										t(
											session.active
												? "sidebar.archiveRunning"
												: "sidebar.archive",
										)
									}
								</Text>
							</MobileDropdownItem>
							<MobileDropdownItem
								testID={`mobile-session-delete:${session.id}`}
								variant="destructive"
								icon={<Icon name="Trash2" size={14} />}
								onSelect={() => confirmingDeleteKey.set(key)}
							>
								<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight">
									{() => t("common.delete")}
								</Text>
							</MobileDropdownItem>
						</View>
					</MobileDropdownMenu>
				) : null}
			</View>
		);
	};

	return (
		<>
			{() =>
				mounted() ? (
					<Overlay
						onCancel={() => {
							if (!props.open()) return;
							if (archiveView()) showArchive(null);
							else close();
						}}
						class="absolute inset-0"
						style={{
							zIndex: 80,
							pointerEvents: props.open() ? "auto" : "none",
						}}
					>
						<View class="relative flex-1">
							<View
								testID="mobile-drawer-backdrop"
								class="absolute inset-0 bg-black"
								style={{ opacity: backdropOpacity }}
								onPress={close}
							/>
							<View
								testID="mobile-drawer"
								{...closePan.panHandlers}
								panActivation={{ activeOffsetX: 14, failOffsetY: 12 }}
								class="absolute inset-y-0 left-0 flex-col overflow-hidden border-r border-sidebar-border/60 bg-sidebar"
								style={{
									width: drawerWidth(),
									borderTopRightRadius: dockedSidebar() ? 0 : 12,
									borderBottomRightRadius: dockedSidebar() ? 0 : 12,
									boxShadow: styleVar("pilo-shadow-popover"),
									paddingTop: viewport.safeAreaTop(),
									paddingBottom: Math.max(8, safeArea().bottom),
									paddingLeft: safeArea().left,
									transform: [{ translateX: translateX() }],
								}}
							>
								{/* Header */}
								<View class="min-h-14 shrink-0 flex-row items-center pl-4 pr-3">
									<View class="min-w-0 flex-1 flex-row items-center gap-2.5">
										<View
											accessible={false}
											class="size-7 shrink-0 items-center justify-center rounded-[7px]"
											style={{
												backgroundColor: `color-mix(in srgb, ${token("sidebar-foreground")} 8%, transparent)`,
											}}
										>
											<PiLogo
												size={15}
												trim
												color={token("sidebar-selection-foreground")}
											/>
										</View>
										<Text class="min-w-0 shrink truncate font-sans text-xl text-(length:--pilo-ui-text-xl) leading-none font-bold tracking-tight text-sidebar-selection-foreground">
											Pilo
										</Text>
									</View>
									{props.onOpenSearch ? (
										<Button
											testID="mobile-drawer-search"
											variant="ghost"
											size="icon"
											class={ROW_ACTION_CLASS}
											accessibilityLabel={t("sidebar.searchSessions")}
											onPress={() => {
												close();
												props.onOpenSearch?.();
											}}
										>
											<Icon
												name="Search"
												size={16}
												color={token("sidebar-foreground-muted")}
											/>
										</Button>
									) : null}
									<Button
										testID="mobile-drawer-close"
										variant="ghost"
										size="icon"
										class={ROW_ACTION_CLASS}
										accessibilityLabel={t("common.close")}
										onPress={close}
									>
										<Icon
											name="X"
											size={16}
											color={token("sidebar-foreground-muted")}
										/>
									</Button>
								</View>

								{() =>
									archiveView() ? (
										<View class="shrink-0 px-3 pb-1">
											<BaseButton
												testID="mobile-drawer-archived-back"
												class={`min-h-11 w-full flex-row items-center gap-2 ${ROW_RADIUS_CLASS} px-2 hover:bg-sidebar-hover active:bg-sidebar-hover`}
												onPress={() => showArchive(null)}
											>
												<Icon name="ArrowLeft" size={16} />
												<Text class="min-w-0 flex-1 truncate font-sans text-sidebar-foreground">
													{() => {
														const id = archiveView()?.projectId;
														const name = id && projectNameById().get(id);
														return name
															? `${t("sidebar.archivedSessions")} · ${name}`
															: t("sidebar.archivedSessions");
													}}
												</Text>
											</BaseButton>
										</View>
									) : (
										<>
											{/* New Session button */}
											<View class="shrink-0 px-3 pb-2">
												<BaseButton
													testID="mobile-drawer-new-session"
													class={`min-h-11 w-full flex-row items-center gap-2.5 ${ROW_RADIUS_CLASS} px-3 active:bg-sidebar-hover`}
													style={{
														backgroundColor: `color-mix(in srgb, ${token("sidebar-foreground")} 7%, transparent)`,
													}}
													accessibilityLabel={t("sidebar.newSession")}
													onPress={() => startNewChat()}
												>
													<Icon
														name="SquarePen"
														size={16}
														strokeWidth={1.5}
														color={token("sidebar-foreground-muted")}
													/>
													<Text class="truncate font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight font-medium text-sidebar-selection-foreground">
														{() => t("sidebar.newSession")}
													</Text>
												</BaseButton>
											</View>

											{/* Projects / Recent segment toggle (40px track inside 44px touch target) */}
											<View
												testID="mobile-drawer-segments"
												class="relative mx-3 mb-2 h-11 shrink-0 flex-row px-1"
												onLayout={({ bounds }) =>
													segmentWidth.set(bounds.size.width)
												}
											>
												<View class="pointer-events-none absolute inset-x-0 inset-y-0.5 rounded-(--pilo-segment-radius) bg-sidebar-hover/60" />
												{() =>
													segmentThumbWidth() > 0 ? (
														<View
															class="pointer-events-none absolute inset-y-1 left-1 rounded-(--pilo-segment-item-radius) bg-sidebar"
															style={[
																springTransition("transform", "crisp"),
																{
																	width: segmentThumbWidth(),
																	transform: [
																		{
																			translateX:
																				mode() === "recent"
																					? segmentThumbWidth()
																					: 0,
																		},
																	],
																},
															]}
														/>
													) : null
												}
												{(
													[
														{
															value: "projects",
															label: () => t("sidebar.projects"),
														},
														{
															value: "recent",
															label: () => t("sidebar.recentSessions"),
														},
													] as const
												).map((tab) => (
													<BaseButton
														testID={`mobile-drawer-tab:${tab.value}`}
														class={`relative min-w-0 flex-1 items-center justify-center rounded-(--pilo-segment-item-radius) px-2 ${
															segmentThumbWidth() === 0 && mode() === tab.value
																? "my-1 h-9 bg-sidebar"
																: "h-11"
														}`}
														accessibilityLabel={tab.label()}
														onPress={() => mode.set(tab.value)}
													>
														<Text
															class={`truncate font-sans text-xs text-(length:--pilo-ui-text-xs) leading-tight font-medium ${
																mode() === tab.value
																	? "text-sidebar-foreground"
																	: "text-sidebar-foreground-muted"
															}`}
															style={tactileTransition("color")}
														>
															{tab.label}
														</Text>
													</BaseButton>
												))}
											</View>

											<BaseButton
												testID="mobile-drawer-archived"
												class={`mx-3 mb-2 min-h-11 shrink-0 flex-row items-center gap-2 ${ROW_RADIUS_CLASS} px-2 hover:bg-sidebar-hover active:bg-sidebar-hover`}
												onPress={() => showArchive({})}
											>
												<Icon
													name="Archive"
													size={16}
													color={token("sidebar-foreground-muted")}
												/>
												<Text class="font-sans text-sm text-sidebar-foreground">
													{() => t("sidebar.archived")}
												</Text>
											</BaseButton>
										</>
									)
								}
								{/* Scrollable sessions list */}
								<Scroll
									testID="mobile-drawer-scroll"
									class="min-h-0 flex-1"
									contentClass="gap-3 px-3 pb-4"
									bounces={false}
								>
									{() => {
										if (archiveView()) {
											const groups = archive.groups();
											const loading = archive.loading();
											const failed = archive.failed();
											return (
												<View
													testID="mobile-drawer-archived-sessions"
													class="gap-3"
												>
													{groups.map(({ project, sessions }) => (
														<View class="gap-1">
															{archiveView()?.projectId === undefined && (
																<View class="px-2">
																	<Text
																		testID={`mobile-drawer-archived-project:${project.id}`}
																		class="truncate font-sans text-sm font-medium text-sidebar-foreground-muted"
																	>
																		{projectDisplayName(project)}
																	</Text>
																</View>
															)}
															{sessions.map((session) =>
																renderSessionRow(session),
															)}
														</View>
													))}
													{(loading || failed || groups.length === 0) && (
														<Text class="px-3 py-6 text-center font-sans text-sm text-sidebar-foreground-muted">
															{t(
																loading
																	? "sidebar.refreshingSessions"
																	: failed
																		? "sidebar.loadArchivedFailed"
																		: "sidebar.noArchivedSessions",
															)}
														</Text>
													)}
												</View>
											);
										}
										if (mode() === "recent") {
											const items = recent();
											if (items.length === 0) {
												return (
													<Text class="px-3 py-10 text-center font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-sidebar-foreground-muted">
														{() => t("sidebar.noSessions")}
													</Text>
												);
											}
											return (
												<View class="gap-1">
													{items.map((session) =>
														renderSessionRow(session, true),
													)}
												</View>
											);
										}

										const envGroups = groups();
										if (envGroups.length === 0) {
											return (
												<Text class="px-3 py-10 text-center font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-sidebar-foreground-muted">
													{() => t("sidebar.noSessions")}
												</Text>
											);
										}

										return (
											<View class="gap-3">
												{envGroups.map((group) => {
													const envKey = `env:${group.connection.id}`;
													const envExpanded =
														sectionOverrides()[envKey] ?? true;
													const envName = connectionLabel(group.connection);
													const envIcon =
														group.connection.kind.type === "ssh"
															? "Server"
															: "Monitor";
													const defaultShown =
														defaultWorkspaceShown()[group.connection.id] ===
														true;
													return (
														<View class="gap-1">
															<View class="min-h-11 flex-row items-center">
																<BaseButton
																	class={`min-h-11 min-w-0 flex-1 flex-row items-center gap-2 ${ROW_RADIUS_CLASS} px-2 hover:bg-sidebar-hover active:bg-sidebar-hover`}
																	onPress={() => toggleSection(envKey, true)}
																>
																	<Icon
																		name={envIcon}
																		size={16}
																		color={token("sidebar-foreground-muted")}
																	/>
																	<Text class="min-w-0 flex-1 truncate font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug font-medium text-sidebar-foreground-muted">
																		{envName}
																	</Text>
																	<View
																		class="h-5 w-4 shrink-0 items-center justify-center"
																		style={chevronRotateStyle(
																			envExpanded,
																			0,
																			90,
																		)}
																	>
																		<Icon
																			name="ChevronRight"
																			size={14}
																			color={token("sidebar-foreground-muted")}
																		/>
																	</View>
																</BaseButton>
																<MobileDropdownMenu
																	align="end"
																	popupClass="w-52"
																	popupStyle={{ zIndex: 90 }}
																	trigger={
																		<Button
																			testID={`mobile-env-menu:${group.connection.id}`}
																			variant="ghost"
																			size="icon"
																			class={ROW_ACTION_CLASS}
																			accessibilityLabel={t(
																				"sidebar.connectionMenu",
																			)}
																		>
																			<Icon
																				name="MoreHorizontal"
																				size={16}
																				color={token(
																					"sidebar-foreground-muted",
																				)}
																			/>
																		</Button>
																	}
																>
																	<MobileDropdownItem
																		testID={`mobile-env-default-workspace:${group.connection.id}`}
																		class="gap-2 px-2"
																		checked={defaultShown}
																		disabled={!props.onDefaultWorkspaceShown}
																		onSelect={() =>
																			props.onDefaultWorkspaceShown?.(
																				group.connection.id,
																				!defaultShown,
																			)
																		}
																	>
																		<Text class="min-w-0 flex-1 font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight">
																			{() => t("sidebar.showDefaultWorkspace")}
																		</Text>
																	</MobileDropdownItem>
																</MobileDropdownMenu>
															</View>
															{envExpanded ? (
																<View class="gap-1">
																	{group.projects.map((project) => {
																		const projKey = `project:${project.id}`;
																		const isSelectedProject =
																			activeProjectId() === project.id;
																		const projExpanded =
																			sectionOverrides()[projKey] ??
																			isSelectedProject;
																		const index =
																			store.state().sessionIndexes[project.id];
																		const loading = index?.status === "loading";
																		const sessions = projExpanded
																			? sidebarSessions(
																					store.state(),
																					project.id,
																					t("app.newChat"),
																				)
																			: [];
																		const sessionCount = projExpanded
																			? sessions.length
																			: (index?.sessions.filter(
																					(entry) => entry.archivedAt == null,
																				).length ?? 0);
																		const visibleLimit = Math.min(
																			sessions.length,
																			projectLimits()[project.id] ??
																				PROJECT_SESSION_BATCH_SIZE,
																		);
																		return (
																			<View>
																				<View
																					class={`min-h-11 flex-row items-center ${ROW_RADIUS_CLASS} ${
																						isSelectedProject
																							? "bg-(--pilo-mobile-selected-background)"
																							: ""
																					}`}
																					style={
																						isSelectedProject
																							? selectedRingStyle()
																							: undefined
																					}
																				>
																					<BaseButton
																						testID={`mobile-project:${project.id}`}
																						class={`min-h-11 min-w-0 flex-1 flex-row items-center gap-2 ${ROW_RADIUS_CLASS} px-2 hover:bg-sidebar-hover active:bg-sidebar-hover`}
																						onPress={() => {
																							toggleSection(
																								projKey,
																								isSelectedProject,
																							);
																							if (!projExpanded) {
																								void store.loadSessions(
																									project.id,
																								);
																							}
																						}}
																					>
																						<Icon
																							name="Folder"
																							size={16}
																							color={token(
																								"sidebar-foreground-muted",
																							)}
																						/>
																						<Text
																							class={`min-w-0 flex-1 truncate font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-sidebar-foreground ${
																								isSelectedProject
																									? "font-semibold"
																									: "font-medium"
																							}`}
																						>
																							{projectDisplayName(project)}
																						</Text>
																						{loading ? (
																							<Spinner
																								size={14}
																								color={token(
																									"sidebar-foreground-muted",
																								)}
																							/>
																						) : sessionCount > 0 ? (
																							<Text class="shrink-0 font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug tabular-nums text-sidebar-foreground-muted">
																								{String(sessionCount)}
																							</Text>
																						) : null}
																						<View
																							class="h-5 w-4 shrink-0 items-center justify-center"
																							style={chevronRotateStyle(
																								projExpanded,
																								0,
																								90,
																							)}
																						>
																							<Icon
																								name="ChevronRight"
																								size={14}
																								color={token(
																									"sidebar-foreground-muted",
																								)}
																							/>
																						</View>
																					</BaseButton>
																					<Button
																						testID={`mobile-project-archived:${project.id}`}
																						variant="ghost"
																						size="icon"
																						class={ROW_ACTION_CLASS}
																						accessibilityLabel={t(
																							"sidebar.archivedSessions",
																						)}
																						onPress={() =>
																							showArchive({
																								projectId: project.id,
																							})
																						}
																					>
																						<Icon
																							name="Archive"
																							size={16}
																							color={token(
																								"sidebar-foreground-muted",
																							)}
																						/>
																					</Button>
																					<Button
																						testID={`mobile-project-new:${project.id}`}
																						variant="ghost"
																						size="icon"
																						class={ROW_ACTION_CLASS}
																						accessibilityLabel={t(
																							"sidebar.newSession",
																						)}
																						onPress={() =>
																							startNewChat(project.id)
																						}
																					>
																						<Icon
																							name="SquarePen"
																							size={16}
																							color={token(
																								"sidebar-foreground-muted",
																							)}
																						/>
																					</Button>
																				</View>
																				{projExpanded ? (
																					sessions.length === 0 ? (
																						loading ? (
																							<Text class="py-4 pl-8 pr-2 font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-sidebar-foreground-muted">
																								{() => t("common.loading")}
																							</Text>
																						) : (
																							<BaseButton
																								testID={`mobile-project-empty-new:${project.id}`}
																								class={`mt-1 min-h-11 flex-row items-center gap-2 ${ROW_RADIUS_CLASS} pl-8 pr-2 hover:bg-sidebar-hover active:bg-sidebar-hover`}
																								onPress={() =>
																									startNewChat(project.id)
																								}
																							>
																								<Icon
																									name="SquarePen"
																									size={14}
																									color={token(
																										"sidebar-foreground-muted",
																									)}
																								/>
																								<Text class="min-w-0 flex-1 truncate font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-sidebar-foreground-muted">
																									{() =>
																										`${t("sidebar.noSessions")} · ${t("sidebar.newSession")}`
																									}
																								</Text>
																							</BaseButton>
																						)
																					) : (
																						<View class="mt-1 gap-1 pb-2">
																							{sessions
																								.slice(0, visibleLimit)
																								.map((session) =>
																									renderSessionRow(session),
																								)}
																							{sessions.length >
																							PROJECT_SESSION_BATCH_SIZE ? (
																								<View class="items-center gap-1 pt-1">
																									<Text class="px-2 text-center font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-sidebar-foreground-muted">
																										{t(
																											"sidebar.loadedSessionCount",
																											{
																												visible: visibleLimit,
																												total: sessions.length,
																											},
																										)}
																									</Text>
																									{visibleLimit <
																									sessions.length ? (
																										<Button
																											variant="ghost"
																											size="sm"
																											class="min-h-10 px-3"
																											onPress={() =>
																												projectLimits.update(
																													(current) => ({
																														...current,
																														[project.id]:
																															visibleLimit +
																															PROJECT_SESSION_BATCH_SIZE,
																													}),
																												)
																											}
																										>
																											<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-sidebar-foreground-muted">
																												{() =>
																													t("sidebar.viewAll")
																												}
																											</Text>
																										</Button>
																									) : null}
																								</View>
																							) : null}
																						</View>
																					)
																				) : null}
																			</View>
																		);
																	})}
																</View>
															) : null}
														</View>
													);
												})}
											</View>
										);
									}}
								</Scroll>

								{/* Footer: connection status & sign out */}
								<View class="mx-3 min-h-14 shrink-0 flex-row items-center gap-1 border-t border-sidebar-border/60 px-2 pt-1">
									{() => {
										if (props.onSignOut && confirmingSignOut()) {
											return (
												<View class="min-w-0 flex-1 flex-row items-center justify-end gap-1">
													<Button
														testID="mobile-drawer-signout-cancel"
														variant="ghost"
														size="sm"
														class="h-11 px-3 hover:bg-sidebar-hover active:bg-sidebar-hover"
														onPress={() => confirmingSignOut.set(false)}
													>
														<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-sidebar-foreground-muted">
															{() => t("common.cancel")}
														</Text>
													</Button>
													<Button
														testID="mobile-drawer-signout-confirm"
														variant="ghost"
														size="sm"
														class="h-11 px-3 hover:bg-sidebar-hover active:bg-sidebar-hover"
														onPress={() => {
															confirmingSignOut.set(false);
															close();
															props.onSignOut?.();
														}}
													>
														<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-destructive">
															{() => t("settings.remoteSignOutConfirm")}
														</Text>
													</Button>
												</View>
											);
										}
										return (
											<>
												<BaseButton
													testID="mobile-drawer-connection"
													class={`min-h-11 min-w-0 flex-1 flex-row items-center gap-2 ${ROW_RADIUS_CLASS}`}
													onPress={() => {
														if (props.connectionState() !== "connected") {
															props.onReconnect?.();
														}
													}}
												>
													<Icon
														name={
															props.connectionState() === "connected"
																? "Wifi"
																: "WifiOff"
														}
														size={16}
														strokeWidth={1.5}
														color={token("sidebar-foreground-muted")}
													/>
													<Text class="min-w-0 flex-1 truncate font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-sidebar-foreground-muted">
														{() =>
															connectionStatusLabel(props.connectionState())
														}
													</Text>
												</BaseButton>
												{props.fontScale && props.onFontScaleChange ? (
													<MobileDropdownMenu
														placement="top"
														align="end"
														popupClass="w-40"
														trigger={
															<Button
																testID="mobile-drawer-font-scale"
																variant="ghost"
																size="icon"
																class={ROW_ACTION_CLASS}
																accessibilityLabel={`${t("settings.textSize")}: ${t(fontScaleLabelKey(props.fontScale()))}`}
															>
																<Icon
																	name="Type"
																	size={16}
																	color={token("sidebar-foreground-muted")}
																/>
															</Button>
														}
													>
														<View
															testID="mobile-drawer-font-scale-popup"
															style={menuListSpacing()}
														>
															{FONT_SCALE_OPTIONS.map((option) => (
																<MobileDropdownItem
																	testID={`mobile-drawer-font-scale:${option.value}`}
																	class="gap-2.5 px-2.5 py-1.5"
																	role="menuitemradio"
																	checked={props.fontScale?.() === option.value}
																	onSelect={() =>
																		props.onFontScaleChange?.(option.value)
																	}
																>
																	<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-foreground">
																		{() => t(option.labelKey)}
																	</Text>
																</MobileDropdownItem>
															))}
														</View>
													</MobileDropdownMenu>
												) : null}
												{props.colorScheme && props.onColorSchemeChange ? (
													<MobileDropdownMenu
														placement="top"
														align="end"
														popupClass="w-44"
														trigger={
															<Button
																testID="mobile-drawer-theme"
																variant="ghost"
																size="icon"
																class={ROW_ACTION_CLASS}
																accessibilityLabel={`${t("settings.theme")}: ${t(colorSchemeLabelKey(props.colorScheme()))}`}
															>
																<Icon
																	name={colorSchemeIcon(props.colorScheme())}
																	size={16}
																	color={token("sidebar-foreground-muted")}
																/>
															</Button>
														}
													>
														<View
															testID="mobile-drawer-theme-popup"
															style={menuListSpacing()}
														>
															{COLOR_SCHEME_OPTIONS.map((option) => (
																<MobileDropdownItem
																	testID={`mobile-drawer-theme:${option.value}`}
																	class="gap-2.5 px-2.5 py-1.5"
																	role="menuitemradio"
																	checked={
																		props.colorScheme?.() === option.value
																	}
																	icon={<Icon name={option.icon} size={14} />}
																	onSelect={() =>
																		props.onColorSchemeChange?.(option.value)
																	}
																>
																	<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-foreground">
																		{() => t(option.labelKey)}
																	</Text>
																</MobileDropdownItem>
															))}
														</View>
													</MobileDropdownMenu>
												) : null}
												{props.onSignOut ? (
													<Button
														testID="mobile-drawer-signout"
														variant="ghost"
														size="icon"
														class={ROW_ACTION_CLASS}
														accessibilityLabel={t("settings.remoteSignOut")}
														onPress={() => confirmingSignOut.set(true)}
													>
														<Icon
															name="LogOut"
															size={16}
															color={token("sidebar-foreground-muted")}
														/>
													</Button>
												) : null}
											</>
										);
									}}
								</View>
							</View>
						</View>
					</Overlay>
				) : null
			}
		</>
	);
}

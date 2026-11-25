import {
	type Accessor,
	computed,
	createAnimatedValue,
	effect,
	Overlay,
	PanResponder,
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

import { AppToaster } from "../app/shell/app-toasts";
import { deleteSessionWithToast } from "../app/shell/delete-session";
import { t } from "../app/shell/i18n";
import {
	recentSessions,
	sessionRowKey,
	sidebarGroups,
	sidebarSessions,
} from "../app/shell/sidebar-projects";
import type { WebRemoteConnectionState } from "./web-remote-client";
import type { AppStore } from "../app/state/app-store";
import { Button } from "../app/ui/button";
import { Icon } from "../app/ui/icon";
import { Spinner } from "../app/ui/spinner";
import { styleVar } from "../app/ui/theme-style";
import { MobileDropdownItem, MobileDropdownMenu } from "./mobile-dropdown-menu";
import { MOBILE_TEXT, mobileSelectedRingStyle } from "./mobile-typography";
import { MobileViewport } from "./mobile-viewport";

export interface MobileDrawerProps {
	store: AppStore;
	open: Accessor<boolean>;
	onOpenChange: (open: boolean) => void;
	/** Live 0..1 drag progress while the user is swiping open from the workspace. */
	dragProgress?: Accessor<number | null>;
	connectionState: Accessor<WebRemoteConnectionState>;
	onReconnect?: () => void;
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
 * - Footer with connection status (theme follows host settings automatically)
 */
export function MobileDrawer(props: MobileDrawerProps) {
	const { store } = props;
	const viewport = MobileViewport();
	const toasts = AppToaster();
	const mode = signal<DrawerTab>("projects");
	const sectionOverrides = signal<Record<string, boolean>>({});
	const projectLimits = signal<Record<string, number>>({});
	const confirmingDeleteKey = signal<string | null>(null);
	const mounted = signal(false);
	const segmentWidth = signal(0);
	const segmentThumbWidth = computed(() => {
		const width = segmentWidth();
		return width > 8 ? (width - 8) / 2 : 0;
	});

	const dockedSidebar = computed(
		() => token("pilo-mobile-selected-ring-width") === 0,
	);

	const drawerWidth = computed(() => mobileDrawerWidth(windowSize().width));

	// 0 = fully closed (-drawerWidth), 1 = fully open (0).
	const progress = createAnimatedValue(0);
	const translateX = computed(() =>
		progress.interpolate({
			inputRange: [0, 1],
			outputRange: [-drawerWidth(), 0],
			extrapolate: "clamp",
		}),
	);
	const backdropOpacity = progress.interpolate({
		inputRange: [0, 1],
		outputRange: [0, 0.4],
		extrapolate: "clamp",
	});

	effect(() => {
		const isOpen = props.open();
		const drag = props.dragProgress?.() ?? null;
		untracked(() => {
			if (drag !== null && !isOpen) {
				if (!mounted()) mounted.set(true);
				progress.set(Math.max(0, Math.min(1, drag)));
				return;
			}
			if (isOpen) {
				mounted.set(true);
				void progress.timing(1, { duration: 180, easing: "easeOut" });
			} else {
				confirmingDeleteKey.set(null);
				if (!mounted()) return;
				void progress
					.timing(0, { duration: 160, easing: "easeIn" })
					.then(({ finished }) => {
						if (
							finished &&
							!props.open() &&
							(props.dragProgress?.() ?? null) === null
						) {
							mounted.set(false);
						}
					});
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
			if (
				-gesture.dx >= CLOSE_SWIPE_THRESHOLD ||
				(-gesture.dx >= 24 && gesture.vx < -CLOSE_SWIPE_VELOCITY)
			) {
				props.onOpenChange(false);
			} else {
				void progress.timing(1, { duration: 160, easing: "easeOut" });
			}
		},
		onPanResponderTerminate: () => {
			if (props.open()) {
				void progress.timing(1, { duration: 160, easing: "easeOut" });
			}
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
	const recent = computed(() =>
		recentSessions(store.state(), t("app.newChat"), store.startedDraft()),
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
		const confirming = () => confirmingDeleteKey() === key;
		const saved = session.sessionPath !== "";
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
					<View class="h-5 w-4 shrink-0 items-center justify-center">
						{!session.active && session.unread ? (
							<View class="size-1.5 rounded-full bg-sidebar-primary" />
						) : null}
					</View>
					<Text
						class={`min-w-0 flex-1 truncate font-sans ${
							selected()
								? "text-sidebar-selection-foreground"
								: "text-sidebar-foreground"
						}`}
						style={MOBILE_TEXT.sm}
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
							<Text
								class="font-sans text-sidebar-foreground"
								style={MOBILE_TEXT.sm}
							>
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
							<Text class="font-sans text-destructive" style={MOBILE_TEXT.sm}>
								{() => t("common.delete")}
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
					accessibilityLabel={session.title}
					onPress={() => selectSession(session)}
				>
					<View class="h-5 w-4 shrink-0 items-center justify-center">
						{!session.active && session.unread ? (
							<View class="size-1.5 rounded-full bg-sidebar-primary" />
						) : null}
					</View>
					<View class="min-w-0 flex-1">
						<Text
							class={`min-w-0 truncate font-sans ${
								selected() || session.unread ? "font-medium" : ""
							} ${
								selected()
									? "text-sidebar-selection-foreground"
									: "text-sidebar-foreground"
							}`}
							style={MOBILE_TEXT.sm}
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
								<Text
									class="min-w-0 flex-1 truncate font-sans text-sidebar-foreground-muted"
									style={MOBILE_TEXT.xs}
								>
									{projectName}
								</Text>
							</View>
						) : null}
					</View>
					<View class="h-5 w-4 shrink-0 items-center justify-center">
						{session.active ? (
							<View class="size-1.5 animate-pulse rounded-full bg-sidebar-primary" />
						) : null}
					</View>
				</BaseButton>
				{saved ? (
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
							<MobileDropdownItem
								testID={`mobile-session-refresh:${session.id}`}
								icon={<Icon name="RefreshCw" size={14} />}
								disabled={session.active}
								onSelect={() => void store.loadSessions(session.projectId)}
							>
								<Text class="font-sans" style={MOBILE_TEXT.sm}>
									{() => t("chat.refreshSession")}
								</Text>
							</MobileDropdownItem>
							<MobileDropdownItem
								testID={`mobile-session-delete:${session.id}`}
								variant="destructive"
								icon={<Icon name="Trash2" size={14} />}
								onSelect={() => confirmingDeleteKey.set(key)}
							>
								<Text class="font-sans" style={MOBILE_TEXT.sm}>
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
						onCancel={close}
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
								<View class="min-h-14 shrink-0 flex-row items-center pl-5 pr-3">
									<Text
										class="min-w-0 flex-1 truncate font-sans font-semibold tracking-tight text-sidebar-foreground"
										style={MOBILE_TEXT.lg}
									>
										Pilo
									</Text>
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

								{/* New Session button */}
								<View class="shrink-0 px-3 pb-1">
									<BaseButton
										testID="mobile-drawer-new-session"
										class={`min-h-11 w-full flex-row items-center gap-2 ${ROW_RADIUS_CLASS} px-2 hover:bg-sidebar-hover active:bg-sidebar-hover`}
										accessibilityLabel={t("sidebar.newSession")}
										onPress={() => startNewChat()}
									>
										<Icon
											name="SquarePen"
											size={16}
											strokeWidth={1.5}
											color={token("sidebar-foreground")}
										/>
										<Text
											class="truncate font-sans text-sidebar-foreground"
											style={MOBILE_TEXT.sm}
										>
											{() => t("sidebar.newSession")}
										</Text>
									</BaseButton>
								</View>

								{/* Projects / Recent segment toggle (40px track inside 44px touch target) */}
								<View
									testID="mobile-drawer-segments"
									class="relative mx-3 mb-2 h-11 shrink-0 flex-row px-1"
									onLayout={({ bounds }) => segmentWidth.set(bounds.size.width)}
								>
									<View class="pointer-events-none absolute inset-x-0 inset-y-0.5 rounded-(--pilo-segment-radius) bg-sidebar-hover/60" />
									{() =>
										segmentThumbWidth() > 0 ? (
											<View
												class="pointer-events-none absolute inset-y-1 left-1 rounded-(--pilo-segment-item-radius) bg-sidebar transition-transform duration-150 ease-out"
												style={{
													width: segmentThumbWidth(),
													transform: [
														{
															translateX:
																mode() === "recent" ? segmentThumbWidth() : 0,
														},
													],
												}}
											/>
										) : null
									}
									{(
										[
											{ value: "projects", label: () => t("sidebar.projects") },
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
												class={`truncate font-sans font-medium ${
													mode() === tab.value
														? "text-sidebar-foreground"
														: "text-sidebar-foreground-muted"
												}`}
												style={MOBILE_TEXT.segment}
											>
												{tab.label}
											</Text>
										</BaseButton>
									))}
								</View>

								{/* Scrollable sessions list */}
								<Scroll
									testID="mobile-drawer-scroll"
									class="min-h-0 flex-1"
									contentClass="gap-3 px-3 pb-4"
									bounces={false}
								>
									{() => {
										if (mode() === "recent") {
											const items = recent();
											if (items.length === 0) {
												return (
													<Text
														class="px-3 py-10 text-center font-sans text-sidebar-foreground-muted"
														style={MOBILE_TEXT.sm}
													>
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
												<Text
													class="px-3 py-10 text-center font-sans text-sidebar-foreground-muted"
													style={MOBILE_TEXT.sm}
												>
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
													const envName =
														group.connection.kind.type === "local"
															? t("common.local")
															: group.connection.name;
													const envIcon =
														group.connection.kind.type === "ssh"
															? "Server"
															: "Monitor";
													const defaultShown =
														defaultWorkspaceShown()[group.connection.id] ===
														true;
													return (
														<View>
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
																	<Text
																		class="min-w-0 flex-1 truncate font-sans font-medium text-sidebar-foreground-muted"
																		style={MOBILE_TEXT.xs}
																	>
																		{envName}
																	</Text>
																	<View class="h-5 w-4 shrink-0 items-center justify-center">
																		<Icon
																			name={
																				envExpanded
																					? "ChevronDown"
																					: "ChevronRight"
																			}
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
																		<Text
																			class="min-w-0 flex-1 font-sans"
																			style={MOBILE_TEXT.sm}
																		>
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
																		const sessions = sidebarSessions(
																			store.state(),
																			project.id,
																			t("app.newChat"),
																			store.startedDraft(),
																		);
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
																							class={`min-w-0 flex-1 truncate font-sans text-sidebar-foreground ${
																								isSelectedProject
																									? "font-semibold"
																									: "font-medium"
																							}`}
																							style={MOBILE_TEXT.sm}
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
																						) : sessions.length > 0 ? (
																							<Text
																								class="shrink-0 font-sans tabular-nums text-sidebar-foreground-muted"
																								style={MOBILE_TEXT.xs}
																							>
																								{String(sessions.length)}
																							</Text>
																						) : null}
																						<View class="h-5 w-4 shrink-0 items-center justify-center">
																							<Icon
																								name={
																									projExpanded
																										? "ChevronDown"
																										: "ChevronRight"
																								}
																								size={14}
																								color={token(
																									"sidebar-foreground-muted",
																								)}
																							/>
																						</View>
																					</BaseButton>
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
																						<Text
																							class="py-4 pl-8 pr-2 font-sans text-sidebar-foreground-muted"
																							style={MOBILE_TEXT.sm}
																						>
																							{loading
																								? t("common.loading")
																								: t("sidebar.noSessions")}
																						</Text>
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
																									<Text
																										class="px-2 text-center font-sans text-sidebar-foreground-muted"
																										style={MOBILE_TEXT.xs}
																									>
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
																											<Text
																												class="font-sans text-sidebar-foreground-muted"
																												style={MOBILE_TEXT.xs}
																											>
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

								{/* Footer: connection status */}
								<View class="mx-3 min-h-14 shrink-0 flex-row items-center gap-2 border-t border-sidebar-border/60 px-2 pt-1">
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
										<Text
											class="min-w-0 flex-1 truncate font-sans text-sidebar-foreground-muted"
											style={MOBILE_TEXT.sm}
										>
											{() => connectionStatusLabel(props.connectionState())}
										</Text>
									</BaseButton>
								</View>
							</View>
						</View>
					</Overlay>
				) : null
			}
		</>
	);
}

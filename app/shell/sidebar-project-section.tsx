import {
	type Accessor,
	type Bounds,
	cleanup,
	computed,
	createMotion,
	effect,
	Overlay,
	reduceMotion,
	type Signal,
	signal,
	Text,
	token,
	untracked,
	View,
	type ViewRef,
} from "nsh";
import { Button, Collapsible } from "nsh/base";

import { userErrorMessage } from "@shared/app-error";
import { summarizeProjectSessions } from "@shared/sidebar/session-list";
import { chatSessionKey } from "@shared/api/chat-session-key";
import { isDefaultWorkspace, type Project } from "@shared/api/projects-types";
import { displayProjectPath } from "@shared/project-path";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import { AppToaster, showToast } from "./app-toasts";
import { Foreground } from "../ui/foreground";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import {
	chevronRotateStyle,
	collapsibleRevealProps,
	MOTION,
	tactileTransition,
} from "../ui/motion";
import { Spinner } from "../ui/spinner";
import { tooltipStyle } from "../ui/tooltip";
import { connectionLabel } from "./connection-label";
import { t } from "./i18n";
import { createHover } from "../ui/hover";
import {
	HOVER_ACTION,
	SidebarAction,
	sidebarFocusRing,
	sidebarForeground,
	sidebarProjectName,
	sidebarRowHeight,
	sidebarText,
} from "./sidebar-parts";
import {
	projectSection,
	sessionRowKey,
	sidebarSessions,
} from "./sidebar-projects";
import { SessionGlide, SessionGlideContext } from "./sidebar-session-glide";
import { SessionRow } from "./sidebar-session-row";
import type { SidebarSettingsStore } from "./sidebar-settings";

export function ProjectSection(props: {
	store: AppStore;
	settings: SidebarSettingsStore;
	onViewProject: (projectId: string) => void;
	onSelectChat?: (projectId: string) => void;
	project: Accessor<Project>;
}) {
	const { store, settings } = props;
	const toasts = AppToaster();
	const id = () => props.project().id;
	const name = () => sidebarProjectName(props.project());
	const selectProject = () => {
		props.onSelectChat?.(id());
		store.selectProject(id());
	};
	const section = () => projectSection(id());
	const collapsed = () =>
		settings.settings().collapsedSections[section()] ?? true;
	const selected = computed(() => {
		const open = store.openSession();
		if (open === null) return activeProject(store.state())?.id === id();
		// Once the draft has its own sidebar row, only that row is selected.
		return (
			open.projectId === id() &&
			open.sessionId !== undefined &&
			store.startedDraft() === null &&
			!store
				.state()
				.pendingDrafts.has(chatSessionKey(open.projectId, open.sessionId))
		);
	});
	// Reading the sessions again, as the WebUI row's `refreshing`.
	const refreshing = computed(
		() => store.state().sessionIndexes[id()]?.status === "loading",
	);
	const menuOpen = signal(false);
	const confirmingRemove = signal(false);
	const hover = createHover();
	const row = signal<ViewRef | null>(null);
	const detailsOpen = signal(false);
	let detailsTimer: ReturnType<typeof setTimeout> | undefined;
	const cancelDetailsTimer = () => clearTimeout(detailsTimer);
	cleanup(cancelDetailsTimer);
	const closeDetails = () => {
		cancelDetailsTimer();
		detailsOpen.set(false);
	};
	const scheduleCloseDetails = () => {
		cancelDetailsTimer();
		// Give the pointer time to cross the gap between the row and the panel.
		if (detailsOpen()) detailsTimer = setTimeout(closeDetails, 200);
	};
	const foreground = () => {
		if (selected()) return token("pilo-project-selected-foreground");
		if (refreshing()) return token("sidebar-foreground-muted");
		return hover.hovered() || menuOpen()
			? token("sidebar-hover-foreground")
			: sidebarForeground();
	};
	// A project that starts expanded has not read its sessions yet.
	effect(() => {
		if (collapsed()) return;
		const projectId = id();
		if (!untracked(() => store.state().sessionIndexes[projectId])) {
			void store.loadSessions(projectId);
		}
	});
	const toggle = () => {
		const expand = collapsed();
		void settings.setSectionCollapsed(section(), !expand);
		// Expanding a project reads its sessions again, as in the WebUI.
		if (expand) void store.loadSessions(id());
	};
	const rowClass = () => {
		const classes = [
			"group relative w-full min-w-0 flex-row items-center gap-1.5 rounded-md border border-transparent px-2 py-0.5",
		];
		if (selected()) {
			classes.push(
				"border-(--pilo-sidebar-selected-border) bg-(--pilo-sidebar-selected-background)",
			);
		} else if (refreshing()) {
			classes.push("hover:bg-transparent");
		} else {
			classes.push(menuOpen() ? "bg-sidebar-hover" : "hover:bg-sidebar-hover");
		}
		return classes.join(" ");
	};
	const hoverAction = () => (menuOpen() ? "opacity-100" : HOVER_ACTION);
	return (
		<View testID={section()} class="w-full min-w-0 gap-px">
			<Foreground.Provider value={foreground}>
				<View ref={row.set} testID={`${section()}:row`}>
					<Button
						testID={`${section()}:select`}
						onMouseEnter={() => {
							hover.props.onMouseEnter();
							cancelDetailsTimer();
							if (!detailsOpen() && !menuOpen()) {
								detailsTimer = setTimeout(
									() => detailsOpen.set(!menuOpen()),
									600,
								);
							}
						}}
						onMouseLeave={() => {
							hover.props.onMouseLeave();
							scheduleCloseDetails();
						}}
						class={rowClass()}
						style={{
							...tactileTransition("background-color, border-color"),
							minHeight: sidebarRowHeight("pilo-sidebar-project-height"),
						}}
						focusVisibleStyle={sidebarFocusRing()}
						selected={selected()}
						accessibilityLabel={
							refreshing()
								? t("sidebar.refreshingProject", { name: name() })
								: name()
						}
						onPressDown={closeDetails}
						onPress={() => {
							if (!refreshing()) selectProject();
						}}
					>
						<Button
							testID={`${section()}:toggle`}
							class="relative -mx-1 size-6 shrink-0 items-center justify-center rounded-sm"
							focusVisibleStyle={sidebarFocusRing()}
							disabled={refreshing()}
							accessibilityLabel={
								collapsed()
									? t("sidebar.expandProject")
									: t("sidebar.collapseProject")
							}
							onPress={toggle}
						>
							<View
								class="absolute opacity-80 group-hover:opacity-0"
								style={tactileTransition("opacity")}
							>
								<Icon name="Folder" size={14} />
							</View>
							<View
								class="absolute opacity-0 group-hover:opacity-100"
								style={[
									tactileTransition("opacity"),
									chevronRotateStyle(!collapsed(), -90, 0),
								]}
							>
								<Icon name="ChevronDown" size={14} />
							</View>
						</Button>
						<Text
							class="min-w-0 flex-1 truncate font-sans font-semibold"
							style={{ ...sidebarText("xs"), color: foreground() }}
						>
							{name}
						</Text>
						<View class="shrink-0 flex-row items-center gap-0.5">
							{() =>
								refreshing() ? (
									<View
										testID={`${section()}:loading`}
										class="size-6 items-center justify-center"
										accessibilityLabel={t("sidebar.refreshingSessions")}
									>
										<Spinner size={14} color={token("muted-foreground")} />
									</View>
								) : null
							}
							<ProjectMenu
								section={section}
								actionClass={hoverAction}
								refreshing={refreshing}
								open={menuOpen}
								removable={!isDefaultWorkspace(props.project())}
								confirmingRemove={confirmingRemove}
								onRefresh={() => void store.loadSessions(id())}
								onRemove={() =>
									void store.removeProject(id()).catch((error: unknown) => {
										console.error("Removing the project failed", error);
										showToast(toasts, {
											variant: "error",
											title: t("project.removeFailed"),
											description: userErrorMessage(error),
										});
									})
								}
							/>
							<SidebarAction
								testID={`${section()}:new-chat`}
								class={hoverAction()}
								label={t("sidebar.newSession")}
								onPress={selectProject}
							>
								<Icon name="SquarePen" size={14} />
							</SidebarAction>
						</View>
					</Button>
				</View>
			</Foreground.Provider>
			{() => {
				if (!detailsOpen() || menuOpen() || !row()) return null;
				const detailsMotion = createMotion({
					enter: reduceMotion()
						? {
								keyframes: { opacity: [0, 1] },
								duration: 80,
								easing: MOTION.easing.standardTuple,
							}
						: {
								keyframes: { opacity: [0, 1], scale: [0.97, 1] },
								duration: MOTION.duration.surfaceIn,
								easing: MOTION.easing.standardTuple,
							},
				});
				cleanup(() => detailsMotion.stop());
				return (
					<Overlay
						anchor={row()}
						placement="right"
						align="start"
						offset={4}
						margin={4}
						onCancel={closeDetails}
						onPressOutside={closeDetails}
						style={{ zIndex: token("z-tooltip") }}
					>
						<View
							class="max-w-[420px] gap-0.5 overflow-hidden rounded-(--pilo-radius-md) border border-(--pilo-tooltip-border) px-3 py-1.5"
							style={[tooltipStyle(), detailsMotion.style]}
							onMouseEnter={cancelDetailsTimer}
							onMouseLeave={scheduleCloseDetails}
						>
							<Text class="font-sans text-xs">
								{() => connectionLabel(props.project().connection)}
							</Text>
							<View selectable>
								<Text class="font-mono text-[11px] leading-snug">
									{() => displayProjectPath(props.project().path)}
								</Text>
							</View>
						</View>
					</Overlay>
				);
			}}
			<Collapsible
				open={!collapsed()}
				{...collapsibleRevealProps()}
				content={
					<ProjectSessions
						store={store}
						projectId={id}
						onSelectChat={props.onSelectChat}
						onViewAll={() => {
							props.onViewProject(id());
							void store.loadSessions(id());
						}}
					/>
				}
			/>
		</View>
	);
}

/** The ⋯ menu on a project row: refresh and remove. */
function ProjectMenu(props: {
	section: Accessor<string>;
	actionClass: Accessor<string>;
	refreshing: Accessor<boolean>;
	open: Signal<boolean>;
	/** The default workspace cannot be removed, as in the WebUI. */
	removable: boolean;
	confirmingRemove: Signal<boolean>;
	onRefresh: () => void;
	onRemove: () => void;
}) {
	const section = props.section;
	return (
		<Menu
			popupStyle={{ minWidth: 0 }}
			align="start"
			open={props.open()}
			onOpenChange={(event) => {
				props.open.set(event.open);
				if (!event.open) props.confirmingRemove.set(false);
			}}
			trigger={
				<SidebarAction
					testID={`${section()}:menu`}
					class={props.actionClass()}
					label={t("sidebar.projectMenu")}
				>
					<Icon name="MoreHorizontal" size={14} />
				</SidebarAction>
			}
		>
			<View class="gap-1">
				<MenuItem
					testID={`${section()}:menu:refresh`}
					indicatorClass="hidden"
					icon={<Icon name="RefreshCw" size={14} />}
					disabled={props.refreshing()}
					onSelect={props.onRefresh}
				>
					<Text class="font-sans">{() => t("sidebar.refreshSessions")}</Text>
				</MenuItem>
				{props.removable ? (
					<MenuItem
						testID={`${section()}:menu:remove`}
						indicatorClass="hidden"
						variant="destructive"
						icon={<Icon name="Trash2" size={14} />}
						disabled={props.refreshing()}
						closeOnSelect={false}
						onSelect={() => {
							if (!props.confirmingRemove()) {
								props.confirmingRemove.set(true);
								return;
							}
							props.confirmingRemove.set(false);
							props.open.set(false);
							props.onRemove();
						}}
					>
						<Text class="font-sans">
							{() =>
								props.confirmingRemove()
									? t("sidebar.confirmRemove")
									: t("sidebar.removeProject")
							}
						</Text>
					</MenuItem>
				) : null}
			</View>
		</Menu>
	);
}

/** An expanded project's latest sessions and its 「查看全部」. */
function ProjectSessions(props: {
	store: AppStore;
	projectId: Accessor<string>;
	onSelectChat?: (projectId: string) => void;
	onViewAll: () => void;
}) {
	const { store } = props;
	const section = () => projectSection(props.projectId());
	const index = computed(() => store.state().sessionIndexes[props.projectId()]);
	const externalActivity = computed(
		() => store.state().externalActivity[props.projectId()],
	);
	const projectChats = computed(
		() => {
			const pid = props.projectId();
			return store
				.state()
				.chatSessions.filter((chat) => chat.projectId === pid);
		},
		{
			equals: (previous, next) =>
				previous.length === next.length &&
				previous.every((chat, at) => chat === next[at]),
		},
	);
	const projectPendingDrafts = computed(
		() => {
			const pid = props.projectId();
			const result: string[] = [];
			for (const [key, draft] of store.state().pendingDrafts) {
				if (draft.projectId === pid) {
					result.push(`${key}:${draft.title}:${draft.startedAt}`);
				}
			}
			return result;
		},
		{
			equals: (previous, next) =>
				previous.length === next.length &&
				previous.every((item, at) => item === next[at]),
		},
	);
	const projectUnsentDrafts = computed(
		() => {
			const pid = props.projectId();
			const result: string[] = [];
			for (const [key, draft] of store.state().unsentDrafts ?? []) {
				if (draft.projectId === pid) {
					result.push(`${key}:${draft.title}:${draft.startedAt}`);
				}
			}
			return result;
		},
		{
			equals: (previous, next) =>
				previous.length === next.length &&
				previous.every((item, at) => item === next[at]),
		},
	);
	const projectRunningSince = computed(
		() => {
			const pid = props.projectId();
			const prefix = `[${JSON.stringify(pid)},`;
			const since = store.state().runningSince;
			const result: string[] = [];
			for (const key of Object.keys(since)) {
				if (key.startsWith(prefix)) result.push(`${key}:${since[key]}`);
			}
			return result;
		},
		{
			equals: (previous, next) =>
				previous.length === next.length &&
				previous.every((item, at) => item === next[at]),
		},
	);
	const projectReadStates = computed(
		() => {
			const pid = props.projectId();
			const states = store.state().readStates;
			const result: string[] = [];
			for (const key of Object.keys(states)) {
				const entry = states[key];
				if (entry.projectId === pid) {
					result.push(
						`${key}:${entry.completedRevision}:${entry.readRevision}`,
					);
				}
			}
			return result;
		},
		{
			equals: (previous, next) =>
				previous.length === next.length &&
				previous.every((item, at) => item === next[at]),
		},
	);
	// Switching between saved sessions never changes this project's unsaved draft row.
	const openDraftId = computed(() => {
		const open = store.openSession();
		return open?.projectId === props.projectId() && open.sessionId !== undefined
			? open.sessionId
			: null;
	});
	const listed = computed(() => {
		index();
		externalActivity();
		projectChats();
		projectPendingDrafts();
		projectUnsentDrafts();
		projectRunningSince();
		projectReadStates();
		openDraftId();
		return sidebarSessions(
			untracked(store.state),
			props.projectId(),
			t("app.newChat"),
			store.startedDraft(),
		);
	});
	const openedId = computed(() => {
		const open = store.openSession();
		if (open?.projectId !== props.projectId()) return null;
		if (!open.sessionPath) return open.sessionId ?? null;
		return (
			listed().find((session) => session.sessionPath === open.sessionPath)
				?.id ?? null
		);
	});
	const sessions = computed(
		() => summarizeProjectSessions(listed(), openedId()),
		{
			equals: (previous, next) =>
				previous.hiddenCount === next.hiddenCount &&
				previous.visible.length === next.visible.length &&
				previous.visible.every((session, at) => session === next.visible[at]),
		},
	);
	const hasSessions = computed(() => sessions().visible.length > 0);
	return (
		<>
			{() =>
				hasSessions() ? (
					<SessionGlide>
						<Each of={sessions().visible} key={sessionRowKey}>
							{(session) => (
								<SessionRow
									store={store}
									session={session}
									onSelectChat={props.onSelectChat}
								/>
							)}
						</Each>
						{() =>
							sessions().hiddenCount > 0 ? (
								<ViewAllRow
									testID={`${section()}:view-all`}
									onPress={props.onViewAll}
								/>
							) : null
						}
					</SessionGlide>
				) : null
			}
			{() => {
				const current = index();
				if (current?.status !== "failed" || current.sessions.length > 0) {
					return null;
				}
				return (
					<View
						testID={`${section()}:failed`}
						role="alert"
						class="items-center gap-1.5 px-3 py-2"
					>
						<Text
							class="text-center font-sans text-destructive"
							style={sidebarText("xs")}
						>
							{current.message ?? t("common.loadFailed")}
						</Text>
						<Button
							testID={`${section()}:retry`}
							class="rounded-md px-2 py-0.5 hover:bg-sidebar-hover"
							focusVisibleStyle={sidebarFocusRing()}
							accessibilityLabel={t("common.retry")}
							onPress={() => void store.loadSessions(props.projectId())}
						>
							<Text
								class="font-sans text-sidebar-foreground"
								style={sidebarText("xs")}
							>
								{() => t("common.retry")}
							</Text>
						</Button>
					</View>
				);
			}}
		</>
	);
}

/** 「查看全部」: opens the project's every session in the list. */
function ViewAllRow(props: { testID: string; onPress: () => void }) {
	const glide = SessionGlideContext();
	let bounds: Bounds | null = null;
	return (
		<View
			onLayout={(event) => {
				bounds = event.bounds;
			}}
			onMouseEnter={() => glide?.show(bounds)}
		>
			<Button
				testID={props.testID}
				class="group w-full flex-row items-center gap-1.5 rounded-md border border-transparent px-2 py-1"
				focusVisibleStyle={sidebarFocusRing()}
				onPress={props.onPress}
			>
				<View class="size-4 shrink-0" />
				<Text
					class="min-w-0 flex-1 truncate font-sans text-sidebar-foreground-muted group-hover:text-sidebar-hover-foreground"
					style={sidebarText("xs")}
				>
					{() => t("sidebar.viewAll")}
				</Text>
			</Button>
		</View>
	);
}

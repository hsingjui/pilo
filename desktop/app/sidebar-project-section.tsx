import {
	type Accessor,
	type Bounds,
	cleanup,
	computed,
	Overlay,
	type Signal,
	signal,
	Text,
	token,
	untracked,
	View,
	type ViewRef,
} from "nsh";
import { Button } from "nsh/base";

import { summarizeProjectSessions } from "@shared/sidebar/session-list";
import { isDefaultWorkspace, type Project } from "@shared/api/projects-types";
import { displayProjectPath } from "@shared/project-path";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import { Foreground } from "../ui/foreground";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { Spinner } from "../ui/spinner";
import { tooltipStyle } from "../ui/tooltip";
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
	isLocal,
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
	const id = () => props.project().id;
	const name = () => sidebarProjectName(props.project());
	const selectProject = () => {
		props.onSelectChat?.(id());
		store.selectProject(id());
	};
	const section = () => projectSection(id());
	const collapsed = () =>
		settings.settings().collapsedSections[section()] ?? true;
	const selected = () => {
		const state = store.state();
		const open = state.navigation.session;
		return (
			(open?.projectId === id() && open.sessionId !== undefined) ||
			(open === null && activeProject(state)?.id === id())
		);
	};
	// Reading the sessions again, as the Tauri row's `refreshing`.
	const refreshing = () =>
		store.state().sessionIndexes[id()]?.status === "loading";
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
	const toggle = () => {
		const expand = collapsed();
		void settings.setSectionCollapsed(section(), !expand);
		// Expanding a project reads its sessions again, as in the Tauri app.
		if (expand) void store.loadSessions(id());
	};
	const rowClass = () => {
		const classes = [
			"group relative w-full min-w-0 flex-row items-center gap-1.5 rounded-md border border-transparent px-2 py-0.5 transition-colors",
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
							<Icon
								name="Folder"
								size={14}
								class="absolute opacity-80 transition-opacity duration-100 group-hover:opacity-0"
							/>
							<Icon
								name="ChevronDown"
								size={14}
								class={`absolute opacity-0 transition duration-150 ease-out group-hover:opacity-100 ${
									collapsed() ? "-rotate-90" : ""
								}`}
							/>
						</Button>
						<Text
							class="min-w-0 flex-1 truncate font-sans font-semibold"
							style={{ ...sidebarText.xs, color: foreground() }}
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
			{() =>
				detailsOpen() && !menuOpen() && row() ? (
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
							style={tooltipStyle()}
							onMouseEnter={cancelDetailsTimer}
							onMouseLeave={scheduleCloseDetails}
						>
							<Text class="font-sans text-xs">
								{() =>
									isLocal(props.project().connection)
										? t("common.local")
										: props.project().connection.name
								}
							</Text>
							<View selectable>
								<Text class="font-mono text-[11px] leading-snug">
									{() => displayProjectPath(props.project().path)}
								</Text>
							</View>
						</View>
					</Overlay>
				) : null
			}
			{() =>
				collapsed() ? null : (
					<ProjectSessions
						store={store}
						projectId={id}
						onSelectChat={props.onSelectChat}
						onViewAll={() => {
							props.onViewProject(id());
							void store.loadSessions(id());
						}}
					/>
				)
			}
		</View>
	);
}

/** The ⋯ menu on a project row: refresh and remove. */
function ProjectMenu(props: {
	section: Accessor<string>;
	actionClass: Accessor<string>;
	refreshing: Accessor<boolean>;
	open: Signal<boolean>;
	/** The default workspace cannot be removed, as in the Tauri app. */
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
	const index = () => store.state().sessionIndexes[props.projectId()];
	// A project that starts expanded has not read its sessions yet.
	untracked(() => {
		if (!index()) void store.loadSessions(props.projectId());
	});
	const sessions = computed(() => {
		const state = store.state();
		const listed = sidebarSessions(
			state,
			props.projectId(),
			t("app.newChat"),
			store.startedDraft(),
		);
		const open = state.navigation.session;
		const opened =
			open?.projectId !== props.projectId()
				? undefined
				: open.sessionPath
					? listed.find((session) => session.sessionPath === open.sessionPath)
							?.id
					: open.sessionId;
		return summarizeProjectSessions(listed, opened ?? null);
	});
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
					<Text
						testID={`${section()}:failed`}
						role="alert"
						class="px-3 py-2 text-center font-sans text-destructive"
						style={sidebarText.xs}
					>
						{current.message ?? t("common.loadFailed")}
					</Text>
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
					style={sidebarText.xs}
				>
					{() => t("sidebar.viewAll")}
				</Text>
			</Button>
		</View>
	);
}

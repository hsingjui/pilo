import {
	type Accessor,
	colorScheme,
	computed,
	Scroll,
	type Signal,
	signal,
	Text,
	token,
	untracked,
	View,
} from "nsh";
import { Button } from "nsh/base";

import { summarizeProjectSessions } from "@/components/sidebar/session-list";
import type { SidebarSession } from "@/components/sidebar/types";
import { isDefaultWorkspace, type Project } from "@/lib/api/projects-types";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Foreground } from "../ui/foreground";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { MenuSeparator } from "../ui/menu-separator";
import { scrollbarLook } from "../ui/scrollbar";
import { Spinner } from "../ui/spinner";
import { t } from "./i18n";
import {
	connectionSection,
	isLocal,
	movedProjectOrder,
	projectSection,
	RECENT_SECTION,
	recentSessions,
	type SidebarGroup,
	sidebarGroups,
	sidebarSessions,
} from "./sidebar-projects";
import type { SidebarSettingsStore } from "./sidebar-settings";

export interface SidebarProps {
	store: AppStore;
	settings: SidebarSettingsStore;
}

const ROW =
	"min-h-(--pilo-sidebar-project-height) flex-row items-center gap-1.5 rounded-md border border-transparent px-2 py-0.5 hover:bg-sidebar-hover";
const SELECTED_ROW =
	"border-(--pilo-sidebar-selected-border) bg-(--pilo-sidebar-selected-background) hover:bg-(--pilo-sidebar-selected-background)";

/** An unselected row's text, which the dark sidebar dims as Tauri's does. */
const unselectedForeground = () =>
	colorScheme() === "dark"
		? `color-mix(in srgb, ${token("sidebar-foreground")} 75%, transparent)`
		: token("sidebar-foreground");

const focusRing = () =>
	focusRingStyle(token("sidebar-ring"), undefined, undefined, { width: 2 });

const SECTION_HEADER =
	"min-h-6.5 min-w-0 flex-1 flex-row items-center gap-2 rounded-md px-2";
const SECTION_TITLE =
	"min-w-0 shrink truncate font-sans text-sm font-medium text-sidebar-foreground-muted";

/**
 * The sidebar's list in the saved view: the projects by connection, each
 * with its latest sessions once expanded, or every project's latest
 * sessions as one list.
 */
export function Sidebar(props: SidebarProps) {
	// The groups change only with the projects, not with every state change.
	const projects = computed(() => props.store.state().projects);
	const groups = computed(() =>
		sidebarGroups(projects(), props.settings.settings().projectOrder),
	);
	const view = () => props.settings.settings().view;
	return (
		<Scroll
			testID="sidebar-projects"
			class="min-h-0 flex-1"
			scrollbar={{ vertical: scrollbarLook() }}
		>
			<View class="gap-3 pt-1 pr-2.5 pb-3 pl-1.5">
				{() =>
					view() === "recent" ? (
						<RecentSection {...props} projects={projects} />
					) : (
						<Each of={groups()} key={(group) => group.connection.id}>
							{(group) => <ConnectionSection {...props} group={group} />}
						</Each>
					)
				}
			</View>
		</Scroll>
	);
}

/** The menu on a section's header that changes the sidebar's view. */
function ViewMenu(props: {
	settings: SidebarSettingsStore;
	section: Accessor<string>;
	label: Accessor<string>;
}) {
	const { settings } = props;
	const saved = () => settings.settings();
	return (
		<Menu
			popupClass="min-w-44"
			trigger={
				<Button
					testID={`${props.section()}:menu`}
					class="size-6 items-center justify-center rounded-sm hover:bg-sidebar-hover"
					focusVisibleStyle={focusRing()}
					accessibilityLabel={props.label()}
				>
					<Icon name="MoreHorizontal" size={14} />
				</Button>
			}
		>
			<Text class="px-3 py-1 font-sans text-xs font-medium text-muted-foreground">
				{() => t("sidebar.view")}
			</Text>
			<MenuItem
				testID="view:projects"
				icon={<Icon name="Folder" size={14} />}
				checked={saved().view === "projects"}
				onSelect={() => void settings.setView("projects")}
			>
				<Text>{() => t("sidebar.projects")}</Text>
			</MenuItem>
			<MenuItem
				testID="view:recent"
				icon={<Icon name="Clock" size={14} />}
				checked={saved().view === "recent"}
				onSelect={() => void settings.setView("recent")}
			>
				<Text>{() => t("sidebar.recentSessions")}</Text>
			</MenuItem>
			<MenuItem
				testID="view:show-projects"
				icon={<Icon name="Folder" size={14} />}
				onSelect={() =>
					void settings.setShowProjectsInRecents(!saved().showProjectsInRecents)
				}
			>
				<Text class="flex-1">{() => t("sidebar.showProjects")}</Text>
				<View
					testID="view:show-projects:switch"
					class={`h-4 w-7 flex-row items-center rounded-full px-0.5 ${
						saved().showProjectsInRecents ? "bg-primary" : "bg-switch-track"
					}`}
				>
					<View
						class={`size-3 rounded-full bg-background ${
							saved().showProjectsInRecents ? "translate-x-3" : ""
						}`}
					/>
				</View>
			</MenuItem>
		</Menu>
	);
}

/** Every project's latest sessions as one list, the running ones first. */
function RecentSection(
	props: SidebarProps & { projects: Accessor<readonly Project[]> },
) {
	const { store, settings } = props;
	const collapsed = () =>
		settings.settings().collapsedSections[RECENT_SECTION] ?? false;
	// The list is of every project, so the ones not read yet are read now.
	untracked(() => {
		const { sessionIndexes } = store.state();
		for (const project of props.projects()) {
			if (!sessionIndexes[project.id]) void store.loadSessions(project.id);
		}
	});
	const sessions = computed(() =>
		recentSessions(store.state(), t("app.newChat")),
	);
	const projectNames = computed(
		() =>
			new Map(props.projects().map((project) => [project.id, project.name])),
	);
	const muted = () => token("sidebar-foreground-muted");
	return (
		<View testID={RECENT_SECTION} class="gap-(--pilo-sidebar-row-gap)">
			<Foreground.Provider value={muted}>
				<View class="flex-row items-center gap-0.5">
					<Button
						testID={`${RECENT_SECTION}:toggle`}
						class={SECTION_HEADER}
						focusVisibleStyle={focusRing()}
						accessibilityLabel={
							collapsed()
								? t("sidebar.expandRecent")
								: t("sidebar.collapseRecent")
						}
						onPress={() =>
							void settings.setSectionCollapsed(RECENT_SECTION, !collapsed())
						}
					>
						<Icon name="Clock" size={14} />
						<Text class={SECTION_TITLE}>
							{() => t("sidebar.recentSessions")}
						</Text>
						{() =>
							collapsed() ? <Icon name="ChevronRight" size={14} /> : null
						}
					</Button>
					<ViewMenu
						settings={settings}
						section={() => RECENT_SECTION}
						label={() => t("sidebar.recentMenu")}
					/>
				</View>
			</Foreground.Provider>
			{() => {
				if (sessions().length === 0) {
					return (
						<Text
							testID={`${RECENT_SECTION}:empty`}
							class="px-3 py-8 text-center font-sans text-xs text-sidebar-foreground-muted"
						>
							{() => t("sidebar.noSessions")}
						</Text>
					);
				}
				if (collapsed()) return null;
				return (
					<Each
						of={sessions()}
						key={(session) => `${session.projectId}:${session.sessionPath}`}
					>
						{(session) => (
							<SessionRow
								store={store}
								session={session}
								projectName={() =>
									settings.settings().showProjectsInRecents
										? projectNames().get(session().projectId)
										: undefined
								}
							/>
						)}
					</Each>
				);
			}}
		</View>
	);
}

function ConnectionSection(
	props: SidebarProps & { group: Accessor<SidebarGroup> },
) {
	const connection = () => props.group().connection;
	const section = () => connectionSection(connection().id);
	const collapsed = () =>
		props.settings.settings().collapsedSections[section()] ?? false;
	const muted = () => token("sidebar-foreground-muted");
	return (
		<View testID={section()} class="gap-(--pilo-sidebar-row-gap)">
			<Foreground.Provider value={muted}>
				<View class="flex-row items-center gap-0.5">
					<Button
						testID={`${section()}:toggle`}
						class={SECTION_HEADER}
						focusVisibleStyle={focusRing()}
						accessibilityLabel={
							collapsed()
								? t("sidebar.expandEnvironment")
								: t("sidebar.collapseEnvironment")
						}
						onPress={() =>
							void props.settings.setSectionCollapsed(section(), !collapsed())
						}
					>
						<Icon name="Monitor" size={14} />
						<Text class={SECTION_TITLE}>
							{() =>
								isLocal(connection()) ? t("common.local") : connection().name
							}
						</Text>
						{() =>
							collapsed() ? <Icon name="ChevronRight" size={14} /> : null
						}
					</Button>
					<ViewMenu
						settings={props.settings}
						section={section}
						label={() => t("sidebar.connectionMenu")}
					/>
				</View>
			</Foreground.Provider>
			{() =>
				collapsed() ? null : (
					<Each of={props.group().projects} key={(project) => project.id}>
						{(project) => <ProjectSection {...props} project={project} />}
					</Each>
				)
			}
		</View>
	);
}

function ProjectSection(
	props: SidebarProps & {
		project: Accessor<Project>;
		group: Accessor<SidebarGroup>;
	},
) {
	const { store, settings } = props;
	const id = () => props.project().id;
	const section = () => projectSection(id());
	const collapsed = () =>
		settings.settings().collapsedSections[section()] ?? true;
	const selected = () => {
		const state = store.state();
		return (
			state.navigation.session === null && activeProject(state)?.id === id()
		);
	};
	const siblings = () => props.group().projects;
	const movable = () =>
		!isDefaultWorkspace(props.project()) && siblings().length > 1;
	const move = (delta: -1 | 1) => {
		const order = movedProjectOrder(siblings(), id(), delta);
		if (order) {
			void settings.setProjectOrder(props.project().connection.id, order);
		}
	};
	const confirmingRemove = signal(false);
	const foreground = () =>
		selected()
			? token("pilo-project-selected-foreground")
			: unselectedForeground();
	const toggle = () => {
		const expand = collapsed();
		void settings.setSectionCollapsed(section(), !expand);
		// Expanding a project reads its sessions again, as in the Tauri app.
		if (expand) void store.loadSessions(id());
	};
	return (
		<View testID={section()} class="gap-(--pilo-sidebar-row-gap)">
			<Foreground.Provider value={foreground}>
				<View
					testID={`${section()}:row`}
					class={selected() ? `${ROW} ${SELECTED_ROW}` : ROW}
				>
					<Button
						testID={`${section()}:toggle`}
						class="-mx-1 size-6 items-center justify-center rounded-sm"
						focusVisibleStyle={focusRing()}
						accessibilityLabel={
							collapsed()
								? t("sidebar.expandProject")
								: t("sidebar.collapseProject")
						}
						onPress={toggle}
					>
						{() => (
							<Icon name={collapsed() ? "Folder" : "FolderOpen"} size={14} />
						)}
					</Button>
					<Button
						testID={`${section()}:select`}
						class="min-w-0 flex-1 self-stretch flex-row items-center rounded-sm"
						focusVisibleStyle={focusRing()}
						selected={selected()}
						onPress={() => store.selectProject(id())}
					>
						<Text
							class="min-w-0 flex-1 truncate font-sans text-xs font-semibold"
							style={{ color: foreground() }}
						>
							{() => props.project().name}
						</Text>
					</Button>
					<ProjectMenu
						section={section}
						canMove={
							movable()
								? (delta) => movedProjectOrder(siblings(), id(), delta) !== null
								: undefined
						}
						removable={!isDefaultWorkspace(props.project())}
						confirmingRemove={confirmingRemove}
						onRefresh={() => void store.loadSessions(id())}
						onMove={move}
						onRemove={() =>
							void store.removeProject(id()).catch((error: unknown) => {
								console.error("Removing the project failed", error);
							})
						}
					/>
				</View>
			</Foreground.Provider>
			{() =>
				collapsed() ? null : <ProjectSessions store={store} projectId={id} />
			}
		</View>
	);
}

/** The ⋯ menu on a project row: refresh, reorder and remove. */
function ProjectMenu(props: {
	section: Accessor<string>;
	/** Set when the project can reorder: reports whether a step is in range. */
	canMove: ((delta: -1 | 1) => boolean) | undefined;
	/** The default workspace cannot be removed, as in the Tauri app. */
	removable: boolean;
	confirmingRemove: Signal<boolean>;
	onRefresh: () => void;
	onMove: (delta: -1 | 1) => void;
	onRemove: () => void;
}) {
	const section = props.section;
	return (
		<Menu
			popupClass="min-w-40"
			onClose={() => props.confirmingRemove.set(false)}
			trigger={
				<Button
					testID={`${section()}:menu`}
					class="size-6 items-center justify-center rounded-sm hover:bg-sidebar-hover"
					focusVisibleStyle={focusRing()}
					accessibilityLabel={t("sidebar.projectMenu")}
				>
					<Icon name="MoreHorizontal" size={14} />
				</Button>
			}
		>
			<MenuItem
				testID={`${section()}:menu:refresh`}
				icon={<Icon name="RefreshCw" size={14} />}
				onSelect={props.onRefresh}
			>
				<Text>{() => t("sidebar.refreshSessions")}</Text>
			</MenuItem>
			{props.canMove ? (
				<>
					<MenuItem
						testID={`${section()}:menu:move-up`}
						icon={<Icon name="ArrowUp" size={14} />}
						disabled={!props.canMove?.(-1)}
						onSelect={() => props.onMove(-1)}
					>
						<Text>{() => t("sidebar.moveUp")}</Text>
					</MenuItem>
					<MenuItem
						testID={`${section()}:menu:move-down`}
						icon={<Icon name="ArrowDown" size={14} />}
						disabled={!props.canMove?.(1)}
						onSelect={() => props.onMove(1)}
					>
						<Text>{() => t("sidebar.moveDown")}</Text>
					</MenuItem>
				</>
			) : null}
			{props.removable ? (
				<>
					<MenuSeparator />
					<MenuItem
						testID={`${section()}:menu:remove`}
						variant="destructive"
						icon={<Icon name="Trash2" size={14} />}
						closeOnSelect={false}
						onSelect={() => {
							if (!props.confirmingRemove()) {
								props.confirmingRemove.set(true);
								return;
							}
							props.onRemove();
						}}
					>
						<Text>
							{() =>
								props.confirmingRemove()
									? t("sidebar.confirmRemove")
									: t("sidebar.removeProject")
							}
						</Text>
					</MenuItem>
				</>
			) : null}
		</Menu>
	);
}

/** An expanded project's sessions, or why there are none to show. */
function ProjectSessions(props: {
	store: AppStore;
	projectId: Accessor<string>;
}) {
	const { store } = props;
	const all = signal(false);
	const section = () => projectSection(props.projectId());
	const index = () => store.state().sessionIndexes[props.projectId()];
	// A project that starts expanded has not read its sessions yet.
	untracked(() => {
		if (!index()) void store.loadSessions(props.projectId());
	});
	const sessions = computed(() => {
		const state = store.state();
		const listed = sidebarSessions(state, props.projectId(), t("app.newChat"));
		const open = state.navigation.session;
		const opened =
			open?.projectId === props.projectId()
				? listed.find((session) => session.sessionPath === open.sessionPath)
				: undefined;
		return summarizeProjectSessions(
			listed,
			opened?.id ?? null,
			all() ? listed.length : undefined,
		);
	});
	return (
		<View class="gap-(--pilo-sidebar-row-gap)">
			<Each of={sessions().visible} key={(session) => session.sessionPath}>
				{(session) => <SessionRow store={store} session={session} />}
			</Each>
			{() => {
				const current = index();
				if (sessions().hiddenCount > 0) {
					return (
						<Button
							testID={`${section()}:view-all`}
							class={`${ROW} pl-7.5`}
							focusVisibleStyle={focusRing()}
							onPress={() => all.set(true)}
						>
							<Text class="font-sans text-sm text-sidebar-foreground-muted">
								{() => t("sidebar.viewAll")}
							</Text>
						</Button>
					);
				}
				if (current?.sessions.length) return null;
				if (current?.status === "failed") {
					return (
						<Text
							testID={`${section()}:failed`}
							role="alert"
							class="px-3 py-2 text-center font-sans text-xs text-destructive"
						>
							{current.message ?? t("common.loadFailed")}
						</Text>
					);
				}
				if (current?.status === "loaded") {
					return (
						<Text
							testID={`${section()}:empty`}
							class="px-3 py-2 text-center font-sans text-xs text-sidebar-foreground-muted"
						>
							{() => t("sidebar.noSessions")}
						</Text>
					);
				}
				return (
					<View
						testID={`${section()}:loading`}
						class="flex-row items-center justify-center py-2"
						accessibilityLabel={t("sidebar.refreshingSessions")}
					>
						<Spinner size={14} color={token("sidebar-foreground-muted")} />
					</View>
				);
			}}
		</View>
	);
}

function SessionRow(props: {
	store: AppStore;
	session: Accessor<SidebarSession>;
	/** The session's project, for a list that mixes projects. */
	projectName?: Accessor<string | undefined>;
}) {
	const session = props.session;
	const selected = () => {
		const open = props.store.state().navigation.session;
		return (
			open?.projectId === session().projectId &&
			open.sessionPath === session().sessionPath
		);
	};
	return (
		<Button
			testID={`session:${session().id}`}
			class={selected() ? `${ROW} ${SELECTED_ROW}` : ROW}
			focusVisibleStyle={focusRing()}
			selected={selected()}
			onPress={() =>
				props.store.selectSession(session().projectId, session().sessionPath)
			}
		>
			<View class="h-6 w-4 items-center justify-center">
				{() =>
					!session().active && session().unread ? (
						<View
							testID={`session:${session().id}:unread`}
							class="size-1.5 rounded-full bg-sidebar-primary"
						/>
					) : null
				}
			</View>
			<View class="min-w-0 flex-1">
				<Text
					class={`min-w-0 truncate font-sans text-sm ${
						selected()
							? "text-sidebar-selection-foreground"
							: "text-sidebar-foreground dark:text-sidebar-foreground/75"
					}`}
				>
					{() => session().title}
				</Text>
				{() => {
					const name = props.projectName?.();
					if (!name) return null;
					return (
						<View class="h-4 flex-row items-center gap-1">
							<Icon
								name="Folder"
								size={12}
								color={token("sidebar-foreground-muted")}
							/>
							<Text
								testID={`session:${session().id}:project`}
								class="min-w-0 flex-1 truncate font-sans text-[11px] text-sidebar-foreground-muted"
							>
								{name}
							</Text>
						</View>
					);
				}}
			</View>
			<View class="size-6 items-center justify-center">
				{() =>
					session().active ? (
						<Spinner
							testID={`session:${session().id}:running`}
							size={12}
							color={token("sidebar-primary")}
						/>
					) : null
				}
			</View>
		</Button>
	);
}

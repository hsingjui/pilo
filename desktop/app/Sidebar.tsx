import {
	type Accessor,
	computed,
	type JSX,
	List,
	Scroll,
	signal,
	Text,
	token,
	untracked,
	View,
} from "nsh";
import { Button } from "nsh/base";

import { sortSidebarSessionsByRecency } from "@shared/sidebar/session-list";
import type { Connection } from "@shared/api/pi-runtime-types";
import { isDefaultWorkspace, type Project } from "@shared/api/projects-types";
import type { AppStore } from "../state/app-store";
import { chatPx } from "../chat/layout";
import { Foreground } from "../ui/foreground";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { MenuSeparator } from "../ui/menu-separator";
import { scrollbarLook } from "../ui/scrollbar";
import { Tooltip } from "../ui/tooltip";
import { t } from "./i18n";
import { createHover } from "../ui/hover";
import {
	MiniSwitch,
	SidebarAction,
	sidebarFocusRing,
	sidebarProjectName,
	sidebarRowHeight,
	sidebarText,
} from "./sidebar-parts";
import { ProjectSection } from "./sidebar-project-section";
import {
	connectionSection,
	isLocal,
	projectSection,
	RECENT_SECTION,
	recentSessions,
	type SidebarGroup,
	sidebarGroups,
	sessionRowKey,
	sidebarSessions,
} from "./sidebar-projects";
import { SessionGlide } from "./sidebar-session-glide";
import { SessionRow } from "./sidebar-session-row";
import type { SidebarSettingsStore } from "./sidebar-settings";

export interface SidebarProps {
	store: AppStore;
	settings: SidebarSettingsStore;
	/** The project whose every session the list shows instead of the tree. */
	viewedProject: Accessor<Project | null>;
	onViewProject: (projectId: string) => void;
	onSelectChat?: (projectId: string) => void;
	/** The connections whose default workspace the tree shows. */
	defaultWorkspaceShown: Accessor<Record<string, boolean>>;
	onDefaultWorkspaceShown?: (connectionId: string, shown: boolean) => void;
	onAddProject?: (connectionId: string | null) => void;
	onRemoveConnection?: (connection: Connection) => void;
}

/** A connection's or the recent view's header (`pilo-sidebar-env-*`). */
const SECTION_HEADER =
	"group flex-row items-center gap-0.5 rounded-md border border-transparent pr-2";
const SECTION_TOGGLE =
	"min-h-[26px] min-w-0 flex-1 flex-row items-center gap-2 rounded-md border border-transparent px-2";
/** A section of the tree: `mb-3 last:mb-0 space-y-(--pilo-sidebar-row-gap)`. */
const SECTION =
	"mb-3 w-full min-w-0 gap-(--pilo-sidebar-row-gap) overflow-hidden last:mb-0";
/**
 * The sidebar's list in the saved view, as the WebUI `SidebarTree`: the
 * projects by connection, each with its latest sessions once expanded, the
 * sessions of one project, or every project's latest sessions as one list.
 */
export function Sidebar(props: SidebarProps) {
	// The groups change only with the projects, not with every state change.
	const projects = computed(() => props.store.state().projects);
	const groups = computed(() => {
		const shown = props.defaultWorkspaceShown();
		return sidebarGroups(
			projects(),
			props.settings.settings().projectOrder,
		).map((group) => ({
			...group,
			// A connection's default workspace shows once its menu asks for it.
			projects: group.projects.filter(
				(project) =>
					!isDefaultWorkspace(project) || shown[group.connection.id] === true,
			),
		}));
	});
	const view = computed(() => props.settings.settings().view);
	const viewedProjectId = computed(() => props.viewedProject()?.id ?? null);
	// Only a change of view resets scroll; session rows update by path.
	return (
		<View class="mt-2 min-h-0 min-w-0 flex-1">
			{() => {
				const recent = view() === "recent";
				const projectId = viewedProjectId();
				if (!recent && projectId !== null) {
					// Hundreds of rows: a list of its own that recycles its cells.
					return (
						<AllProjectSessions
							store={props.store}
							projectId={projectId}
							onSelectChat={props.onSelectChat}
						/>
					);
				}
				return (
					<Scroll
						testID="sidebar-projects"
						class="min-h-0 min-w-0 flex-1"
						bounces={false}
						scrollbar={{ vertical: scrollbarLook() }}
					>
						<View class="min-w-0 pt-1 pr-2.5 pb-3 pl-1.5">
							{recent ? (
								<RecentSection {...props} projects={projects} />
							) : (
								<Each of={groups()} key={(group) => group.connection.id}>
									{(group) => <ConnectionSection {...props} group={group} />}
								</Each>
							)}
						</View>
					</Scroll>
				);
			}}
		</View>
	);
}

/** The view's items of a section's menu: projects or recent sessions. */
function ViewMenuItems(props: { settings: SidebarSettingsStore }) {
	const { settings } = props;
	const saved = () => settings.settings();
	return (
		<>
			<Text class="px-3 py-1 font-sans text-xs font-medium text-muted-foreground">
				{() => t("sidebar.view")}
			</Text>
			<MenuItem
				testID="view:projects"
				class="relative gap-2 px-2 pr-6"
				icon={<Icon name="Folder" size={14} />}
				role="menuitemradio"
				indicatorClass="absolute right-2"
				checked={saved().view === "projects"}
				onSelect={() => void settings.setView("projects")}
			>
				<Text class="min-w-0 flex-1 font-sans">
					{() => t("sidebar.projects")}
				</Text>
			</MenuItem>
			<MenuItem
				testID="view:recent"
				class="relative gap-2 px-2 pr-6"
				icon={<Icon name="Clock" size={14} />}
				role="menuitemradio"
				indicatorClass="absolute right-2"
				checked={saved().view === "recent"}
				onSelect={() => void settings.setView("recent")}
			>
				<Text class="min-w-0 flex-1 font-sans">
					{() => t("sidebar.recentSessions")}
				</Text>
			</MenuItem>
			<MenuItem
				testID="view:show-projects"
				class="gap-2 px-2"
				icon={<Icon name="Folder" size={14} />}
				onSelect={() =>
					void settings.setShowProjectsInRecents(!saved().showProjectsInRecents)
				}
			>
				<Text class="min-w-0 flex-1 font-sans">
					{() => t("sidebar.showProjects")}
				</Text>
				<MiniSwitch
					testID="view:show-projects:switch"
					checked={saved().showProjectsInRecents}
				/>
			</MenuItem>
		</>
	);
}

/** A section's header: its icon and title, a chevron, then its actions. */
function SectionHeader(props: {
	section: string;
	icon: "Monitor" | "Clock";
	title: Accessor<string>;
	collapsed: Accessor<boolean>;
	label: Accessor<string>;
	onToggle: () => void;
	children?: JSX.Element;
}) {
	const hover = createHover();
	const foreground = () =>
		token(hover.hovered() ? "sidebar-foreground" : "sidebar-foreground-muted");
	return (
		<View
			class={SECTION_HEADER}
			style={{ minHeight: sidebarRowHeight("pilo-sidebar-env-height") }}
		>
			<Foreground.Provider value={foreground}>
				<Button
					{...hover.props}
					testID={`${props.section}:toggle`}
					class={SECTION_TOGGLE}
					focusVisibleStyle={sidebarFocusRing()}
					accessibilityLabel={props.label()}
					onPress={props.onToggle}
				>
					<Icon name={props.icon} size={14} class="shrink-0 opacity-80" />
					<Text
						class="min-w-0 shrink truncate font-sans font-medium"
						style={{ ...sidebarText.sm, color: foreground() }}
					>
						{props.title}
					</Text>
					<Icon
						name="ChevronDown"
						size={14}
						class={`shrink-0 transition duration-150 ease-out ${
							props.collapsed()
								? "-rotate-90 opacity-100"
								: "opacity-0 group-hover:opacity-100"
						}`}
					/>
				</Button>
			</Foreground.Provider>
			{props.children}
		</View>
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
	const sessionIndexes = computed(() => store.state().sessionIndexes);
	const chatSessions = computed(() => store.state().chatSessions);
	const runningSince = computed(() => store.state().runningSince);
	const externalActivity = computed(() => store.state().externalActivity);
	const readStates = computed(() => store.state().readStates);
	const openDraft = computed(() => {
		const open = store.state().navigation.session;
		return open?.sessionId !== undefined
			? `${open.projectId}:${open.sessionId}`
			: null;
	});
	const sessions = computed(
		() => {
			props.projects();
			sessionIndexes();
			chatSessions();
			runningSince();
			externalActivity();
			readStates();
			openDraft();
			return recentSessions(
				untracked(store.state),
				t("app.newChat"),
				store.startedDraft(),
			);
		},
		{
			equals: (previous, next) =>
				previous.length === next.length &&
				previous.every((session, at) => session === next[at]),
		},
	);
	const hasSessions = computed(() => sessions().length > 0);
	const projectNames = computed(
		() =>
			new Map(
				props
					.projects()
					.map((project) => [project.id, sidebarProjectName(project)]),
			),
	);
	return (
		<View testID={RECENT_SECTION} class={SECTION}>
			<SectionHeader
				section={RECENT_SECTION}
				icon="Clock"
				title={() => t("sidebar.recentSessions")}
				collapsed={collapsed}
				label={() =>
					collapsed() ? t("sidebar.expandRecent") : t("sidebar.collapseRecent")
				}
				onToggle={() =>
					void settings.setSectionCollapsed(RECENT_SECTION, !collapsed())
				}
			>
				{props.onAddProject ? (
					<SidebarAction
						testID={`${RECENT_SECTION}:add-project`}
						label={t("navigation.addProject")}
						tooltip={
							<Tooltip placement="right">
								<Text class="font-sans">
									{() => t("navigation.addProject")}
								</Text>
							</Tooltip>
						}
						onPress={() => props.onAddProject?.(null)}
					>
						<Icon name="Plus" size={14} />
					</SidebarAction>
				) : null}
				<Menu
					popupClass="w-44"
					popupStyle={{ minWidth: 0 }}
					trigger={
						<SidebarAction
							testID={`${RECENT_SECTION}:menu`}
							label={t("sidebar.recentMenu")}
						>
							<Icon name="MoreHorizontal" size={14} />
						</SidebarAction>
					}
				>
					<ViewMenuItems settings={settings} />
				</Menu>
			</SectionHeader>
			{() => {
				if (!hasSessions()) return <NoSessions testID={RECENT_SECTION} />;
				if (collapsed()) return null;
				return (
					<SessionGlide>
						<Each of={sessions()} key={sessionRowKey}>
							{(session) => (
								<SessionRow
									store={store}
									onSelectChat={props.onSelectChat}
									session={session}
									projectName={() =>
										settings.settings().showProjectsInRecents
											? projectNames().get(session().projectId)
											: undefined
									}
								/>
							)}
						</Each>
					</SessionGlide>
				);
			}}
		</View>
	);
}

function NoSessions(props: { testID: string }) {
	return (
		<Text
			testID={`${props.testID}:empty`}
			class="px-3 py-8 text-center font-sans text-sidebar-foreground-muted"
			style={sidebarText.xs}
		>
			{() => t("sidebar.noSessions")}
		</Text>
	);
}

function ConnectionSection(
	props: SidebarProps & { group: Accessor<SidebarGroup> },
) {
	const connection = () => props.group().connection;
	const name = () =>
		isLocal(connection()) ? t("common.local") : connection().name;
	const section = () => connectionSection(connection().id);
	const collapsed = () =>
		props.settings.settings().collapsedSections[section()] ?? false;
	const confirmingRemove = signal(false);
	const menuOpen = signal(false);
	const removable = () =>
		props.onRemoveConnection !== undefined && !isLocal(connection());
	return (
		<View testID={section()} class={SECTION}>
			<SectionHeader
				section={section()}
				icon="Monitor"
				title={name}
				collapsed={collapsed}
				label={() =>
					collapsed()
						? t("sidebar.expandEnvironment")
						: t("sidebar.collapseEnvironment")
				}
				onToggle={() =>
					void props.settings.setSectionCollapsed(section(), !collapsed())
				}
			>
				{props.onAddProject ? (
					<SidebarAction
						testID={`${section()}:add-project`}
						label={t("sidebar.addProjectIn", { name: name() })}
						tooltip={
							<Tooltip placement="right">
								<Text class="font-sans">
									{() => t("navigation.addProject")}
								</Text>
							</Tooltip>
						}
						onPress={() => props.onAddProject?.(connection().id)}
					>
						<Icon name="Plus" size={14} />
					</SidebarAction>
				) : null}
				<Menu
					open={menuOpen()}
					onOpenChange={({ open }) => menuOpen.set(open)}
					popupClass="w-44"
					popupStyle={{ minWidth: 0 }}
					onClose={() => confirmingRemove.set(false)}
					trigger={
						<SidebarAction
							testID={`${section()}:menu`}
							label={t("sidebar.connectionMenu")}
						>
							<Icon name="MoreHorizontal" size={14} />
						</SidebarAction>
					}
				>
					<ViewMenuItems settings={props.settings} />
					<MenuSeparator />
					<MenuItem
						testID={`${section()}:menu:default-workspace`}
						class="gap-2 px-2"
						checked={props.defaultWorkspaceShown()[connection().id] === true}
						disabled={!props.onDefaultWorkspaceShown}
						onSelect={() =>
							props.onDefaultWorkspaceShown?.(
								connection().id,
								props.defaultWorkspaceShown()[connection().id] !== true,
							)
						}
					>
						<Text class="min-w-0 flex-1 font-sans">
							{() => t("sidebar.showDefaultWorkspace")}
						</Text>
					</MenuItem>
					{() =>
						removable() ? (
							<MenuItem
								testID={`${section()}:menu:remove`}
								class="gap-2 px-2"
								variant="destructive"
								icon={<Icon name="Trash2" size={14} />}
								closeOnSelect={false}
								onSelect={() => {
									if (!confirmingRemove()) {
										confirmingRemove.set(true);
										return;
									}
									confirmingRemove.set(false);
									menuOpen.set(false);
									props.onRemoveConnection?.(connection());
								}}
							>
								<Text class="min-w-0 flex-1 font-sans">
									{() =>
										confirmingRemove()
											? t("sidebar.confirmRemove")
											: t("sidebar.removeConnection")
									}
								</Text>
							</MenuItem>
						) : null
					}
				</Menu>
			</SectionHeader>
			{() =>
				collapsed() ? null : (
					<Each of={props.group().projects} key={(project) => project.id}>
						{(project) => (
							<ProjectSection
								store={props.store}
								onSelectChat={props.onSelectChat}
								settings={props.settings}
								onViewProject={props.onViewProject}
								project={project}
							/>
						)}
					</Each>
				)
			}
		</View>
	);
}

/** Every session of one project, newest first (the WebUI second view). */
function AllProjectSessions(
	props: Pick<SidebarProps, "store" | "onSelectChat"> & { projectId: string },
) {
	const { store } = props;
	const projectIndex = computed(
		() => store.state().sessionIndexes[props.projectId],
	);
	const projectExternal = computed(
		() => store.state().externalActivity[props.projectId],
	);
	const chatSessions = computed(() => store.state().chatSessions);
	const runningSince = computed(() => store.state().runningSince);
	const readStates = computed(() => store.state().readStates);
	const openDraftId = computed(() => {
		const open = store.state().navigation.session;
		return open?.projectId === props.projectId && open.sessionId !== undefined
			? open.sessionId
			: null;
	});
	const rows = computed(
		() => {
			projectIndex();
			projectExternal();
			chatSessions();
			runningSince();
			readStates();
			openDraftId();
			return sidebarSessions(
				untracked(store.state),
				props.projectId,
				t("app.newChat"),
				store.startedDraft(),
			);
		},
		{
			equals: (previous, next) =>
				previous.length === next.length &&
				previous.every((session, at) => session === next[at]),
		},
	);
	const sessions = computed(() => sortSidebarSessionsByRecency(rows()));
	const section = projectSection(props.projectId);
	// Rows keep their own hover: the sliding highlight needs every row in
	// one view, and a list recycles its cells.
	return (
		<List
			testID={`${section}:all`}
			class="min-h-0 min-w-0 flex-1"
			contentClass="pt-1 pr-2.5 pb-3 pl-1.5"
			contentStyle={{ gap: chatPx(token("pilo-sidebar-session-gap")) }}
			bounces={false}
			scrollbar={{ vertical: scrollbarLook() }}
			each={sessions()}
			keyExtractor={sessionRowKey}
			estimatedItemSize={sidebarRowHeight("pilo-sidebar-session-height")}
			empty={() => <NoSessions testID={section} />}
		>
			{(session) => (
				<SessionRow
					store={store}
					session={session}
					onSelectChat={props.onSelectChat}
				/>
			)}
		</List>
	);
}

/** The hover highlight a list of sessions slides between its rows. */

import {
	type Accessor,
	batch,
	computed,
	List,
	reduceMotion,
	Scroll,
	signal,
	Text,
	token,
	untracked,
	View,
} from "nsh";
import { Collapsible } from "nsh/base";

import { sortSidebarSessionsByRecency } from "@shared/sidebar/session-list";
import type { Connection } from "@shared/api/pi-runtime-types";
import { isDefaultWorkspace, type Project } from "@shared/api/projects-types";
import type { AppStore } from "../state/app-store";
import { chatPx } from "../chat/layout";
import { HostList } from "../hosts/host-list";
import type { HostRegistry } from "../hosts/host-registry";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { MenuSeparator } from "../ui/menu-separator";
import { collapsibleRevealProps } from "../ui/motion";
import { scrollbarLook, scrollbarTheme } from "../ui/scrollbar";
import { Tooltip } from "../ui/tooltip";
import { type ArchiveView, useArchivedSessions } from "./archived-sessions";
import { connectionLabel } from "./connection-label";
import { t } from "./i18n";
import {
	MiniSwitch,
	SidebarAction,
	sidebarProjectName,
	sidebarRowHeight,
	SidebarSectionHeader,
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
	archiveView: Accessor<ArchiveView | null>;
	onViewArchived: (projectId: string) => void;
	onSelectChat?: (projectId: string) => void;
	/** The connections whose default workspace the tree shows. */
	defaultWorkspaceShown: Accessor<Record<string, boolean>>;
	onDefaultWorkspaceShown?: (connectionId: string, shown: boolean) => void;
	onAddProject?: (connectionId: string | null) => void;
	onRemoveConnection?: (connection: Connection) => void;
	/** `false` hides removing projects (a Host paired without workspace access). */
	canRemoveProjects?: boolean;
	/** Paired desktop Hosts, shown as ordinary connection sections. */
	hosts?: HostRegistry;
}

const SECTION = "mb-3 w-full min-w-0 overflow-hidden last:mb-0";
/**
 * The sidebar's list in the saved view, as the WebUI `SidebarTree`: the
 * projects by connection, each with its latest sessions once expanded, the
 * sessions of one project, or every project's latest sessions as one list.
 */
export function Sidebar(props: SidebarProps) {
	const { hosts } = props;
	// A Host switch remounts the sidebar. The reveal needs a closed layout first.
	const awaitingHostLayout = signal(
		untracked(() => hosts?.revealedHostId() != null && !reduceMotion()),
	);
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
	const hostGroups = computed(() =>
		groups().filter((group) => isLocal(group.connection)),
	);
	const otherGroups = computed(() =>
		hosts ? groups().filter((group) => !isLocal(group.connection)) : groups(),
	);
	const view = computed(() => props.settings.settings().view);
	const viewedProjectId = computed(() => props.viewedProject()?.id ?? null);
	// Only a change of view resets scroll; session rows update by path.
	return (
		<View
			class="mt-2 min-h-0 min-w-0 flex-1"
			onLayout={
				awaitingHostLayout() ? () => awaitingHostLayout.set(false) : undefined
			}
		>
			{() => {
				if (props.archiveView()) {
					return (
						<ArchivedSessions
							store={props.store}
							view={props.archiveView}
							onSelectChat={props.onSelectChat}
						/>
					);
				}
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
						scrollbar={scrollbarTheme({ vertical: scrollbarLook() })}
					>
						<View class="min-w-0 pt-1 pr-2.5 pb-3 pl-1.5">
							{hosts ? (
								<HostList
									registry={hosts}
									sectionClass={SECTION}
									revealProjects={!recent}
									renderActive={(hostId) =>
										recent ? null : (
											<Each
												of={hostGroups()}
												key={(group) => group.connection.id}
											>
												{(group) => (
													<ConnectionSection
														{...props}
														group={group}
														hostId={hostId}
														awaitingHostLayout={awaitingHostLayout}
													/>
												)}
											</Each>
										)
									}
								/>
							) : null}
							{recent ? (
								<RecentSection {...props} projects={projects} />
							) : (
								<Each of={otherGroups()} key={(group) => group.connection.id}>
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
			{() =>
				saved().view === "recent" ? (
					<MenuItem
						testID="view:show-projects"
						class="gap-2 px-2"
						indicatorClass="hidden"
						icon={<Icon name="Folder" size={14} />}
						onSelect={() =>
							void settings.setShowProjectsInRecents(
								!saved().showProjectsInRecents,
							)
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
				) : null
			}
		</>
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
	const pendingDrafts = computed(() => store.state().pendingDrafts);
	const sentDrafts = computed(() => store.state().sentDrafts);
	const sessions = computed(
		() => {
			props.projects();
			sessionIndexes();
			chatSessions();
			runningSince();
			externalActivity();
			readStates();
			pendingDrafts();
			sentDrafts();
			return recentSessions(untracked(store.state), t("app.newChat"));
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
		<View
			testID={RECENT_SECTION}
			class={`${SECTION} gap-(--pilo-sidebar-row-gap)`}
		>
			<SidebarSectionHeader
				testID={`${RECENT_SECTION}:toggle`}
				icon="Clock"
				title={() => t("sidebar.recentSessions")}
				collapsed={collapsed}
				label={() =>
					collapsed() ? t("sidebar.expandRecent") : t("sidebar.collapseRecent")
				}
				onPress={() =>
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
			</SidebarSectionHeader>
			<Collapsible
				open={!collapsed()}
				{...collapsibleRevealProps()}
				content={() =>
					!hasSessions() ? (
						<NoSessions testID={RECENT_SECTION} />
					) : (
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
					)
				}
			/>
		</View>
	);
}

function ArchivedSessions(props: {
	store: AppStore;
	view: Accessor<ArchiveView | null>;
	onSelectChat?: (projectId: string) => void;
}) {
	const archive = useArchivedSessions(props.store, props.view);
	return (
		<Scroll
			testID="sidebar-archived-sessions"
			class="min-h-0 min-w-0 flex-1"
			bounces={false}
			scrollbar={scrollbarTheme({ vertical: scrollbarLook() })}
		>
			<View class="gap-3 pt-1 pr-2.5 pb-3 pl-1.5">
				<Each of={archive.groups()} key={({ project }) => project.id}>
					{(group) => (
						<View class="gap-(--pilo-sidebar-session-gap)">
							{() =>
								props.view()?.projectId === undefined && (
									<View class="ml-px px-2">
										<Text
											testID={`sidebar-archived-project:${group().project.id}`}
											class="truncate font-sans font-medium text-sidebar-foreground-muted"
											style={sidebarText("xs")}
										>
											{sidebarProjectName(group().project)}
										</Text>
									</View>
								)
							}
							<SessionGlide>
								<Each of={group().sessions} key={sessionRowKey}>
									{(session) => (
										<SessionRow
											store={props.store}
											session={session}
											onSelectChat={props.onSelectChat}
										/>
									)}
								</Each>
							</SessionGlide>
						</View>
					)}
				</Each>
				{() => {
					const failed = archive.failed();
					const loading = archive.loading();
					if (!failed && !loading && archive.groups().length > 0) return null;
					return (
						<Text
							class="px-3 py-8 text-center font-sans text-sidebar-foreground-muted"
							style={sidebarText("xs")}
						>
							{t(
								loading
									? "sidebar.refreshingSessions"
									: failed
										? "sidebar.loadArchivedFailed"
										: "sidebar.noArchivedSessions",
							)}
						</Text>
					);
				}}
			</View>
		</Scroll>
	);
}

function NoSessions(props: { testID: string }) {
	return (
		<Text
			testID={`${props.testID}:empty`}
			class="px-3 py-8 text-center font-sans text-sidebar-foreground-muted"
			style={sidebarText("xs")}
		>
			{() => t("sidebar.noSessions")}
		</Text>
	);
}

function ConnectionSection(
	props: SidebarProps & {
		group: Accessor<SidebarGroup>;
		hostId?: string;
		awaitingHostLayout?: Accessor<boolean>;
	},
) {
	const connection = () => props.group().connection;
	const { hosts, hostId } = props;
	const name = () =>
		(hostId && hosts?.displayName(hostId)) || connectionLabel(connection());
	const section = () => connectionSection(connection().id);
	const collapsed = () =>
		hostId && hosts?.revealedHostId() === hostId
			? (props.awaitingHostLayout?.() ?? false)
			: (props.settings.settings().collapsedSections[section()] ?? false);
	const confirmingRemove = signal(false);
	const menuOpen = signal(false);
	const removable = () =>
		props.onRemoveConnection !== undefined && !isLocal(connection());
	return (
		<View testID={section()} class={SECTION}>
			<SidebarSectionHeader
				testID={`${section()}:toggle`}
				icon="Monitor"
				title={name}
				collapsed={collapsed}
				label={() =>
					collapsed()
						? t("sidebar.expandEnvironment")
						: t("sidebar.collapseEnvironment")
				}
				onPress={() =>
					batch(() => {
						void props.settings.setSectionCollapsed(section(), !collapsed());
						if (hostId) hosts?.clearSidebarReveal(hostId);
					})
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
									{() => {
										if (!confirmingRemove()) {
											return t("sidebar.removeConnection");
										}
										const count = props.group().projects.length;
										return count > 0
											? t("sidebar.confirmRemoveWithProjects", { count })
											: t("sidebar.confirmRemove");
									}}
								</Text>
							</MenuItem>
						) : null
					}
				</Menu>
			</SidebarSectionHeader>
			<Collapsible
				open={!collapsed()}
				{...collapsibleRevealProps()}
				content={
					<View
						class="w-full min-w-0 gap-(--pilo-sidebar-row-gap)"
						style={{
							paddingTop: props.group().projects.length
								? token("pilo-sidebar-row-gap")
								: 0,
						}}
					>
						<Each of={props.group().projects} key={(project) => project.id}>
							{(project) => (
								<ProjectSection
									store={props.store}
									onSelectChat={props.onSelectChat}
									settings={props.settings}
									onViewProject={props.onViewProject}
									onViewArchived={props.onViewArchived}
									canRemove={props.canRemoveProjects !== false}
									project={project}
								/>
							)}
						</Each>
					</View>
				}
			/>
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
	const pendingDrafts = computed(() => store.state().pendingDrafts);
	const sentDrafts = computed(() => store.state().sentDrafts);
	const rows = computed(
		() => {
			projectIndex();
			projectExternal();
			chatSessions();
			runningSince();
			readStates();
			pendingDrafts();
			sentDrafts();
			return sidebarSessions(
				untracked(store.state),
				props.projectId,
				t("app.newChat"),
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
	return (
		<SessionGlide
			viewport={(onScroll) => (
				<List
					testID={`${section}:all`}
					class="min-h-0 min-w-0 flex-1"
					contentClass="pt-1 pr-2.5 pb-3 pl-1.5"
					contentStyle={{ gap: chatPx(token("pilo-sidebar-session-gap")) }}
					bounces={false}
					onScroll={onScroll}
					scrollbar={scrollbarTheme({ vertical: scrollbarLook() })}
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
			)}
		/>
	);
}

/** The hover highlight a list of sessions slides between its rows. */

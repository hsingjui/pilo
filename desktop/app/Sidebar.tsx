import {
	type Accessor,
	computed,
	Scroll,
	signal,
	Text,
	token,
	untracked,
	View,
} from "nsh";
import { Button } from "nsh/base";

import { summarizeProjectSessions } from "@/components/sidebar/session-list";
import type { SidebarSession } from "@/components/sidebar/types";
import type { Project } from "@/lib/api/projects-types";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Foreground } from "../ui/foreground";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { Spinner } from "../ui/spinner";
import { t } from "./i18n";
import {
	connectionSection,
	isLocal,
	projectSection,
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

const focusRing = () =>
	focusRingStyle(token("sidebar-ring"), undefined, undefined, { width: 2 });

/** The projects by connection, each with its latest sessions once expanded. */
export function Sidebar(props: SidebarProps) {
	// The groups change only with the projects, not with every state change.
	const projects = computed(() => props.store.state().projects);
	const groups = computed(() => sidebarGroups(projects()));
	return (
		<Scroll
			testID="sidebar-projects"
			class="min-h-0 flex-1"
			scrollbar={{ vertical: scrollbarLook() }}
		>
			<View class="gap-3 pt-1 pr-2.5 pb-3 pl-1.5">
				<Each of={groups()} key={(group) => group.connection.id}>
					{(group) => <ConnectionSection {...props} group={group} />}
				</Each>
			</View>
		</Scroll>
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
				<Button
					testID={`${section()}:toggle`}
					class="min-h-6.5 flex-row items-center gap-2 rounded-md px-2"
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
					<Text class="min-w-0 shrink truncate font-sans text-sm font-medium text-sidebar-foreground-muted">
						{() =>
							isLocal(connection()) ? t("common.local") : connection().name
						}
					</Text>
					{() => (collapsed() ? <Icon name="ChevronRight" size={14} /> : null)}
				</Button>
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

function ProjectSection(props: SidebarProps & { project: Accessor<Project> }) {
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
	const foreground = () =>
		token(
			selected() ? "pilo-project-selected-foreground" : "sidebar-foreground",
		);
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
				</View>
			</Foreground.Provider>
			{() =>
				collapsed() ? null : <ProjectSessions store={store} projectId={id} />
			}
		</View>
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
			<Text
				class={`min-w-0 flex-1 truncate font-sans text-sm ${
					selected()
						? "text-sidebar-selection-foreground"
						: "text-sidebar-foreground"
				}`}
			>
				{() => session().title}
			</Text>
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

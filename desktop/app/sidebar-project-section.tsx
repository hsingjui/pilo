import {
	type Accessor,
	type Bounds,
	computed,
	type Signal,
	signal,
	Text,
	token,
	untracked,
	View,
} from "nsh";
import { Button } from "nsh/base";

import { summarizeProjectSessions } from "@/components/sidebar/session-list";
import { isDefaultWorkspace, type Project } from "@/lib/api/projects-types";
import { displayProjectPath } from "@/lib/project-path";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import { Foreground } from "../ui/foreground";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";
import { t } from "./i18n";
import { createHover } from "../ui/hover";
import {
	HOVER_ACTION,
	SidebarAction,
	sidebarFocusRing,
	sidebarForeground,
	sidebarProjectName,
} from "./sidebar-parts";
import {
	isLocal,
	movedProjectOrder,
	projectSection,
	type SidebarGroup,
	sidebarSessions,
} from "./sidebar-projects";
import { SessionGlide, SessionGlideContext } from "./sidebar-session-glide";
import { SessionRow } from "./sidebar-session-row";
import type { SidebarSettingsStore } from "./sidebar-settings";

export function ProjectSection(props: {
	store: AppStore;
	settings: SidebarSettingsStore;
	onViewProject: (projectId: string) => void;
	project: Accessor<Project>;
	group: Accessor<SidebarGroup>;
}) {
	const { store, settings } = props;
	const id = () => props.project().id;
	const name = () => sidebarProjectName(props.project());
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
	const siblings = () => props.group().projects;
	const movable = () =>
		!isDefaultWorkspace(props.project()) && siblings().length > 1;
	const move = (delta: -1 | 1) => {
		const order = movedProjectOrder(siblings(), id(), delta);
		if (order) {
			void settings.setProjectOrder(props.project().connection.id, order);
		}
	};
	const menuOpen = signal(false);
	const confirmingRemove = signal(false);
	const hover = createHover();
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
			"group relative min-h-(--pilo-sidebar-project-height) w-full min-w-0 flex-row items-center gap-1.5 rounded-md border border-transparent px-2 py-0.5 transition-colors",
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
				<View testID={`${section()}:row`}>
					<Button
						{...hover.props}
						testID={`${section()}:select`}
						class={rowClass()}
						focusVisibleStyle={sidebarFocusRing()}
						selected={selected()}
						accessibilityLabel={
							refreshing()
								? t("sidebar.refreshingProject", { name: name() })
								: name()
						}
						tooltip={
							<Tooltip
								placement="right"
								align="start"
								delay={600}
								class="max-w-[420px]"
							>
								<View class="gap-0.5">
									<Text class="font-sans text-xs">
										{() =>
											isLocal(props.project().connection)
												? t("common.local")
												: props.project().connection.name
										}
									</Text>
									<Text class="font-mono text-[11px] leading-snug">
										{() => displayProjectPath(props.project().path)}
									</Text>
								</View>
							</Tooltip>
						}
						onPress={() => {
							if (!refreshing()) store.selectProject(id());
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
							class="min-w-0 flex-1 truncate font-sans text-xs font-semibold"
							style={{ color: foreground() }}
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
								canMove={
									movable()
										? (delta) =>
												movedProjectOrder(siblings(), id(), delta) !== null
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
							<SidebarAction
								testID={`${section()}:new-chat`}
								class={hoverAction()}
								label={t("sidebar.newSession")}
								onPress={() => store.selectProject(id())}
							>
								<Icon name="SquarePen" size={14} />
							</SidebarAction>
						</View>
					</Button>
				</View>
			</Foreground.Provider>
			{() =>
				collapsed() ? null : (
					<ProjectSessions
						store={store}
						projectId={id}
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

/** The ⋯ menu on a project row: refresh, reorder and remove. */
function ProjectMenu(props: {
	section: Accessor<string>;
	actionClass: Accessor<string>;
	refreshing: Accessor<boolean>;
	open: Signal<boolean>;
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
			popupClass="min-w-32"
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
			<MenuItem
				testID={`${section()}:menu:refresh`}
				icon={<Icon name="RefreshCw" size={14} />}
				disabled={props.refreshing()}
				onSelect={props.onRefresh}
			>
				<Text class="font-sans">{() => t("sidebar.refreshSessions")}</Text>
			</MenuItem>
			{props.canMove ? (
				<>
					<MenuItem
						testID={`${section()}:menu:move-up`}
						icon={<Icon name="ArrowUp" size={14} />}
						disabled={!props.canMove?.(-1)}
						onSelect={() => props.onMove(-1)}
					>
						<Text class="font-sans">{() => t("sidebar.moveUp")}</Text>
					</MenuItem>
					<MenuItem
						testID={`${section()}:menu:move-down`}
						icon={<Icon name="ArrowDown" size={14} />}
						disabled={!props.canMove?.(1)}
						onSelect={() => props.onMove(1)}
					>
						<Text class="font-sans">{() => t("sidebar.moveDown")}</Text>
					</MenuItem>
				</>
			) : null}
			{props.removable ? (
				<MenuItem
					testID={`${section()}:menu:remove`}
					variant="destructive"
					icon={<Icon name="Trash2" size={14} />}
					disabled={props.refreshing()}
					closeOnSelect={false}
					onSelect={() => {
						if (!props.confirmingRemove()) {
							props.confirmingRemove.set(true);
							return;
						}
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
		</Menu>
	);
}

/** An expanded project's latest sessions and its 「查看全部」. */
function ProjectSessions(props: {
	store: AppStore;
	projectId: Accessor<string>;
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
		const listed = sidebarSessions(state, props.projectId(), t("app.newChat"));
		const open = state.navigation.session;
		const opened =
			open?.projectId === props.projectId()
				? listed.find((session) => session.sessionPath === open.sessionPath)
				: undefined;
		return summarizeProjectSessions(listed, opened?.id ?? null);
	});
	return (
		<>
			{() =>
				sessions().visible.length > 0 ? (
					<SessionGlide>
						<Each
							of={sessions().visible}
							key={(session) => session.sessionPath}
						>
							{(session) => <SessionRow store={store} session={session} />}
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
						class="px-3 py-2 text-center font-sans text-xs text-destructive"
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
				<Text class="min-w-0 flex-1 truncate font-sans text-xs text-sidebar-foreground-muted group-hover:text-sidebar-hover-foreground">
					{() => t("sidebar.viewAll")}
				</Text>
			</Button>
		</View>
	);
}

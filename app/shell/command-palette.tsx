import {
	type Accessor,
	computed,
	effect,
	signal,
	Text,
	token,
	untracked,
	View,
	windowSize,
} from "nsh";
import type { CommandItem } from "nsh/base";

import type { SessionSearchMatch } from "@shared/api/sessions-types";
import type { KeyboardShortcutMap } from "@shared/keyboard-shortcuts-types";
import { displayProjectPath } from "@shared/project-path";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import { Command } from "../ui/command";
import { CommandDialog } from "../ui/command-dialog";
import { Icon, type IconName } from "../ui/icon";
import { tactileTransition, useMountedDialog } from "../ui/motion";
import { Spinner } from "../ui/spinner";
import { t } from "./i18n";
import { sidebarSessions } from "./sidebar-projects";

export interface CommandPaletteProps {
	/** When supplied, keeps the dialog mounted so its close fade can complete. */
	open?: Accessor<boolean>;
	/** Touch-first rows and no keyboard-only footer hints. */
	touch?: boolean;
	store: AppStore;
	shortcuts: Accessor<Partial<KeyboardShortcutMap>>;
	/** Searches saved message text; the message group is absent without it. */
	searchSessions?: Pick<NshPiloClient, "searchSessions">;
	/** Opens the settings dialog; the settings action is absent without it. */
	onOpenSettings?: () => void;
	onNewTemporaryChat?: (projectId: string) => void;
	onOpenGit?: (projectId: string) => void;
	onOpenTerminal?: (projectId: string) => void;
	onShowChat?: (projectId?: string) => void;
	onClose: () => void;
}

/** A match in a saved session's messages. */
type ContentResult = SessionSearchMatch & { projectId: string; title: string };

/** What an item's row draws: an icon, the label, inline metadata, and optional second line. */
type Row = {
	icon: IconName;
	/** Inline muted metadata: action context, project path, or session project. */
	meta?: string;
	/** Align inline metadata to the trailing edge (e.g. session project label). */
	metaAlign?: "inline" | "end";
	/** A secondary line beneath the title (session preview). */
	detail?: string;
	/** A message match's excerpt beneath its session title. */
	snippet?: string;
	role?: "user" | "assistant";
	running?: boolean;
	archived?: boolean;
};

/** How long after the last keystroke the message search runs, as in the WebUI. */
const SEARCH_DEBOUNCE_MS = 220;
/** Rows shown while the query is empty. */
const SESSION_LIMIT = 18;
const PROJECT_LIMIT = 8;
/** Matches asked of each project, and kept in total. */
const CONTENT_PROJECT_LIMIT = 12;
const CONTENT_LIMIT = 30;

/**
 * The global search: projects, sessions, and the messages of every project,
 * then the actions. A session or a project goes straight to
 * it, a match opens its session.
 */
export function CommandPalette(props: CommandPaletteProps) {
	const isOpen = () => (props.open ? props.open() : true);
	const dialog = useMountedDialog(isOpen);
	const { store } = props;
	const query = signal("");
	const content = signal<ContentResult[]>([]);
	const searching = signal(false);
	let request = 0;
	// Project scans run one at a time to bound the load, as in the WebUI.
	let queue: Promise<void> = Promise.resolve();

	const projects = computed(() => store.state().projects);
	const projectById = computed(
		() => new Map(projects().map((project) => [project.id, project])),
	);
	// Opening reads the sessions of projects not read yet, or whose read
	// failed. Read ones stay current through the Host's session watchers, so
	// they are not scanned again on every open.
	effect(() => {
		if (!isOpen()) return;
		untracked(() => {
			query.set("");
			content.set([]);
			searching.set(false);
			request += 1;
			const { projects, sessionIndexes } = store.state();
			for (const project of projects) {
				const status = sessionIndexes[project.id]?.status;
				if (status === undefined || status === "failed") {
					void store.loadSessions(project.id);
				}
			}
		});
	});
	const catalogProjects = computed(() => store.state().projects);
	const catalogIndexes = computed(() => store.state().sessionIndexes);
	const catalogChats = computed(() => store.state().chatSessions);
	const catalogRunningSince = computed(() => store.state().runningSince);
	const catalogExternal = computed(() => store.state().externalActivity);
	const catalogReadStates = computed(() => store.state().readStates);
	const indexedProjects = computed(() =>
		projects().map((project) => {
			const displayPath = displayProjectPath(project.path);
			return {
				project,
				displayPath,
				haystack:
					`${project.name}\n${project.path}\n${displayPath}`.toLowerCase(),
			};
		}),
	);
	const catalog = computed(() => {
		catalogProjects();
		catalogIndexes();
		catalogChats();
		catalogRunningSince();
		catalogExternal();
		catalogReadStates();
		const state = untracked(store.state);
		const byId = untracked(projectById);
		return state.projects
			.flatMap((project) =>
				// New chats Pi has not saved yet are not sessions to open by file.
				sidebarSessions(state, project.id, t("app.newChat"), "all").filter(
					(session) => session.sessionPath !== "",
				),
			)
			.sort((a, b) => b.latestMessageAt.getTime() - a.latestMessageAt.getTime())
			.map((session) => ({
				session,
				haystack:
					`${session.title}\n${session.preview ?? ""}\n${session.sessionPath}\n${byId.get(session.projectId)?.name ?? ""}\n${session.archivedAt != null ? t("sidebar.archived") : ""}`.toLowerCase(),
			}));
	});
	const normalized = () => query().trim().toLowerCase();
	const projectResults = computed(() => {
		const q = normalized();
		const all = indexedProjects();
		if (!q) return all.slice(0, PROJECT_LIMIT).map((entry) => entry.project);
		const matched: (typeof all)[number]["project"][] = [];
		for (const entry of all) {
			if (entry.haystack.includes(q)) matched.push(entry.project);
		}
		return matched;
	});
	const MAX_FILTERED_SESSIONS = 80;
	const sessionResults = computed(() => {
		const q = normalized();
		const all = catalog();
		if (!q) return all.slice(0, SESSION_LIMIT).map((entry) => entry.session);
		const matched = [];
		for (const entry of all) {
			if (entry.haystack.includes(q)) {
				matched.push(entry.session);
				if (matched.length >= MAX_FILTERED_SESSIONS) break;
			}
		}
		return matched;
	});
	/** The project a "new session" starts in: the selected one, else the first. */
	const newSessionProject = () => activeProject(store.state());
	const actionResults = computed(() => {
		const q = normalized();
		const project = newSessionProject();
		const actions: {
			id: string;
			label: string;
			icon: IconName;
			meta?: string;
			shortcut?: string;
			keywords: string[];
		}[] = [];
		if (project) {
			actions.push({
				id: "action:new-session",
				label: t("app.newChat"),
				icon: "SquarePen",
				meta: project.name,
				shortcut: props.shortcuts()["new-chat"],
				keywords: ["new", "chat", "session", "新建", "对话", "会话"],
			});
			if (props.onNewTemporaryChat) {
				actions.push({
					id: "action:temporary-chat",
					label: t("app.temporaryChat"),
					icon: "MessageSquareDashed",
					meta: project.name,
					keywords: ["temp", "temporary", "incognito", "临时", "会话"],
				});
			}
			if (props.onOpenGit) {
				actions.push({
					id: "action:open-git",
					label: t("file.viewChanges"),
					icon: "GitBranch",
					meta: project.name,
					keywords: ["git", "diff", "changes", "变更", "差异"],
				});
			}
			if (props.onOpenTerminal) {
				actions.push({
					id: "action:open-terminal",
					label: t("terminal.new"),
					icon: "SquareTerminal",
					meta: project.name,
					keywords: ["terminal", "shell", "console", "终端"],
				});
			}
		}
		if (props.onOpenSettings)
			actions.push({
				id: "action:settings",
				label: t("settings.title"),
				icon: "Settings",
				shortcut: props.shortcuts()["open-settings"],
				keywords: ["settings", "preferences", "options", "设置", "偏好"],
			});
		return actions.filter(
			(action) =>
				!q ||
				action.label.toLocaleLowerCase().includes(q) ||
				action.keywords.some((keyword) =>
					keyword.toLocaleLowerCase().includes(q),
				),
		);
	});

	const results = computed(() => {
		const q = normalized();
		const items: CommandItem[] = [];
		const rows = new Map<string, Row>();
		const add = (item: CommandItem, row: Row) => {
			items.push(item);
			rows.set(item.id, row);
		};
		for (const action of actionResults()) {
			add(
				{
					id: action.id,
					label: action.label,
					group: t("commandPalette.actionGroup"),
					shortcut: action.shortcut,
					keywords: action.keywords,
				},
				{
					icon: action.icon,
					meta: action.meta,
					metaAlign: "inline",
				},
			);
		}
		for (const project of projectResults()) {
			add(
				{
					id: `project:${project.id}`,
					label: project.name,
					group: t("commandPalette.projectGroup"),
				},
				{
					icon: "Folder",
					meta: displayProjectPath(project.path),
					metaAlign: "inline",
				},
			);
		}
		const sessionGroup = q
			? t("commandPalette.sessionGroup")
			: t("commandPalette.recentSessions");
		for (const session of sessionResults()) {
			const projectName =
				projectById().get(session.projectId)?.name ??
				t("commandPalette.projectFallback");
			add(
				{
					id: `session:${session.projectId}:${session.sessionPath}`,
					label: session.title,
					group: sessionGroup,
				},
				{
					icon: "MessagesSquare",
					meta: projectName,
					metaAlign: "end",
					detail: session.preview || undefined,
					running: session.active,
					archived: session.archivedAt != null,
				},
			);
		}
		content().forEach((match, index) => {
			const projectName = projectById().get(match.projectId)?.name;
			const entry = store
				.state()
				.sessionIndexes[match.projectId]?.sessions.find(
					(session) => session.sessionPath === match.sessionPath,
				);
			add(
				{
					id: `content:${index}`,
					label: match.title,
					group: t("commandPalette.messageGroup"),
				},
				{
					icon: "MessageSquareText",
					meta: projectName,
					metaAlign: "end",
					snippet: match.snippet,
					role: match.role,
					archived: entry?.archivedAt != null,
				},
			);
		});
		return { items, rows };
	});

	// The message search: 220 ms after the query settles, each project's saved
	// messages are searched in turn until thirty matches.
	effect(() => {
		const value = query().trim();
		const ticket = ++request;
		if (value.length < 2 || !props.searchSessions) {
			content.set([]);
			searching.set(false);
			return;
		}
		searching.set(true);
		const timer = setTimeout(() => {
			const searchSessions = props.searchSessions;
			queue = queue.then(async () => {
				if (ticket !== request || !searchSessions) return;
				const titles = new Map(
					catalog().map(({ session }) => [
						`${session.projectId}\0${session.sessionPath}`,
						session.title,
					]),
				);
				const next: ContentResult[] = [];
				for (const project of store.state().projects) {
					if (ticket !== request) return;
					try {
						// oxlint-disable-next-line no-await-in-loop -- serial on purpose.
						const matches = await searchSessions.searchSessions(
							project.id,
							value,
							CONTENT_PROJECT_LIMIT,
						);
						for (const match of matches) {
							next.push({
								...match,
								projectId: project.id,
								title:
									titles.get(`${project.id}\0${match.sessionPath}`) ??
									t("commandPalette.sessionFallback"),
							});
						}
					} catch {
						// Keep the matches of the projects that still answer.
					}
					if (next.length >= CONTENT_LIMIT) break;
				}
				if (ticket !== request) return;
				content.set(next.slice(0, CONTENT_LIMIT));
				searching.set(false);
			});
		}, SEARCH_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	});

	const select = (id: string) => {
		if (id === "action:new-session") {
			const project = newSessionProject();
			if (project) {
				props.onShowChat?.(project.id);
				store.selectProject(project.id);
			}
		} else if (id === "action:temporary-chat") {
			const project = newSessionProject();
			if (project) props.onNewTemporaryChat?.(project.id);
		} else if (id === "action:open-git") {
			const project = newSessionProject();
			if (project) props.onOpenGit?.(project.id);
		} else if (id === "action:open-terminal") {
			const project = newSessionProject();
			if (project) props.onOpenTerminal?.(project.id);
		} else if (id === "action:settings") {
			props.onOpenSettings?.();
		} else if (id.startsWith("project:")) {
			const projectId = id.slice("project:".length);
			props.onShowChat?.(projectId);
			store.selectProject(projectId);
		} else if (id.startsWith("session:")) {
			const rest = id.slice("session:".length);
			const separator = rest.indexOf(":");
			const projectId = rest.slice(0, separator);
			props.onShowChat?.(projectId);
			store.selectSession(projectId, rest.slice(separator + 1));
		} else if (id.startsWith("content:")) {
			const match = content()[Number(id.slice("content:".length))];
			if (match) {
				props.onShowChat?.(match.projectId);
				store.selectSession(match.projectId, match.sessionPath);
			}
		}
		props.onClose();
	};

	const narrow = computed(() => windowSize().width < 520);

	return (
		<CommandDialog
			open={isOpen()}
			accessibilityLabel={t("commandPalette.title")}
			onOpenChange={({ open }) => {
				if (!open) props.onClose();
			}}
			onClose={dialog.onClose}
		>
			{() =>
				dialog.mounted() ? (
					<Command
						items={results().items}
						filterable={false}
						loading={searching()}
						autoFocus
						placeholder={t("commandPalette.placeholder")}
						accessibilityLabel={t("commandPalette.title")}
						searchAccessibilityLabel={t("commandPalette.placeholder")}
						searchBarClass="gap-2.5 border-b border-border/80 px-3.5"
						searchBarStyle={{ height: 48 }}
						searchClass="h-full flex-1 bg-transparent text-[14px] leading-5 outline-hidden placeholder:text-muted-foreground"
						searchSuffix={
							searching() ? (
								<Spinner size={14} color={token("muted-foreground")} />
							) : undefined
						}
						listClass="min-h-0 flex-1 mx-2 mt-0.5 mb-2"
						groupClass="px-2.5 pt-2.5 pb-1 text-[11px] leading-4 font-medium text-muted-foreground"
						itemClass={`group flex-col items-stretch justify-center rounded-(--pilo-radius-md) px-2.5 text-[13px] leading-[18px] text-foreground outline-hidden hover:bg-hover focus:bg-hover hover:text-hover-foreground focus:text-hover-foreground disabled:opacity-50 ${
							props.touch ? "min-h-11 py-2.5" : "py-2"
						}`}
						itemStyle={[
							tactileTransition("background-color, color"),
							{ marginBottom: 2 },
						]}
						renderItem={(entry) => {
							const row = results().rows.get(entry.id);
							if (!row) return <Text class="font-sans">{entry.label}</Text>;
							const stackInlineMeta =
								narrow() && row.metaAlign === "inline" && Boolean(row.meta);
							const secondaryLine =
								row.detail ?? (stackInlineMeta ? row.meta : undefined);
							const showInlineMeta = Boolean(row.meta) && !stackInlineMeta;
							const hasTwoLines = Boolean(secondaryLine || row.snippet);
							return (
								<View
									class={`w-full flex-row gap-2.5 ${
										hasTwoLines ? "items-start" : "items-center"
									}`}
								>
									<View
										class={`shrink-0 items-center justify-center ${
											hasTwoLines ? "mt-0.5" : ""
										}`}
									>
										<Icon
											name={row.icon}
											size={15}
											color={token("muted-foreground")}
										/>
									</View>
									<View class="min-w-0 flex-1 gap-0.5">
										<View class="flex-row items-center gap-2">
											<Text
												class={`font-sans truncate text-[13px] font-medium text-foreground ${
													showInlineMeta && row.metaAlign === "inline"
														? "max-w-[48%] shrink-0"
														: "min-w-0 flex-1"
												}`}
											>
												{entry.label}
											</Text>
											{row.running ? (
												<View class="size-1.5 shrink-0 rounded-full bg-status-success" />
											) : null}
											{row.archived ? (
												<View class="shrink-0 rounded-sm bg-muted/80 px-1.5 py-0.5">
													<Text class="font-sans text-[10px] leading-3 font-medium text-muted-foreground">
														{() => t("sidebar.archived")}
													</Text>
												</View>
											) : null}
											{row.role ? (
												<View class="shrink-0 rounded-sm bg-muted/80 px-1.5 py-0.5">
													<Text class="font-sans text-[10px] leading-3 font-medium text-muted-foreground">
														{row.role === "user"
															? t("commandPalette.user")
															: t("common.agent")}
													</Text>
												</View>
											) : null}
											{showInlineMeta ? (
												<Text
													class={`font-sans truncate text-xs text-muted-foreground ${
														row.metaAlign === "end"
															? "max-w-[36%] shrink-0"
															: "min-w-0 flex-1"
													}`}
												>
													{row.meta}
												</Text>
											) : null}
										</View>
										{secondaryLine ? (
											<Text class="font-sans truncate text-[11px] leading-4 text-muted-foreground">
												{secondaryLine}
											</Text>
										) : null}
										{row.snippet ? (
											<Text class="font-sans line-clamp-2 text-[11px] leading-[1.45] text-muted-foreground">
												{row.snippet}
											</Text>
										) : null}
									</View>
									{entry.shortcutLabel ? (
										<KeyCap keys={entry.shortcutLabel} />
									) : null}
								</View>
							);
						}}
						onQueryChange={({ query: next }) => query.set(next)}
						onSelect={({ id }) => select(id)}
						onCancel={() => props.onClose()}
						empty={
							<View class="items-center gap-2 py-8">
								<Icon
									name="Search"
									size={18}
									color={token("muted-foreground")}
								/>
								<Text class="font-sans text-xs text-muted-foreground">
									{t("commandPalette.noResults")}
								</Text>
							</View>
						}
						footer={
							props.touch && !searching() ? undefined : (
								<View class="shrink-0 flex-row items-center justify-between gap-2 border-t border-border/80 bg-muted/35 px-3.5 py-2">
									{searching() ? (
										<View class="flex-row items-center gap-1.5">
											<Spinner size={12} color={token("muted-foreground")} />
											<Text class="font-sans text-[11px] text-muted-foreground">
												{t("commandPalette.searchingHistory")}
											</Text>
										</View>
									) : (
										<View class="flex-row items-center gap-3.5">
											<Hint
												keys="↑↓"
												label={() => t("commandPalette.toggle")}
											/>
											<Hint keys="↵" label={() => t("commandPalette.select")} />
										</View>
									)}
									{props.touch ? null : (
										<Hint keys="esc" label={() => t("commandPalette.close")} />
									)}
								</View>
							)
						}
					/>
				) : null
			}
		</CommandDialog>
	);
}

/** A key cap for keyboard shortcuts and footer hints. */
function KeyCap(props: { keys: string }) {
	return (
		<View class="h-[19px] min-w-[19px] shrink-0 items-center justify-center rounded-[4px] border border-border/80 bg-background/80 px-1.5">
			<Text class="font-sans text-[10px] leading-3 font-medium text-muted-foreground">
				{props.keys}
			</Text>
		</View>
	);
}

/** A key cap and what it does, as in the WebUI palette's footer. */
function Hint(props: { keys: string; label: () => string }) {
	return (
		<View class="flex-row items-center gap-1.5">
			<KeyCap keys={props.keys} />
			<Text class="font-sans text-[11px] text-muted-foreground">
				{props.label()}
			</Text>
		</View>
	);
}

import {
	type Accessor,
	computed,
	effect,
	signal,
	Text,
	untracked,
	View,
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
import { Spinner } from "../ui/spinner";
import { t } from "./i18n";
import { sidebarSessions } from "./sidebar-projects";

export interface CommandPaletteProps {
	store: AppStore;
	shortcuts: Accessor<Partial<KeyboardShortcutMap>>;
	/** Searches saved message text; the message group is absent without it. */
	searchSessions?: Pick<NshPiloClient, "searchSessions">;
	/** Opens the settings dialog; the settings action is absent without it. */
	onOpenSettings?: () => void;
	onClose: () => void;
}

/** A match in a saved session's messages. */
type ContentResult = SessionSearchMatch & { projectId: string; title: string };

/** What an item's row draws: an icon, the label, and a dimmer second line. */
type Row = {
	icon: IconName;
	/** A project path, or a session's project and first message. */
	detail?: string;
	/** A message match's text (the row's second line is its title). */
	snippet?: string;
	role?: "user" | "assistant";
	running?: boolean;
};

/** How long after the last keystroke the message search runs, as in Tauri. */
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
	const { store } = props;
	const query = signal("");
	const content = signal<ContentResult[]>([]);
	const searching = signal(false);
	let request = 0;
	// Project scans run one at a time to bound the load, as in the Tauri app.
	let queue: Promise<void> = Promise.resolve();

	const projects = computed(() => store.state().projects);
	const projectById = computed(
		() => new Map(projects().map((project) => [project.id, project])),
	);
	// Opening reads the sessions of projects not read yet, or whose read
	// failed. Read ones stay current through the Host's session watchers, so
	// they are not scanned again on every open.
	untracked(() => {
		const { projects, sessionIndexes } = store.state();
		for (const project of projects) {
			const status = sessionIndexes[project.id]?.status;
			if (status === undefined || status === "failed") {
				void store.loadSessions(project.id);
			}
		}
	});
	const catalog = computed(() => {
		const state = store.state();
		return state.projects
			.flatMap((project) =>
				// New chats Pi has not saved yet are not sessions to open by file.
				sidebarSessions(state, project.id, t("app.newChat")).filter(
					(session) => session.sessionPath !== "",
				),
			)
			.sort(
				(a, b) => b.latestMessageAt.getTime() - a.latestMessageAt.getTime(),
			);
	});
	const normalized = () => query().trim().toLocaleLowerCase();
	const projectResults = computed(() => {
		const q = normalized();
		if (!q) return projects().slice(0, PROJECT_LIMIT);
		return projects().filter((project) =>
			[project.name, project.path, displayProjectPath(project.path)]
				.join("\n")
				.toLocaleLowerCase()
				.includes(q),
		);
	});
	const sessionResults = computed(() => {
		const q = normalized();
		if (!q) return catalog().slice(0, SESSION_LIMIT);
		return catalog().filter((session) =>
			[
				session.title,
				session.preview ?? "",
				session.sessionPath,
				projectById().get(session.projectId)?.name ?? "",
			]
				.join("\n")
				.toLocaleLowerCase()
				.includes(q),
		);
	});
	/** The project a "new session" starts in: the selected one, else the first. */
	const newSessionProject = () => activeProject(store.state());
	const actionResults = computed(() => {
		const q = normalized();
		const actions: { id: string; label: string; shortcut?: string }[] = [];
		if (newSessionProject())
			actions.push({
				id: "action:new-session",
				label: t("app.newChat"),
				shortcut: props.shortcuts()["new-chat"],
			});
		if (props.onOpenSettings)
			actions.push({
				id: "action:settings",
				label: t("settings.title"),
				shortcut: props.shortcuts()["open-settings"],
			});
		return actions.filter(
			(action) => !q || action.label.toLocaleLowerCase().includes(q),
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
					keywords:
						action.id === "action:settings"
							? ["settings", "preferences", "options"]
							: ["new", "chat", "session"],
				},
				{
					icon: action.id === "action:settings" ? "Settings" : "SquarePen",
					detail:
						action.id === "action:settings"
							? undefined
							: newSessionProject()?.name,
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
				{ icon: "Folder", detail: displayProjectPath(project.path) },
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
					detail: `${projectName}${session.preview ? ` · ${session.preview}` : ""}`,
					running: session.active,
				},
			);
		}
		content().forEach((match, index) => {
			add(
				{
					id: `content:${index}`,
					label: match.title,
					group: t("commandPalette.messageGroup"),
				},
				{
					icon: "MessageSquareText",
					detail: match.title,
					snippet: match.snippet,
					role: match.role,
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
					catalog().map((session) => [
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
			if (project) store.selectProject(project.id);
		} else if (id === "action:settings") {
			props.onOpenSettings?.();
		} else if (id.startsWith("project:")) {
			store.selectProject(id.slice("project:".length));
		} else if (id.startsWith("session:")) {
			const rest = id.slice("session:".length);
			const separator = rest.indexOf(":");
			store.selectSession(rest.slice(0, separator), rest.slice(separator + 1));
		} else if (id.startsWith("content:")) {
			const match = content()[Number(id.slice("content:".length))];
			if (match) store.selectSession(match.projectId, match.sessionPath);
		}
		props.onClose();
	};

	return (
		<CommandDialog
			open
			accessibilityLabel={t("commandPalette.title")}
			onOpenChange={({ open }) => {
				if (!open) props.onClose();
			}}
		>
			<Command
				items={results().items}
				filterable={false}
				loading={searching()}
				autoFocus
				placeholder={t("commandPalette.placeholder")}
				accessibilityLabel={t("commandPalette.title")}
				searchAccessibilityLabel={t("commandPalette.placeholder")}
				listClass="min-h-0 flex-1 p-1"
				renderItem={(entry) => {
					const row = results().rows.get(entry.id);
					if (!row) return <Text class="font-sans">{entry.label}</Text>;
					return (
						<View class="w-full flex-row items-center gap-3">
							<Icon name={row.icon} size={16} class="shrink-0 opacity-60" />
							<View class="min-w-0 flex-1">
								<View class="flex-row items-center gap-2">
									<Text
										class={`font-sans min-w-0 flex-1 truncate ${
											row.snippet
												? "text-xs font-medium text-foreground/90"
												: "text-sm"
										}`}
									>
										{entry.label}
									</Text>
									{row.role ? (
										<Text class="font-sans text-xs text-muted-foreground">
											{row.role === "user"
												? t("commandPalette.user")
												: t("common.agent")}
										</Text>
									) : null}
									{row.running ? (
										<View class="size-1.5 shrink-0 rounded-full bg-status-success" />
									) : null}
								</View>
								{row.detail ? (
									<Text class="font-sans truncate text-[11px] text-muted-foreground">
										{row.detail}
									</Text>
								) : null}
								{row.snippet ? (
									<Text class="font-sans mt-0.5 line-clamp-2 text-[11px] leading-[1.45] text-muted-foreground">
										{row.snippet}
									</Text>
								) : null}
							</View>
							{entry.shortcutLabel ? (
								<Text class="font-sans text-xs tracking-widest text-muted-foreground">
									{entry.shortcutLabel}
								</Text>
							) : null}
						</View>
					);
				}}
				onQueryChange={({ query: next }) => query.set(next)}
				onSelect={({ id }) => select(id)}
				onCancel={() => props.onClose()}
				empty={
					<Text class="font-sans text-muted-foreground">
						{t("commandPalette.noResults")}
					</Text>
				}
				footer={
					<View class="shrink-0 flex-row items-center justify-between gap-2 border-t border-border px-4 py-2.5">
						{searching() ? (
							<View class="flex-row items-center gap-1.5">
								<Spinner size={12} />
								<Text class="font-sans text-[11px] text-muted-foreground">
									{t("commandPalette.searchingHistory")}
								</Text>
							</View>
						) : (
							<View class="flex-row items-center gap-3">
								<Hint keys="↑↓" label={() => t("commandPalette.toggle")} />
								<Hint keys="↵" label={() => t("commandPalette.select")} />
							</View>
						)}
						<Hint keys="esc" label={() => t("commandPalette.close")} />
					</View>
				}
			/>
		</CommandDialog>
	);
}

/** A key cap and what it does, as in the Tauri palette's footer. */
function Hint(props: { keys: string; label: () => string }) {
	return (
		<View class="flex-row items-center gap-1">
			<View class="h-5 min-w-5 items-center justify-center rounded-sm bg-muted px-1">
				<Text class="font-sans text-[11px] font-medium text-muted-foreground">
					{props.keys}
				</Text>
			</View>
			<Text class="font-sans text-[11px] text-muted-foreground">
				{props.label()}
			</Text>
		</View>
	);
}

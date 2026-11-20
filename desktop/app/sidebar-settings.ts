import { type Accessor, signal, Storage } from "nsh";

/** How the sidebar lists sessions: under their projects, or newest first. */
export type SidebarView = "projects" | "recent";

export type SidebarSettings = {
	/**
	 * Whether the user collapsed or expanded a section, by the section's key:
	 * `recent`, `env:<connection id>` or `ws:<project id>`. A section without
	 * a key keeps its own default (a project starts collapsed).
	 */
	collapsedSections: Record<string, boolean>;
	/**
	 * A connection's project order as the row menu's moves leave it, by
	 * connection id. Projects a saved list does not name keep their catalog
	 * places after the ordered ones.
	 */
	projectOrder: Record<string, readonly string[]>;
	view: SidebarView;
	/** The recent view names each session's project. */
	showProjectsInRecents: boolean;
};

/** The Tauri app's localStorage keys, so its stored values carry over. */
const COLLAPSED_SECTIONS_KEY = "pilo.collapsedSections";
const PROJECT_ORDER_KEY = "pilo.sidebarProjectOrder";
const VIEW_KEY = "pilo.sidebarOrganizeMode";
const SHOW_PROJECTS_IN_RECENTS_KEY = "pilo.sidebarShowProjectsInRecents";

const DEFAULTS: SidebarSettings = {
	collapsedSections: {},
	projectOrder: {},
	view: "projects",
	showProjectsInRecents: false,
};

/** The sidebar's stored settings: read once from storage, saved on change. */
export class SidebarSettingsStore {
	private readonly current = signal(DEFAULTS);
	private readonly isLoaded = signal(false);

	readonly settings: Accessor<SidebarSettings> = () => this.current();
	/** False until `load` has read storage; changes before it are lost. */
	readonly loaded: Accessor<boolean> = () => this.isLoaded();

	async load(): Promise<void> {
		const [sections, order, view, showProjects] = await Promise.all([
			Storage.getItem(COLLAPSED_SECTIONS_KEY),
			Storage.getItem(PROJECT_ORDER_KEY),
			Storage.getItem(VIEW_KEY),
			Storage.getItem(SHOW_PROJECTS_IN_RECENTS_KEY),
		]);
		this.current.set({
			collapsedSections: parseCollapsedSections(sections),
			projectOrder: parseProjectOrder(order),
			view: view === "recent" ? "recent" : "projects",
			showProjectsInRecents: showProjects === "1",
		});
		this.isLoaded.set(true);
	}

	setSectionCollapsed(id: string, collapsed: boolean): Promise<void> {
		const collapsedSections = {
			...this.current().collapsedSections,
			[id]: collapsed,
		};
		this.current.set({ ...this.current(), collapsedSections });
		return Storage.setItem(
			COLLAPSED_SECTIONS_KEY,
			JSON.stringify(collapsedSections),
		);
	}

	/** Saves a connection's project order, as a row's move left it. */
	setProjectOrder(
		connectionId: string,
		order: readonly string[],
	): Promise<void> {
		const projectOrder = {
			...this.current().projectOrder,
			[connectionId]: order,
		};
		this.current.set({ ...this.current(), projectOrder });
		return Storage.setItem(PROJECT_ORDER_KEY, JSON.stringify(projectOrder));
	}

	setView(view: SidebarView): Promise<void> {
		this.current.set({ ...this.current(), view });
		return Storage.setItem(VIEW_KEY, view);
	}

	setShowProjectsInRecents(showProjectsInRecents: boolean): Promise<void> {
		this.current.set({ ...this.current(), showProjectsInRecents });
		return Storage.setItem(
			SHOW_PROJECTS_IN_RECENTS_KEY,
			showProjectsInRecents ? "1" : "0",
		);
	}
}

/** The stored sections that are booleans; anything else is dropped. */
function parseCollapsedSections(
	stored: string | null,
): Record<string, boolean> {
	if (!stored) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(parsed).filter(
			(entry): entry is [string, boolean] => typeof entry[1] === "boolean",
		),
	);
}

/** The stored orders that are string lists; anything else is dropped. */
function parseProjectOrder(
	stored: string | null,
): Record<string, readonly string[]> {
	if (!stored) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(stored);
	} catch {
		return {};
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(parsed).filter(
			(entry): entry is [string, string[]] =>
				Array.isArray(entry[1]) &&
				entry[1].every((id) => typeof id === "string"),
		),
	);
}

import { type Accessor, signal, Storage } from "nsh";

import {
	hostStorageKey,
	LOCAL_HOST_ID,
	readMigratedStorage,
} from "@shared/host-id";

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
	 * A connection's previously saved project order, by connection id.
	 * Projects a saved list does not name keep their catalog places after the
	 * ordered ones.
	 */
	projectOrder: Record<string, readonly string[]>;
	view: SidebarView;
	/** The recent view names each session's project. */
	showProjectsInRecents: boolean;
};

/**
 * The WebUI's localStorage keys. nsh's `Storage` is not the WebView's
 * localStorage, so values the WebUI saved do not carry over.
 */
const COLLAPSED_SECTIONS_KEY = "pilo.collapsedSections";
const PROJECT_ORDER_KEY = "pilo.sidebarProjectOrder";
const VIEW_KEY = "pilo.sidebarOrganizeMode";
const SHOW_PROJECTS_IN_RECENTS_KEY = "pilo.sidebarShowProjectsInRecents";
const WIDTH_KEY = "pilo.sidebarWidth";

// Match the WebUI sidebar's default and resize limits.
export const MIN_SIDEBAR_WIDTH = 240;
export const MAX_SIDEBAR_WIDTH = 480;
export const DEFAULT_SIDEBAR_WIDTH = 292;

function clampWidth(width: number): number {
	return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

const DEFAULTS: SidebarSettings = {
	collapsedSections: {},
	projectOrder: {},
	view: "projects",
	showProjectsInRecents: false,
};

/** The sidebar's stored settings: read once from storage, saved on change. */
export class SidebarSettingsStore {
	private readonly current = signal(DEFAULTS);
	private readonly currentWidth = signal(DEFAULT_SIDEBAR_WIDTH);
	private readonly isLoaded = signal(false);

	readonly settings: Accessor<SidebarSettings> = () => this.current();
	readonly width: Accessor<number> = () => this.currentWidth();
	/** False until `load` has read storage; changes before it are lost. */
	readonly loaded: Accessor<boolean> = () => this.isLoaded();

	constructor(private readonly hostId = LOCAL_HOST_ID) {}

	private readHostSetting(key: string) {
		return readMigratedStorage(
			Storage,
			hostStorageKey(this.hostId, key),
			this.hostId === LOCAL_HOST_ID ? key : undefined,
		);
	}

	async load(): Promise<void> {
		const [sections, order, view, showProjects, width] = await Promise.all([
			this.readHostSetting(COLLAPSED_SECTIONS_KEY),
			this.readHostSetting(PROJECT_ORDER_KEY),
			Storage.getItem(VIEW_KEY),
			Storage.getItem(SHOW_PROJECTS_IN_RECENTS_KEY),
			Storage.getItem(WIDTH_KEY),
		]);
		const savedWidth = Number.parseInt(width ?? "", 10);
		if (Number.isFinite(savedWidth)) {
			this.currentWidth.set(clampWidth(savedWidth));
		}
		this.current.set({
			collapsedSections: parseCollapsedSections(sections),
			projectOrder: parseProjectOrder(order),
			view: view === "recent" ? "recent" : "projects",
			showProjectsInRecents: showProjects === "1",
		});
		this.isLoaded.set(true);
	}

	/** Shows a width while a drag moves; `setWidth` saves the one it ends at. */
	previewWidth(width: number): void {
		this.currentWidth.set(clampWidth(width));
	}

	setWidth(width: number): Promise<void> {
		const next = clampWidth(Math.round(width));
		this.currentWidth.set(next);
		return Storage.setItem(WIDTH_KEY, String(next));
	}

	setSectionCollapsed(id: string, collapsed: boolean): Promise<void> {
		const collapsedSections = {
			...this.current().collapsedSections,
			[id]: collapsed,
		};
		this.current.set({ ...this.current(), collapsedSections });
		return Storage.setItem(
			hostStorageKey(this.hostId, COLLAPSED_SECTIONS_KEY),
			JSON.stringify(collapsedSections),
		);
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

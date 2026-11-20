import {
	type Accessor,
	appInfo,
	computed,
	platform,
	signal,
	Text,
	token,
	View,
	type ViewRef,
	type ViewStyle,
} from "nsh";
import { Button as BaseButton } from "nsh/base";

import type { Theme } from "@/lib/theme-settings-types";
import { Button } from "../ui/button";
import { Foreground } from "../ui/foreground";
import { Icon, type IconName } from "../ui/icon";
import { Skeleton } from "../ui/skeleton";
import { styleVar } from "../ui/theme-style";
import { Tooltip } from "../ui/tooltip";
import { t } from "./i18n";
import { Sidebar, type SidebarProps } from "./Sidebar";
import type { SidebarLayout } from "./sidebar-layout";
import { createHover } from "../ui/hover";
import {
	SidebarAction,
	sidebarFocusRing,
	sidebarForeground,
	sidebarProjectName,
} from "./sidebar-parts";
import {
	DEFAULT_SIDEBAR_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
} from "./sidebar-settings";

export interface SidebarPanelProps extends Omit<
	SidebarProps,
	"viewedProject" | "onViewProject"
> {
	layout: SidebarLayout;
	/** The list shows once the app and the sidebar's settings are ready. */
	listState: Accessor<"loading" | "ready" | "hidden">;
	/** The system's title bar: its height and the room its controls take. */
	titleBar: Accessor<{ height: number; left: number }>;
	onSearch: () => void;
	onNewChat: () => void;
	onOpenSettings?: () => void;
	/** Opens the Remote WebUI dialog; its button glows while the Host runs. */
	remote?: { running: Accessor<boolean>; onOpen: () => void };
	/** The saved theme mode, which the footer's button cycles. */
	theme: Accessor<Theme>;
	onTheme?: (theme: Theme) => void;
}

/** The Tauri sidebar's theme button order. */
const THEME_CYCLE: readonly Theme[] = ["light", "dark", "system"];
const THEME_ICONS = { light: "Sun", dark: "Moon", system: "Monitor" } as const;
const THEME_LABELS = {
	light: "settings.light",
	dark: "settings.dark",
	system: "settings.system",
} as const;

/** The space a CSS length list takes, in points (`0.5rem 4px` → `[8, 4]`). */
function lengths(value: string | number | undefined): number[] {
	if (typeof value === "number") return [value];
	if (!value) return [0];
	return value
		.trim()
		.split(/\s+/)
		.map((part) => {
			const number = Number.parseFloat(part);
			if (!Number.isFinite(number)) return 0;
			return part.endsWith("rem") ? number * 16 : number;
		});
}

/** CSS's one-to-four value shorthand as top, right, bottom and left. */
function edges(value: string | number | undefined) {
	const [top = 0, right = top, bottom = top, left = right] = lengths(value);
	return { top, right, bottom, left };
}

/**
 * A sidebar theme value, which a theme keeps as a token or, when it is a
 * shorthand or a shadow, as a style variable.
 */
function themeValue(name: string): string | number | undefined {
	return (
		styleVar(name as Parameters<typeof styleVar>[0]) ??
		(token as (name: string) => string | number | undefined)(name)
	);
}

/**
 * The card the sidebar draws its content on (the Tauri
 * `.pilo-sidebar-surface`): a floating rounded card in Lody, the full height
 * with a right border in Claude.
 */
function surface() {
	const margin = edges(themeValue("pilo-sidebar-margin"));
	const border = edges(themeValue("pilo-sidebar-border-width"));
	const padding = edges(themeValue("pilo-sidebar-padding"));
	const radius = lengths(themeValue("pilo-sidebar-radius"))[0] ?? 0;
	const style: ViewStyle = {
		marginTop: margin.top,
		marginRight: margin.right,
		marginBottom: margin.bottom,
		marginLeft: margin.left,
		borderTopWidth: border.top,
		borderRightWidth: border.right,
		borderBottomWidth: border.bottom,
		borderLeftWidth: border.left,
		borderColor: token("pilo-sidebar-border-color"),
		borderRadius: radius,
		paddingTop: padding.top,
		paddingRight: padding.right,
		paddingBottom: padding.bottom,
		paddingLeft: padding.left,
		boxShadow: styleVar("pilo-sidebar-shadow"),
		backgroundColor: token("sidebar-background"),
	};
	return {
		style,
		radius,
		top: margin.top + border.top + padding.top,
		left: margin.left + border.left + padding.left,
	};
}

/**
 * The sidebar as the Tauri `AppSidebar` draws it: the header with the app's
 * name and its actions, a new session (or the project's sessions' back
 * button), the list, the footer, and the handle on its edge that resizes it
 * or, dragged past its smallest width, collapses it.
 */
export function SidebarPanel(props: SidebarPanelProps) {
	const { layout } = props;
	const projectView = signal<string | null>(null);
	const card = computed(surface);
	// Center the visible glyphs against the macOS traffic lights without moving the row.
	const titleTextStyle =
		platform.os === "macos" ? { transform: [{ translateY: -1 }] } : undefined;
	// A view of sessions of a project that is gone closes.
	const viewedProject = computed(() => {
		const id = projectView();
		if (id === null || props.settings.settings().view === "recent") return null;
		return (
			props.store.state().projects.find((project) => project.id === id) ?? null
		);
	});
	return (
		<View
			ref={(node: ViewRef) => layout.bindAside(node)}
			testID="sidebar"
			class={`relative h-full shrink-0 transition-opacity duration-200 ease-out ${
				layout.collapsed() ? "overflow-hidden opacity-0" : "opacity-100"
			}`}
			style={{
				width: layout.collapsed() ? 0 : layout.width(),
				pointerEvents: layout.collapsed() ? "none" : "auto",
			}}
			accessibilityElementsHidden={layout.collapsed()}
		>
			<View
				testID="sidebar-surface"
				class="relative min-h-0 flex-1"
				style={card().style}
			>
				<View
					testID="sidebar-title-bar"
					desktop={{ windowDrag: true }}
					class="shrink-0 flex-row items-center px-1.5"
					style={{
						height: props.titleBar().height,
						// Align to the window's title bar, not the inset sidebar card.
						marginTop: -card().top,
						paddingLeft: Math.max(6, props.titleBar().left - card().left),
					}}
				>
					<View class="min-w-0 flex-1 flex-row items-center gap-1.5 px-2">
						<Text
							class="min-w-0 shrink truncate font-sans text-lg font-semibold tracking-tight text-sidebar-foreground"
							style={titleTextStyle}
						>
							Pilo
						</Text>
						{appInfo().development ? (
							<View class="shrink-0 flex-row items-center gap-1 rounded-full bg-primary/10 px-1.5 py-px">
								<View class="size-1.5 animate-pulse rounded-full bg-primary" />
								<Text
									class="font-sans text-[11px] font-semibold uppercase leading-4 tracking-wide text-primary"
									style={titleTextStyle}
								>
									DEV
								</Text>
							</View>
						) : null}
					</View>
					{() =>
						layout.collapsed() || layout.settledCollapsed() ? null : (
							<View class="mr-1 h-7 shrink-0 flex-row items-center gap-0.5 border border-transparent px-2">
								<SidebarAction
									testID="sidebar-search"
									label={t("sidebar.searchSessions")}
									onPress={props.onSearch}
								>
									<Icon name="Search" size={16} />
								</SidebarAction>
								<SidebarAction
									testID="sidebar-collapse"
									label={t("sidebar.collapseSidebar")}
									onPress={() => layout.setCollapsed(true)}
								>
									<Icon name="PanelLeft" size={16} />
								</SidebarAction>
							</View>
						)
					}
				</View>
				<View class="-mt-1 shrink-0 gap-1 px-1.5">
					{() => {
						const project = viewedProject();
						return project ? (
							<ProjectSessionsToolbar
								name={sidebarProjectName(project)}
								onBack={() => projectView.set(null)}
								onNewChat={() => props.store.selectProject(project.id)}
							/>
						) : (
							<NewChatButton onPress={props.onNewChat} />
						);
					}}
				</View>
				{/* Only the list and footer are clipped to the card's rounded bottom. */}
				<View
					class="min-h-0 flex-1 overflow-hidden"
					style={{
						borderBottomLeftRadius: card().radius,
						borderBottomRightRadius: card().radius,
					}}
				>
					{() => {
						switch (props.listState()) {
							case "ready":
								return (
									<Sidebar
										store={props.store}
										settings={props.settings}
										viewedProject={viewedProject}
										onViewProject={(id) => projectView.set(id)}
										defaultWorkspaceShown={props.defaultWorkspaceShown}
										onDefaultWorkspaceShown={props.onDefaultWorkspaceShown}
										onAddProject={props.onAddProject}
										onRemoveConnection={props.onRemoveConnection}
									/>
								);
							case "loading":
								return <SidebarLoading />;
							case "hidden":
								return <View class="min-h-0 flex-1" />;
						}
					}}
					<View class="relative shrink-0 flex-row items-center gap-1 border-t border-sidebar-border px-1.5 py-1">
						{props.onOpenSettings ? (
							<Button
								testID="sidebar-settings"
								variant="ghost"
								size="icon"
								accessibilityLabel={t("settings.title")}
								tooltip={
									<Tooltip>
										<Text class="font-sans">{() => t("settings.title")}</Text>
									</Tooltip>
								}
								onPress={props.onOpenSettings}
							>
								<Icon name="Settings" />
							</Button>
						) : null}
						<View class="ml-auto flex-row items-center gap-1">
							{props.remote ? <RemoteButton {...props.remote} /> : null}
							{props.onTheme ? (
								<ThemeCycleButton theme={props.theme} onTheme={props.onTheme} />
							) : null}
						</View>
					</View>
				</View>
			</View>
			{() =>
				layout.collapsed() ? null : (
					<View
						testID="sidebar-resize-handle"
						role="adjustable"
						focusable
						accessibilityLabel={t("sidebar.adjustSidebar")}
						accessibilityValue={{
							min: MIN_SIDEBAR_WIDTH,
							max: MAX_SIDEBAR_WIDTH,
							now: Math.round(layout.width()),
						}}
						class="group absolute top-2 -right-0.5 bottom-2 z-20 w-3"
						style={{ cursor: "col-resize" }}
						{...layout.handle}
					>
						<View
							class={`pointer-events-none absolute top-3 right-[5px] bottom-3 w-[2px] rounded-full ${
								layout.resizing()
									? "bg-sidebar-ring/70"
									: "bg-transparent group-hover:bg-sidebar-ring/50 group-focus:bg-sidebar-ring"
							}`}
						/>
					</View>
				)
			}
		</View>
	);
}

/** The sidebar outline before its interactive panel mounts. */
export function StartupSidebar(props: Pick<SidebarPanelProps, "titleBar">) {
	const card = computed(surface);
	return (
		<View class="h-full shrink-0" style={{ width: DEFAULT_SIDEBAR_WIDTH }}>
			<View class="min-h-0 flex-1" style={card().style}>
				<View
					desktop={{ windowDrag: true }}
					class="shrink-0 justify-center"
					style={{
						height: props.titleBar().height,
						marginTop: -card().top,
						paddingLeft: Math.max(14, props.titleBar().left - card().left + 8),
					}}
				>
					<Skeleton strong class="h-4 w-10" />
				</View>
				<View class="-mt-1 h-8 shrink-0 justify-center px-3.5">
					<Skeleton class="h-3 w-24" />
				</View>
				<SidebarLoading />
				<View class="shrink-0 flex-row justify-between border-t border-sidebar-border px-3 py-2.5">
					<Skeleton class="size-4" />
					<Skeleton class="size-4" />
				</View>
			</View>
		</View>
	);
}

function SidebarLoading() {
	return (
		<View
			testID="sidebar-loading"
			class="mt-2 min-h-0 flex-1 overflow-hidden px-3 pt-1"
		>
			<View class="h-(--pilo-sidebar-env-height) shrink-0 flex-row items-center gap-2">
				<Skeleton strong class="size-3.5 shrink-0" />
				<Skeleton strong class="h-3 w-16" />
			</View>
			<Each of={["w-[48%]", "w-[58%]", "w-[42%]"]}>
				{(width) => (
					<View class="h-(--pilo-sidebar-project-height) shrink-0 flex-row items-center gap-2 pl-2">
						<Skeleton class="size-3.5 shrink-0" />
						<Skeleton class={`h-3 ${width()}`} />
					</View>
				)}
			</Each>
		</View>
	);
}

/**
 * A toolbar row of the sidebar: 「新会话」, and the project view's back
 * button. Its icon and label take the sidebar's hover foreground.
 */
function SidebarToolbarRow(props: {
	testID: string;
	icon: IconName;
	label: () => string;
	onPress: () => void;
}) {
	const hover = createHover();
	const foreground = () =>
		hover.hovered() ? token("sidebar-hover-foreground") : sidebarForeground();
	return (
		<Foreground.Provider value={foreground}>
			<BaseButton
				{...hover.props}
				testID={props.testID}
				class="group min-w-0 flex-1 flex-row items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-sidebar-hover"
				focusVisibleStyle={sidebarFocusRing()}
				onPress={props.onPress}
			>
				<View class="size-4 shrink-0 items-center justify-center">
					<Icon name={props.icon} size={16} />
				</View>
				<Text
					class="min-w-0 flex-1 truncate font-sans text-sm"
					style={{ color: foreground() }}
				>
					{props.label}
				</Text>
			</BaseButton>
		</Foreground.Provider>
	);
}

function NewChatButton(props: { onPress: () => void }) {
	return (
		<View class="flex-row items-center gap-1">
			<SidebarToolbarRow
				testID="sidebar-new-chat"
				icon="SquarePen"
				label={() => t("sidebar.newSession")}
				onPress={props.onPress}
			/>
		</View>
	);
}

/** The project view's bar: back to the tree, and a new session in it. */
function ProjectSessionsToolbar(props: {
	name: string;
	onBack: () => void;
	onNewChat: () => void;
}) {
	return (
		<View class="min-w-0 flex-row items-center gap-0.5 border border-transparent pr-3">
			<SidebarToolbarRow
				testID="sidebar-project-view-back"
				icon="ArrowLeft"
				label={() => props.name}
				onPress={props.onBack}
			/>
			<SidebarAction
				testID="sidebar-project-view-new-chat"
				label={t("sidebar.newSession")}
				onPress={props.onNewChat}
			>
				<Icon name="SquarePen" size={16} />
			</SidebarAction>
		</View>
	);
}

/** Opens the Remote WebUI dialog, as React's phone button. */
function RemoteButton(props: {
	running: Accessor<boolean>;
	onOpen: () => void;
}) {
	return (
		<Button
			testID="sidebar-remote"
			variant="ghost"
			size="icon"
			accessibilityLabel={t("settings.remote")}
			tooltip={
				<Tooltip>
					<Text class="font-sans">{() => t("settings.remote")}</Text>
				</Tooltip>
			}
			onPress={props.onOpen}
		>
			{() =>
				props.running() ? (
					<Icon name="Smartphone" color={token("primary")} />
				) : (
					<Icon name="Smartphone" />
				)
			}
		</Button>
	);
}

/** Cycles the theme mode: light, dark, then the system's. */
function ThemeCycleButton(props: {
	theme: Accessor<Theme>;
	onTheme: (theme: Theme) => void;
}) {
	const label = () =>
		`${t("settings.theme")}: ${t(THEME_LABELS[props.theme()])}`;
	return (
		<Button
			testID="sidebar-theme"
			variant="ghost"
			size="icon"
			accessibilityLabel={t("settings.theme")}
			tooltip={
				<Tooltip>
					<Text class="font-sans">{label}</Text>
				</Tooltip>
			}
			onPress={() => {
				const index = THEME_CYCLE.indexOf(props.theme());
				props.onTheme(THEME_CYCLE[(index + 1) % THEME_CYCLE.length]);
			}}
		>
			{() => <Icon name={THEME_ICONS[props.theme()]} />}
		</Button>
	);
}

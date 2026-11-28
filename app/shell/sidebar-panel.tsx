import {
	type Accessor,
	appInfo,
	cleanup,
	computed,
	effect,
	type JSX,
	keymap,
	platform,
	signal,
	Text,
	token,
	View,
	type ViewRef,
	type ViewStyle,
} from "nsh";
import { Button as BaseButton } from "nsh/base";

import type { Theme } from "@shared/theme-settings-types";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { blurOnPointerPress } from "../ui/focus-ring-style";
import { Foreground } from "../ui/foreground";
import { Icon, type IconName } from "../ui/icon";
import { MOTION, tactileTransition, viewTransition } from "../ui/motion";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { styleVar } from "../ui/theme-style";
import { textTooltip } from "../ui/tooltip";
import type { DesktopUpdate } from "./desktop-update";
import type { ArchiveView } from "./archived-sessions";
import { t } from "./i18n";
import { PiLogo } from "./pi-logo";
import { Sidebar, type SidebarProps } from "./Sidebar";
import type { SidebarLayout } from "./sidebar-layout";
import { APP_SHORTCUTS, nshAppShortcut } from "../shortcuts";
import { createHover } from "../ui/hover";
import {
	SidebarAction,
	sidebarFocusRing,
	sidebarForeground,
	sidebarProjectName,
	sidebarRowHeight,
	sidebarText,
} from "./sidebar-parts";
import {
	DEFAULT_SIDEBAR_WIDTH,
	MAX_SIDEBAR_WIDTH,
	MIN_SIDEBAR_WIDTH,
} from "./sidebar-settings";

export interface SidebarPanelProps extends Omit<
	SidebarProps,
	"viewedProject" | "onViewProject" | "archiveView" | "onViewArchived"
> {
	layout: SidebarLayout;
	/** The list shows once the app and the sidebar's settings are ready. */
	listState: Accessor<"loading" | "ready" | "hidden">;
	shortcutsPaused: Accessor<boolean>;
	/** The system's title bar: its height and the room its controls take. */
	titleBar: Accessor<{ height: number; left: number }>;
	onSearch: () => void;
	onNewChat: () => void;
	/** Shortcut string for creating a new session, shown as a subtle hint. */
	newChatShortcut?: Accessor<string | undefined>;
	onOpenSettings?: () => void;
	/** Desktop updater state; renders the footer update trigger when an update is available. */
	update?: DesktopUpdate;
	/** Opens the Remote WebUI dialog; its button glows while the Host runs. */
	remote?: { running: Accessor<boolean>; onOpen: () => void };
	/** The saved theme mode, which the footer's button cycles. */
	theme: Accessor<Theme>;
	onTheme?: (theme: Theme) => void;
}

/** The WebUI sidebar's theme button order. */
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

/** The title bar's height; the system centers its window controls in it. */
export const TITLE_BAR_HEIGHT = 44;

/** Minimum height of the sidebar title row when seated inside a floating card. */
const FLOATING_SIDEBAR_TITLE_BAR_HEIGHT = 36;

/** Standard macOS traffic-light button height in points. */
const MACOS_TRAFFIC_LIGHT_HEIGHT = 14;

/** Minimum horizontal inset from a floating card's frame to macOS traffic lights. */
const FLOATING_CONTROLS_MIN_INSET = 12;

export interface SidebarSurfaceFrame {
	frameTop: number;
	frameLeft: number;
	frameWidth: number;
	radius: number;
}

/**
 * The card the sidebar draws its content on (the WebUI
 * `.pilo-sidebar-surface`): a floating rounded card in Lody, the full height
 * with a right border in Claude.
 */
export function sidebarSurface() {
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
	const frameTop = margin.top + border.top;
	const frameLeft = margin.left + border.left;
	const frameWidth = margin.left + margin.right + border.left + border.right;
	return {
		style,
		radius,
		paddingTop: padding.top,
		frameTop,
		frameLeft,
		frameWidth,
		top: frameTop + padding.top,
		left: frameLeft + padding.left,
	};
}

/**
 * Hidden title bar options matched to the sidebar surface: macOS floating cards
 * inset the traffic lights into the card's safe area and center them vertically.
 */
export function windowTitleBarOptions(
	card: SidebarSurfaceFrame,
	os: string = platform.os,
) {
	const floating = card.frameTop > 0 || card.frameLeft > 0;
	if (os === "macos" && floating) {
		const height = card.frameTop * 2 + FLOATING_SIDEBAR_TITLE_BAR_HEIGHT;
		return {
			style: "hidden" as const,
			height,
			controlsOffset: {
				x: card.frameLeft + Math.max(card.radius, FLOATING_CONTROLS_MIN_INSET),
				y: Math.round((height - MACOS_TRAFFIC_LIGHT_HEIGHT) / 2),
			},
		};
	}
	return {
		style: "hidden" as const,
		height: TITLE_BAR_HEIGHT,
		controlsOffset: null,
	};
}

/**
 * Height of the sidebar's own title row. macOS floating cards keep the row
 * within the top border and aligned with the window title bar's midpoint;
 * other platforms use the full window title bar height.
 */
export function sidebarTitleBarHeight(
	windowHeight: number,
	card: SidebarSurfaceFrame,
	os: string = platform.os,
) {
	if (card.frameTop <= 0 || os !== "macos") return windowHeight;
	return Math.max(
		FLOATING_SIDEBAR_TITLE_BAR_HEIGHT,
		windowHeight - card.frameTop * 2,
	);
}

/**
 * The title row's negative top margin. macOS floating cards keep the row inside
 * the card with their traffic lights; other platforms align it with the window's
 * title bar so the sidebar and main-header actions share one center line.
 */
export function sidebarTitleBarMarginTop(
	card: SidebarSurfaceFrame & { paddingTop: number; top: number },
	os: string = platform.os,
) {
	return os === "macos" ? -card.paddingTop : -card.top;
}

/** Subtle borderless tinted fill harmonized with the sidebar's own surface. */
function sidebarSoftSurface(hovered = false) {
	return `color-mix(in srgb, ${token("sidebar-foreground")} ${hovered ? 12 : 7}%, transparent)`;
}

/**
 * The sidebar as the WebUI `AppSidebar` draws it: the header with the app's
 * name and its actions, a new session (or the project's sessions' back
 * button), the list, the footer, and the handle on its edge that resizes it
 * or, dragged past its smallest width, collapses it.
 */
export function SidebarPanel(props: SidebarPanelProps) {
	const { layout } = props;
	const projectView = signal<string | null>(null);
	const archived = signal<ArchiveView | null>(null);
	const archiveProject = computed(() => {
		const id = archived()?.projectId;
		return id === undefined
			? undefined
			: props.store.state().projects.find((project) => project.id === id);
	});
	const archiveView = computed(() => {
		const view = archived();
		return view?.projectId !== undefined && !archiveProject() ? null : view;
	});
	const card = computed(sidebarSurface);
	const hasTrafficLights = () => props.titleBar().left > 0;
	const brandScale = () => token("pilo-ui-text-sm") / 14;
	// A view of sessions of a project that is gone closes.
	const viewedProject = computed(() => {
		const id = projectView();
		if (id === null || props.settings.settings().view === "recent") return null;
		return (
			props.store.state().projects.find((project) => project.id === id) ?? null
		);
	});
	const goBack = () => {
		if (archiveView()) archived.set(null);
		else projectView.set(null);
	};
	effect(() => {
		if (
			layout.collapsed() ||
			props.listState() !== "ready" ||
			props.shortcutsPaused() ||
			(!archiveView() && !viewedProject())
		) {
			return;
		}
		cleanup(keymap.bind("escape", goBack, { when: "notEditing" }));
	});
	return (
		<View
			ref={(node: ViewRef) => layout.bindAside(node)}
			testID="sidebar"
			class={`relative h-full shrink-0 ${
				layout.collapsed() ? "overflow-hidden opacity-0" : "opacity-100"
			}`}
			style={[
				viewTransition("opacity", MOTION.duration.calm),
				{
					width: layout.collapsed() ? 0 : layout.width(),
					pointerEvents: layout.collapsed() ? "none" : "auto",
				},
			]}
			accessibilityElementsHidden={layout.collapsed()}
		>
			<View
				testID="sidebar-surface"
				class="relative min-h-0 flex-1"
				style={[
					card().style,
					{ width: Math.max(0, layout.width() - card().frameWidth) },
				]}
			>
				<View
					testID="sidebar-title-bar"
					desktop={{ windowDrag: true }}
					class="shrink-0 flex-row items-center px-1.5"
					style={{
						height: sidebarTitleBarHeight(props.titleBar().height, card()),
						marginTop: sidebarTitleBarMarginTop(card()),
						paddingLeft: Math.max(6, props.titleBar().left - card().left),
					}}
				>
					<View class="min-w-0 flex-1 flex-row items-center gap-2 pl-2 pr-1">
						<View
							accessible={false}
							class="shrink-0 items-center justify-center"
							style={{
								width: hasTrafficLights() ? 21 : 24,
								height: hasTrafficLights() ? 21 : 24,
								borderRadius: hasTrafficLights() ? 5.5 : 6.5,
								backgroundColor: `color-mix(in srgb, ${token("sidebar-foreground")} 8%, transparent)`,
							}}
						>
							<PiLogo
								size={hasTrafficLights() ? 11 : 13}
								trim
								color={token("sidebar-selection-foreground")}
							/>
						</View>
						<Text
							class="min-w-0 shrink truncate font-sans font-bold leading-none tracking-tight"
							style={{
								fontSize: (hasTrafficLights() ? 17 : 19) * brandScale(),
								color: token("sidebar-selection-foreground"),
							}}
						>
							Pilo
						</Text>
						{() =>
							appInfo().development ? (
								<View
									testID="sidebar-dev-badge"
									accessible={false}
									class="shrink-0 items-center justify-center rounded px-1.5 py-0.5"
									style={{
										backgroundColor: `color-mix(in srgb, ${token("primary")} 14%, transparent)`,
									}}
								>
									<Text
										class="font-sans text-[10px] font-bold leading-none tracking-wider"
										style={{ color: token("primary") }}
									>
										DEV
									</Text>
								</View>
							) : null
						}
					</View>
					<View
						class="mr-[13px] h-7 shrink-0 flex-row items-center gap-0.5"
						style={[
							tactileTransition("opacity"),
							layout.collapsed() || layout.settledCollapsed()
								? { opacity: 0, pointerEvents: "none" }
								: { opacity: 1, pointerEvents: "auto" },
						]}
					>
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
				</View>
				<View class="mt-1 shrink-0 gap-1 px-2.5">
					{() => {
						if (archiveView()) {
							const project = archiveProject();
							return (
								<SidebarToolbarRow
									testID="sidebar-archived-back"
									icon="ArrowLeft"
									label={() =>
										project
											? `${t("sidebar.archivedSessions")} · ${sidebarProjectName(project)}`
											: t("sidebar.archivedSessions")
									}
									onPress={goBack}
								/>
							);
						}
						const project = viewedProject();
						return project ? (
							<ProjectSessionsToolbar
								name={sidebarProjectName(project)}
								onBack={goBack}
								onNewChat={() => {
									props.onSelectChat?.(project.id);
									props.store.selectProject(project.id);
								}}
							/>
						) : (
							<NewChatButton
								onPress={props.onNewChat}
								shortcut={props.newChatShortcut}
							/>
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
										onSelectChat={props.onSelectChat}
										viewedProject={viewedProject}
										onViewProject={(id) => projectView.set(id)}
										archiveView={archiveView}
										onViewArchived={(projectId) => archived.set({ projectId })}
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
						{() =>
							props.listState() === "ready" && (
								<SidebarFooterButton
									testID="sidebar-archived"
									label={() => t("sidebar.archived")}
									active={() => archiveView() !== null}
									onPress={() =>
										archived.set(
											archiveView() !== null &&
												archiveView()?.projectId === undefined
												? null
												: {},
										)
									}
								>
									<Icon name="Archive" />
								</SidebarFooterButton>
							)
						}
						{() =>
							props.update?.hasUpdate() ? (
								<UpdateButton update={props.update} />
							) : null
						}
						<View class="ml-auto flex-row items-center gap-1">
							{props.remote ? <RemoteButton {...props.remote} /> : null}
							{props.onTheme ? (
								<ThemeCycleButton theme={props.theme} onTheme={props.onTheme} />
							) : null}
							{props.onOpenSettings ? (
								<SidebarFooterButton
									testID="sidebar-settings"
									label={() => t("settings.title")}
									onPress={props.onOpenSettings}
								>
									<Icon name="Settings" />
								</SidebarFooterButton>
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
							style={tactileTransition("background-color")}
						/>
					</View>
				)
			}
		</View>
	);
}

/**
 * The sidebar outline before its interactive panel mounts, laid out as the
 * panel's title bar, new-session row and footer so nothing moves when it does.
 */
export function StartupSidebar(
	props: Pick<SidebarPanelProps, "titleBar"> & { width?: Accessor<number> },
) {
	const card = computed(sidebarSurface);
	/** A footer button's place: `Button size="icon"` around a 16pt icon. */
	const footerButton = () => (
		<View class="size-(--pilo-button-icon-size) items-center justify-center">
			<Skeleton class="size-4" />
		</View>
	);
	/** A title bar action's place: `SidebarAction` around a 16pt icon. */
	const titleAction = () => (
		<View class="size-6 items-center justify-center">
			<Skeleton class="size-4" />
		</View>
	);
	return (
		<View
			class="h-full shrink-0"
			style={{ width: props.width?.() ?? DEFAULT_SIDEBAR_WIDTH }}
		>
			<View class="min-h-0 flex-1" style={card().style}>
				<View
					desktop={{ windowDrag: true }}
					class="shrink-0 flex-row items-center px-1.5"
					style={{
						height: sidebarTitleBarHeight(props.titleBar().height, card()),
						marginTop: sidebarTitleBarMarginTop(card()),
						paddingLeft: Math.max(6, props.titleBar().left - card().left),
					}}
				>
					<View class="min-w-0 flex-1 flex-row items-center gap-2 pl-2 pr-1">
						<Skeleton strong class="size-6 shrink-0 rounded-md" />
						<Skeleton strong class="h-5 w-11" />
					</View>
					<View class="mr-[13px] h-7 shrink-0 flex-row items-center gap-0.5">
						{titleAction()}
						{titleAction()}
					</View>
				</View>
				<View class="mt-1 shrink-0 px-2.5">
					<View
						class="h-8 flex-row items-center gap-2 rounded-lg px-2.5"
						style={{ backgroundColor: sidebarSoftSurface() }}
					>
						<Skeleton class="size-4 shrink-0" />
						<Skeleton class="h-3 w-16" />
					</View>
				</View>
				<SidebarLoading />
				<View class="shrink-0 flex-row items-center gap-1 border-t border-sidebar-border px-1.5 py-1">
					{footerButton()}
					<View class="ml-auto flex-row items-center gap-1">
						{footerButton()}
						{footerButton()}
						{footerButton()}
					</View>
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
			<View
				class="shrink-0 flex-row items-center gap-2"
				style={{ height: sidebarRowHeight("pilo-sidebar-env-height") }}
			>
				<Skeleton strong class="size-3.5 shrink-0" />
				<Skeleton strong class="h-3 w-16" />
			</View>
			<Each of={["w-[48%]", "w-[58%]", "w-[42%]"]}>
				{(width) => (
					<View
						class="shrink-0 flex-row items-center gap-2 pl-2"
						style={{ height: sidebarRowHeight("pilo-sidebar-project-height") }}
					>
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
	const pointerBlur = blurOnPointerPress();
	const foreground = () =>
		hover.hovered() ? token("sidebar-hover-foreground") : sidebarForeground();
	return (
		<Foreground.Provider value={foreground}>
			<BaseButton
				{...hover.props}
				ref={pointerBlur.ref}
				onMouseUp={pointerBlur.onMouseUp}
				testID={props.testID}
				class="group min-w-0 flex-1 flex-row items-center gap-1.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-sidebar-hover"
				focusVisibleStyle={sidebarFocusRing()}
				onPress={props.onPress}
			>
				<View class="size-4 shrink-0 items-center justify-center">
					<Icon name={props.icon} size={16} />
				</View>
				<Text
					class="min-w-0 flex-1 truncate font-sans"
					style={{ ...sidebarText("sm"), color: foreground() }}
				>
					{props.label}
				</Text>
			</BaseButton>
		</Foreground.Provider>
	);
}

function NewChatButton(props: {
	onPress: () => void;
	shortcut?: Accessor<string | undefined>;
}) {
	const hover = createHover();
	const pointerBlur = blurOnPointerPress();
	const iconForeground = () =>
		token(
			hover.hovered() ? "sidebar-hover-foreground" : "sidebar-foreground-muted",
		);
	const shortcutLabel = () => {
		const raw = props.shortcut?.() ?? APP_SHORTCUTS.newChat;
		const normalized = nshAppShortcut(raw, platform.os === "macos");
		return normalized ? keymap.label(normalized) : "";
	};
	return (
		<View class="flex-row items-center gap-1">
			<Foreground.Provider value={iconForeground}>
				<BaseButton
					{...hover.props}
					ref={pointerBlur.ref}
					onMouseUp={pointerBlur.onMouseUp}
					testID="sidebar-new-chat"
					class="group h-8 min-w-0 flex-1 flex-row items-center gap-2 rounded-lg px-2.5"
					style={[
						tactileTransition("background-color"),
						{ backgroundColor: sidebarSoftSurface(hover.hovered()) },
					]}
					focusVisibleStyle={sidebarFocusRing()}
					onPress={props.onPress}
				>
					<View class="size-4 shrink-0 items-center justify-center">
						<Icon name="SquarePen" size={15} />
					</View>
					<Text
						class="min-w-0 flex-1 truncate font-sans font-medium"
						style={{
							...sidebarText("sm"),
							color: token(
								hover.hovered()
									? "sidebar-hover-foreground"
									: "sidebar-selection-foreground",
							),
						}}
					>
						{() => t("sidebar.newSession")}
					</Text>
					{() => {
						const label = shortcutLabel();
						return label ? (
							<Text
								accessible={false}
								class="shrink-0 font-sans text-[11px] font-medium"
								style={{
									color: token("sidebar-foreground-muted"),
									opacity: 0.72,
								}}
							>
								{label}
							</Text>
						) : null;
					}}
				</BaseButton>
			</Foreground.Provider>
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

/**
 * An icon button in the sidebar footer: muted at rest so it yields to the
 * session list, brightens on hover, and carries an active or accent state.
 */
function SidebarFooterButton(props: {
	testID: string;
	label: () => string;
	tooltip?: () => string;
	active?: () => boolean;
	accent?: () => boolean;
	onPress: () => void;
	children: JSX.Element;
}) {
	const hover = createHover();
	const active = () => props.active?.() ?? false;
	const foreground = () => {
		if (props.accent?.()) return token("primary");
		if (active()) return token("pilo-sidebar-selected-foreground");
		return token(
			hover.hovered() ? "sidebar-hover-foreground" : "sidebar-foreground-muted",
		);
	};
	return (
		<Button
			{...hover.props}
			testID={props.testID}
			variant="ghost"
			size="icon"
			selected={props.active ? active() : undefined}
			class={classNames(
				"hover:bg-sidebar-hover",
				active() && "bg-(--pilo-sidebar-selected-background)",
			)}
			focusVisibleStyle={sidebarFocusRing()}
			accessibilityLabel={props.label()}
			tooltip={textTooltip(props.tooltip ?? props.label)}
			onPress={props.onPress}
		>
			<Foreground.Provider value={foreground}>
				{props.children}
			</Foreground.Provider>
		</Button>
	);
}

/**
 * Footer update trigger beside the archived toggle, matching Tauri's
 * `SidebarFooter` update button: opens the update dialog to view release notes
 * or active download progress without taking extra vertical space.
 */
function UpdateButton(props: { update: DesktopUpdate }) {
	const { update } = props;
	const status = () => update.status();
	const busy = () => status() === "downloading" || status() === "installing";
	const readyToRestart = () => status() === "ready_to_restart";
	const failed = () => status() === "error";
	const progress = () => update.downloadProgress();

	const label = () => {
		if (failed()) return t("settings.updateDetails");
		if (readyToRestart()) return t("settings.updateRestartNow");
		if (status() === "installing") return t("settings.installing");
		if (status() === "downloading") {
			const pct = progress();
			return pct === null ? t("settings.downloading") : `${pct}%`;
		}
		return t("settings.updateAvailable");
	};

	const detail = () => {
		if (failed()) return update.error() ?? t("about.updateFailed");
		if (readyToRestart()) return t("settings.updateReadyToRestart");
		if (status() === "installing") return t("settings.installing");
		if (status() === "downloading") {
			const pct = progress();
			return pct === null
				? t("settings.downloading")
				: `${t("settings.downloading")} ${pct}%`;
		}
		return t("settings.updateDialogDescription", {
			version: update.availableVersion() ?? "",
		});
	};

	const colorToken = () =>
		failed() ? "status-danger" : busy() ? "muted-foreground" : "primary";

	return (
		<Button
			testID="sidebar-update"
			variant="ghost"
			size="sm"
			class="h-(--pilo-button-icon-size) min-w-0 shrink gap-1.5 px-2 text-xs tabular-nums hover:bg-sidebar-hover"
			focusVisibleStyle={sidebarFocusRing()}
			accessibilityLabel={detail()}
			tooltip={textTooltip(detail)}
			onPress={() => update.setDialogOpen(true)}
		>
			{() => {
				const color = token(colorToken());
				if (failed()) return <Icon name="RefreshCw" size={14} color={color} />;
				if (busy()) return <Spinner size={14} color={color} />;
				if (readyToRestart())
					return <Icon name="RotateCcw" size={14} color={color} />;
				return <Icon name="Download" size={14} color={color} />;
			}}
			<Text
				class="min-w-0 shrink truncate font-sans text-xs font-medium tabular-nums"
				style={{ color: token(colorToken()) }}
			>
				{label}
			</Text>
		</Button>
	);
}

/** Opens the Remote WebUI dialog, as React's phone button. */
function RemoteButton(props: {
	running: Accessor<boolean>;
	onOpen: () => void;
}) {
	return (
		<SidebarFooterButton
			testID="sidebar-remote"
			label={() => t("settings.remote")}
			accent={props.running}
			onPress={props.onOpen}
		>
			<Icon name="Smartphone" />
		</SidebarFooterButton>
	);
}

/** Cycles the theme mode: light, dark, then the system's. */
function ThemeCycleButton(props: {
	theme: Accessor<Theme>;
	onTheme: (theme: Theme) => void;
}) {
	const tooltip = () =>
		`${t("settings.theme")}: ${t(THEME_LABELS[props.theme()])}`;
	return (
		<SidebarFooterButton
			testID="sidebar-theme"
			label={() => t("settings.theme")}
			tooltip={tooltip}
			onPress={() => {
				const index = THEME_CYCLE.indexOf(props.theme());
				props.onTheme(THEME_CYCLE[(index + 1) % THEME_CYCLE.length]);
			}}
		>
			{() => <Icon name={THEME_ICONS[props.theme()]} />}
		</SidebarFooterButton>
	);
}

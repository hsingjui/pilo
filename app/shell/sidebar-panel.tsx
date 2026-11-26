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

import type { Theme } from "@shared/theme-settings-types";
import { Button } from "../ui/button";
import { blurOnPointerPress } from "../ui/focus-ring-style";
import { Foreground } from "../ui/foreground";
import { Icon, type IconName } from "../ui/icon";
import { MOTION, tactileTransition, viewTransition } from "../ui/motion";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { styleVar } from "../ui/theme-style";
import { Tooltip } from "../ui/tooltip";
import type { DesktopUpdate } from "./desktop-update";
import { t } from "./i18n";
import { Sidebar, type SidebarProps } from "./Sidebar";
import type { SidebarLayout } from "./sidebar-layout";
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
	return {
		style,
		radius,
		paddingTop: padding.top,
		frameTop,
		frameLeft,
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

/**
 * The sidebar as the WebUI `AppSidebar` draws it: the header with the app's
 * name and its actions, a new session (or the project's sessions' back
 * button), the list, the footer, and the handle on its edge that resizes it
 * or, dragged past its smallest width, collapses it.
 */
export function SidebarPanel(props: SidebarPanelProps) {
	const { layout } = props;
	const projectView = signal<string | null>(null);
	const card = computed(sidebarSurface);
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
				style={card().style}
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
					<View class="min-w-0 flex-1 flex-row items-center px-2">
						<Text
							class={`min-w-0 shrink truncate font-sans text-lg font-semibold tracking-tight ${
								appInfo().development
									? "text-primary"
									: "text-sidebar-foreground"
							}`}
							style={titleTextStyle}
						>
							Pilo
						</Text>
					</View>
					<View
						class="mr-1 h-7 shrink-0 flex-row items-center gap-0.5 border border-transparent px-2"
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
				<View class="-mt-1 shrink-0 gap-1 px-1.5">
					{() => {
						const project = viewedProject();
						return project ? (
							<ProjectSessionsToolbar
								name={sidebarProjectName(project)}
								onBack={() => projectView.set(null)}
								onNewChat={() => {
									props.onSelectChat?.(project.id);
									props.store.selectProject(project.id);
								}}
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
										onSelectChat={props.onSelectChat}
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
					<View class="min-w-0 flex-1 flex-row items-center px-2">
						<Skeleton strong class="h-4 w-10" />
					</View>
					<View class="mr-1 h-7 shrink-0 flex-row items-center gap-0.5 border border-transparent px-2">
						{titleAction()}
						{titleAction()}
					</View>
				</View>
				<View class="-mt-1 shrink-0 px-1.5">
					<View class="h-8 flex-row items-center gap-1.5 px-2">
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

/**
 * Footer update trigger beside the settings gear, matching Tauri's
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
			class="h-(--pilo-button-icon-size) gap-1.5 px-2.5 text-xs tabular-nums"
			accessibilityLabel={detail()}
			tooltip={
				<Tooltip>
					<Text class="font-sans">{detail}</Text>
				</Tooltip>
			}
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
				class="font-sans text-xs font-medium tabular-nums"
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

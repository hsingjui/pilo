import {
	type Accessor,
	colorScheme,
	type JSX,
	split,
	Text,
	token,
	View,
} from "nsh";
import { Button, type ButtonProps } from "nsh/base";

import { isDefaultWorkspace, type Project } from "@shared/api/projects-types";
import { chatPx } from "../chat/layout";
import { classNames } from "../ui/class-names";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Foreground } from "../ui/foreground";
import { createHover } from "../ui/hover";
import { Icon, type IconName } from "../ui/icon";
import {
	chevronRotateStyle,
	springTransition,
	tactileTransition,
} from "../ui/motion";
import { t } from "./i18n";

/**
 * The sidebar's type at the WebUI's default UI size, as the chat's
 * (`chat/layout.ts`): Tailwind's `text-sm`, `text-xs` and `text-2xs` there.
 */
const sidebarTextSizes = {
	sm: { fontSize: 14, lineHeight: 20 },
	xs: { fontSize: 12, lineHeight: 16 },
	"2xs": { fontSize: 11, lineHeight: undefined },
} as const;

export function sidebarText(size: keyof typeof sidebarTextSizes) {
	const { fontSize, lineHeight } = sidebarTextSizes[size];
	const scale = token("pilo-ui-text-sm") / 14;
	return {
		fontSize: chatPx(fontSize) * scale,
		lineHeight:
			lineHeight === undefined ? undefined : chatPx(lineHeight) * scale,
	};
}

/** A `pilo-sidebar-*` row height at the WebUI's default UI size. */
export const sidebarRowHeight = (
	name:
		| "pilo-sidebar-env-height"
		| "pilo-sidebar-project-height"
		| "pilo-sidebar-session-height"
		| "pilo-sidebar-session-context-height",
) => chatPx(token(name));

/** An action of a row that shows while the pointer is over the row. */
export const HOVER_ACTION =
	"opacity-0 group-hover:opacity-100 focus-visible:opacity-100";

export function sidebarProjectName(project: Project) {
	return isDefaultWorkspace(project)
		? t("sidebar.defaultWorkspace")
		: project.name;
}

/** A row's text that is not selected; the dark sidebar dims it to 75%. */
export const sidebarForeground = () =>
	colorScheme() === "dark"
		? `color-mix(in srgb, ${token("sidebar-foreground")} 75%, transparent)`
		: token("sidebar-foreground");

export const sidebarFocusRing = () =>
	focusRingStyle(token("sidebar-ring"), undefined, undefined, { width: 2 });

/** A connection or recent view header and its actions. */
export function SidebarSectionHeader(props: {
	testID: string;
	icon: IconName;
	title: Accessor<string>;
	collapsed: Accessor<boolean>;
	label: Accessor<string>;
	disabled?: boolean;
	onPress: () => void;
	children?: JSX.Element;
}) {
	const hover = createHover();
	const foreground = () =>
		token(
			!props.disabled && hover.hovered()
				? "sidebar-foreground"
				: "sidebar-foreground-muted",
		);
	const chevron = (collapsed: Accessor<boolean>) => (
		<View
			class={`shrink-0 ${collapsed() ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
			style={[
				tactileTransition("opacity"),
				chevronRotateStyle(!collapsed(), -90, 0),
			]}
		>
			<Icon name="ChevronDown" size={14} />
		</View>
	);
	return (
		<View
			class="group flex-row items-center gap-0.5 rounded-md border border-transparent pr-2"
			style={{ minHeight: sidebarRowHeight("pilo-sidebar-env-height") }}
		>
			<Foreground.Provider value={foreground}>
				<Button
					{...hover.props}
					testID={props.testID}
					class="min-h-[26px] min-w-0 flex-1 flex-row items-center gap-2 rounded-md border border-transparent px-2"
					focusVisibleStyle={sidebarFocusRing()}
					accessibilityLabel={props.label()}
					disabled={props.disabled}
					onPress={props.onPress}
				>
					<Icon name={props.icon} size={14} class="shrink-0 opacity-80" />
					<Text
						class="min-w-0 shrink truncate font-sans font-medium"
						style={{ ...sidebarText("sm"), color: foreground() }}
					>
						{props.title}
					</Text>
					{chevron(props.collapsed)}
				</Button>
			</Foreground.Provider>
			{props.children}
		</View>
	);
}

export interface SidebarActionProps extends ButtonProps {
	/** What screen readers say for the icon. */
	label: string;
	children?: JSX.Element;
}

/**
 * The sidebar's small icon button (the WebUI's `SIDEBAR_ACTION`): muted
 * until the pointer is over it.
 */
export function SidebarAction(props: SidebarActionProps) {
	const [local, rest] = split(props, ["class", "label", "children", "style"]);
	const hover = createHover();
	return (
		<Button
			{...rest}
			{...hover.props}
			class={classNames(
				"size-6 shrink-0 items-center justify-center rounded-sm hover:bg-sidebar-hover",
				local.class,
			)}
			style={[tactileTransition("opacity, background-color"), local.style]}
			focusVisibleStyle={sidebarFocusRing()}
			accessibilityLabel={local.label}
		>
			<Foreground.Provider
				value={() =>
					token(
						hover.hovered()
							? "sidebar-hover-foreground"
							: "sidebar-foreground-muted",
					)
				}
			>
				{local.children}
			</Foreground.Provider>
		</Button>
	);
}

/** The menus' small switch, a size below the settings' `Switch`. */
export function MiniSwitch(props: { checked: boolean; testID?: string }) {
	return (
		<View
			testID={props.testID}
			class={`relative h-4 w-7 shrink-0 flex-row items-center rounded-full ${
				props.checked ? "bg-primary" : "bg-switch-track"
			}`}
			style={tactileTransition("background-color")}
		>
			<View
				class={`absolute left-0.5 size-3 rounded-full bg-background shadow-sm ${
					props.checked ? "translate-x-3" : ""
				}`}
				style={springTransition("transform", "crisp")}
			/>
		</View>
	);
}

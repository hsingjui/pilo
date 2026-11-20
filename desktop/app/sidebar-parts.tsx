import {
	type Accessor,
	colorScheme,
	type JSX,
	signal,
	split,
	token,
	View,
} from "nsh";
import { Button, type ButtonProps } from "nsh/base";

import { isDefaultWorkspace, type Project } from "@/lib/api/projects-types";
import { classNames } from "../ui/class-names";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Foreground } from "../ui/foreground";
import { t } from "./i18n";

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

/**
 * The pointer over a view, for the icons inside it: an icon draws in the
 * foreground it is given, not in the text color a `hover:` class sets.
 */
export function createHover() {
	const hovered = signal(false);
	return {
		hovered: hovered as Accessor<boolean>,
		props: {
			onMouseEnter: () => hovered.set(true),
			onMouseLeave: () => hovered.set(false),
		},
	};
}

export interface SidebarActionProps extends ButtonProps {
	/** What screen readers say for the icon. */
	label: string;
	children?: JSX.Element;
}

/**
 * The sidebar's small icon button (the Tauri app's `SIDEBAR_ACTION`): muted
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
				"size-6 shrink-0 items-center justify-center rounded-sm duration-100 hover:bg-sidebar-hover",
				local.class,
			)}
			style={[{ transitionProperty: "opacity, background-color" }, local.style]}
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
			class={`relative h-4 w-7 shrink-0 flex-row items-center rounded-full transition-colors ${
				props.checked ? "bg-primary" : "bg-switch-track"
			}`}
		>
			<View
				class={`absolute left-0.5 size-3 rounded-full bg-background shadow-sm transition-transform ${
					props.checked ? "translate-x-3" : ""
				}`}
			/>
		</View>
	);
}

import { colorScheme, type JSX, split, token, View } from "nsh";
import { Button, type ButtonProps } from "nsh/base";

import { isDefaultWorkspace, type Project } from "@shared/api/projects-types";
import { chatPx } from "../chat/layout";
import { classNames } from "../ui/class-names";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Foreground } from "../ui/foreground";
import { createHover } from "../ui/hover";
import { t } from "./i18n";

/**
 * The sidebar's type at the WebUI's default UI size, as the chat's
 * (`chat/layout.ts`): Tailwind's `text-sm`, `text-xs` and `text-2xs` there.
 */
export const sidebarText = {
	sm: { fontSize: chatPx(14), lineHeight: chatPx(20) },
	xs: { fontSize: chatPx(12), lineHeight: chatPx(16) },
	"2xs": { fontSize: chatPx(11) },
} as const;

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

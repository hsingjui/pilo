import { split, token, Text, type JSX } from "nsh";
import {
	MenuItem as BaseMenuItem,
	type MenuItemProps as BaseMenuItemProps,
} from "nsh/base";
import { Foreground } from "./foreground";
import { Icon } from "./icon";
import { classNames } from "./class-names";
import { menuRowClass } from "./menu-row";

export interface MenuItemProps extends BaseMenuItemProps {
	icon?: JSX.Element;
	shortcut?: string;
	variant?: "default" | "destructive";
}

export function MenuItem(props: MenuItemProps) {
	const [local, rest] = split(props, [
		"class",
		"children",
		"icon",
		"shortcut",
		"variant",
		"indicator",
		"indicatorClass",
	]);
	const foreground = () =>
		token(local.variant === "destructive" ? "destructive" : "foreground");
	return (
		<Foreground.Provider value={foreground}>
			<BaseMenuItem
				{...rest}
				class={classNames(
					menuRowClass,
					"checked:bg-(--pilo-menu-checked-background)",
					local.variant === "destructive" &&
						"text-destructive hover:text-destructive focus:text-destructive hover:bg-destructive/10 focus:bg-destructive/10",
					local.class,
				)}
				indicatorClass={classNames(
					"size-3.5 opacity-0 checked:opacity-100",
					local.indicatorClass,
				)}
				indicator={local.indicator ?? <Icon name="Check" size={14} />}
			>
				{local.icon}
				{local.children}
				{local.shortcut ? (
					<Text class="ml-auto pl-4 font-mono text-xs text-muted-foreground">
						{local.shortcut}
					</Text>
				) : null}
			</BaseMenuItem>
		</Foreground.Provider>
	);
}

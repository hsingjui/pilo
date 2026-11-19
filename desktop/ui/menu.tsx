import { split, token } from "nsh";
import { Menu as BaseMenu, type MenuProps } from "nsh/base";
import { styleVar } from "./theme-style";
import { classNames } from "./class-names";

export type { MenuProps } from "nsh/base";

export function Menu(props: MenuProps) {
	const [local, rest] = split(props, ["popupClass", "popupStyle"]);
	return (
		<BaseMenu
			{...rest}
			popupClass={classNames(
				"min-w-55 rounded-(--pilo-menu-radius) bg-(--pilo-menu-background) text-foreground p-(--pilo-menu-padding) gap-(--pilo-menu-item-gap) font-sans",
				local.popupClass,
			)}
			popupStyle={[
				{ boxShadow: styleVar("pilo-menu-shadow"), zIndex: token("z-popover") },
				local.popupStyle,
			]}
		/>
	);
}

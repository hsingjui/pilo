import { split, token } from "nsh";
import { Menu as BaseMenu, type MenuProps } from "nsh/base";
import { styleVar } from "./theme-style";
import { classNames } from "./class-names";
import { popupMotionStyles } from "./motion";

export type { MenuProps } from "nsh/base";

export const menuPopupClass =
	"min-w-55 rounded-(--pilo-menu-radius) bg-(--pilo-menu-background) text-foreground p-(--pilo-menu-padding) gap-(--pilo-menu-item-gap) font-sans";

export function menuPopupStyle() {
	return {
		...popupMotionStyles().popupStyle,
		boxShadow: styleVar("pilo-menu-shadow"),
		zIndex: token("z-popover"),
	};
}

export function Menu(props: MenuProps) {
	const [local, rest] = split(props, [
		"popupClass",
		"popupStyle",
		"popupStartingStyle",
		"popupEndingStyle",
	]);
	const motion = () => popupMotionStyles();
	return (
		<BaseMenu
			{...rest}
			popupClass={classNames(menuPopupClass, local.popupClass)}
			popupStyle={[menuPopupStyle(), local.popupStyle]}
			popupStartingStyle={[
				motion().popupStartingStyle,
				local.popupStartingStyle,
			]}
			popupEndingStyle={[motion().popupEndingStyle, local.popupEndingStyle]}
		/>
	);
}

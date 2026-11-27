import { split, token, View } from "nsh";
import { Menu as BaseMenu, type MenuProps } from "nsh/base";
import { styleVar } from "./theme-style";
import { classNames } from "./class-names";
import { popupMotionStyles } from "./motion";

export type { MenuProps } from "nsh/base";

export const menuPopupClass =
	"min-w-55 rounded-(--pilo-menu-radius) bg-(--pilo-menu-background) text-foreground p-(--pilo-menu-padding) font-sans";

/** Keeps adjacent hovered, focused, or checked menu rows visually separated. */
export function menuListSpacing() {
	return { gap: Math.max(3, token("pilo-menu-item-gap")) };
}

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
		"children",
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
		>
			{/* BaseMenu wraps children in an internal Scroll, so gap must sit on the inner View. */}
			<View style={menuListSpacing()}>{local.children}</View>
		</BaseMenu>
	);
}

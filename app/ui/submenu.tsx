import { split, Text, token, View } from "nsh";
import {
	Submenu as BaseSubmenu,
	type SubmenuProps as BaseSubmenuProps,
} from "nsh/base";
import { Icon } from "./icon";
import { classNames } from "./class-names";
import { menuRowClass } from "./menu-row";
import { tactileTransition } from "./motion";

export interface SubmenuProps extends BaseSubmenuProps {
	label?: string;
}
export function Submenu(props: SubmenuProps) {
	const [local, rest] = split(props, ["label", "trigger"]);
	return (
		<BaseSubmenu
			offset={12}
			{...rest}
			trigger={
				local.trigger ?? (
					<View
						class={classNames(menuRowClass, "justify-between")}
						style={tactileTransition("background-color, color")}
					>
						<Text class="font-sans">{local.label}</Text>
						<Icon
							name="ChevronRight"
							size={14}
							color={token("muted-foreground")}
						/>
					</View>
				)
			}
		/>
	);
}

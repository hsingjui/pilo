import { split, Text, View } from "nsh";
import {
	Submenu as BaseSubmenu,
	type SubmenuProps as BaseSubmenuProps,
} from "nsh/base";
import { Icon } from "./icon";
import { classNames } from "./class-names";
import { menuRowClass } from "./menu-row";

export interface SubmenuProps extends BaseSubmenuProps {
	label?: string;
}
export function Submenu(props: SubmenuProps) {
	const [local, rest] = split(props, ["label", "trigger"]);
	return (
		<BaseSubmenu
			{...rest}
			trigger={
				local.trigger ?? (
					<View class={classNames(menuRowClass, "justify-between")}>
						<Text>{local.label}</Text>
						<Icon name="ChevronRight" size={14} />
					</View>
				)
			}
		/>
	);
}

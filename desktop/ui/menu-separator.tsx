import { split } from "nsh";
import {
	MenuSeparator as BaseMenuSeparator,
	type MenuSeparatorProps,
} from "nsh/base";
import { classNames } from "./class-names";

export type { MenuSeparatorProps } from "nsh/base";
export function MenuSeparator(props: MenuSeparatorProps) {
	const [local, rest] = split(props, ["class"]);
	return (
		<BaseMenuSeparator
			{...rest}
			class={classNames("my-1 h-px bg-(--pilo-menu-edge)", local.class)}
		/>
	);
}

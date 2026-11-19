import { signal, split, token } from "nsh";
import { Button as BaseButton, type ButtonProps } from "nsh/base";
import { buttonVariants } from "./button";
import { classNames } from "./class-names";
import { focusRingStyle } from "./focus-ring-style";
import { Foreground } from "./foreground";
import { Icon } from "./icon";

export function ToastCloseButton(props: ButtonProps) {
	const [local, rest] = split(props, [
		"class",
		"children",
		"focusVisibleStyle",
		"onMouseEnter",
		"onMouseLeave",
	]);
	const hovered = signal(false);
	const foreground = () =>
		token(hovered() ? "popover-foreground" : "muted-foreground");
	return (
		<Foreground.Provider value={foreground}>
			<BaseButton
				{...rest}
				class={buttonVariants({
					variant: "ghost",
					size: "icon",
					class: classNames(
						"size-5 p-0 text-muted-foreground hover:text-popover-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
						local.class,
					),
				})}
				focusVisibleStyle={focusRingStyle(
					token("ring"),
					undefined,
					local.focusVisibleStyle,
				)}
				onMouseEnter={(event) => {
					hovered.set(true);
					local.onMouseEnter?.(event);
				}}
				onMouseLeave={(event) => {
					hovered.set(false);
					local.onMouseLeave?.(event);
				}}
			>
				{local.children ?? <Icon name="X" size={14} />}
			</BaseButton>
		</Foreground.Provider>
	);
}

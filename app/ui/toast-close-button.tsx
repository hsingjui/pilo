import { signal, split, token } from "nsh";
import { Button as BaseButton, type ButtonProps } from "nsh/base";
import { buttonVariants } from "./button";
import { classNames } from "./class-names";
import { blurOnPointerPress, focusRingStyle } from "./focus-ring-style";
import { Foreground } from "./foreground";
import { Icon } from "./icon";
import { tactileTransition } from "./motion";

export interface ToastCloseButtonProps extends ButtonProps {
	/** Touch/mobile layout: always visible with an enlarged tap target. */
	touch?: boolean;
}

export function ToastCloseButton(props: ToastCloseButtonProps) {
	const [local, rest] = split(props, [
		"class",
		"children",
		"focusVisibleStyle",
		"hitSlop",
		"ref",
		"touch",
		"onMouseUp",
		"onMouseEnter",
		"onMouseLeave",
	]);
	const pointerBlur = blurOnPointerPress(local);
	const hovered = signal(false);
	const foreground = () =>
		token(hovered() ? "popover-foreground" : "muted-foreground");
	return (
		<Foreground.Provider value={foreground}>
			<BaseButton
				{...rest}
				ref={pointerBlur.ref}
				hitSlop={local.hitSlop ?? (local.touch ? 6 : undefined)}
				onMouseUp={pointerBlur.onMouseUp}
				class={buttonVariants({
					variant: "ghost",
					size: "icon",
					class: classNames(
						local.touch
							? "size-8 shrink-0 rounded-full p-0 text-muted-foreground opacity-100 active:bg-hover active:text-popover-foreground"
							: "size-6 shrink-0 rounded-full p-0 text-muted-foreground hover:text-popover-foreground opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
						local.class,
					),
				})}
				style={tactileTransition(
					"color, background-color, border-color, box-shadow, opacity, scale",
				)}
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
				{local.children ?? <Icon name="X" size={local.touch ? 15 : 14} />}
			</BaseButton>
		</Foreground.Provider>
	);
}

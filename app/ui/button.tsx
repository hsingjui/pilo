import { split, token } from "nsh";
import {
	Button as BaseButton,
	type ButtonProps as BaseButtonProps,
} from "nsh/base";
import { styleVar } from "./theme-style";
import { Foreground } from "./foreground";
import { classNames } from "./class-names";
import { blurOnPointerPress, focusRingStyle } from "./focus-ring-style";
import { tactileTransition } from "./motion";

const variants = {
	default: "bg-primary text-primary-foreground hover:bg-button-hover",
	destructive:
		"bg-destructive text-destructive-foreground hover:bg-destructive/90",
	outline:
		"border border-input-border bg-background hover:bg-hover hover:text-hover-foreground",
	secondary:
		"bg-button-secondary text-button-secondary-foreground hover:bg-button-secondary-hover",
	ghost: "hover:bg-hover hover:text-hover-foreground",
	link: "text-primary underline-offset-4 hover:underline",
};

const foregrounds = {
	default: "primary-foreground",
	destructive: "destructive-foreground",
	outline: "foreground",
	secondary: "button-secondary-foreground",
	ghost: "foreground",
	link: "primary",
} as const satisfies Record<keyof typeof variants, string>;

const sizes = {
	default: "h-(--pilo-button-height) px-4 py-2",
	sm: "h-(--pilo-button-sm-height) px-3 py-0 text-xs text-(length:--pilo-ui-text-xs)",
	lg: "h-(--pilo-button-lg-height) px-8 py-0",
	icon: "h-(--pilo-button-icon-size) w-(--pilo-button-icon-size) p-0",
};

export interface ButtonProps extends BaseButtonProps {
	variant?: keyof typeof variants;
	size?: keyof typeof sizes;
}

export function buttonVariants(
	props: Pick<ButtonProps, "variant" | "size" | "class"> = {},
) {
	return classNames(
		"flex-row items-center justify-center gap-(--pilo-button-gap) whitespace-nowrap rounded-(--pilo-radius-md) text-sm text-(length:--pilo-ui-text-sm) font-medium font-sans text-foreground active:scale-[0.96] focus-visible:outline-hidden disabled:opacity-50",
		variants[props.variant ?? "default"],
		sizes[props.size ?? "default"],
		props.class,
	);
}

function shadow(variant: ButtonProps["variant"]): string | undefined {
	if (variant === "ghost" || variant === "link") return undefined;
	return styleVar(
		variant === "default" || variant === undefined
			? "pilo-button-primary-shadow"
			: "pilo-button-secondary-shadow",
	);
}

function disabledStyle(variant: ButtonProps["variant"]) {
	const color = token("muted-foreground");
	if (
		variant === undefined ||
		variant === "default" ||
		variant === "destructive" ||
		variant === "secondary"
	) {
		return {
			backgroundColor: token("muted"),
			color,
			boxShadow: "none",
			opacity: 1,
		};
	}
	return {
		color,
		boxShadow: "none",
		opacity: variant === "outline" ? 0.7 : 0.6,
	};
}

export function Button(props: ButtonProps) {
	const [local, rest] = split(props, [
		"variant",
		"size",
		"class",
		"style",
		"focusVisibleStyle",
		"disabled",
		"disabledStyle",
		"ref",
		"onMouseUp",
	]);
	const pointerBlur = blurOnPointerPress(local);
	const foreground = () =>
		token(
			local.disabled
				? "muted-foreground"
				: foregrounds[local.variant ?? "default"],
		);
	return (
		<Foreground.Provider value={foreground}>
			<BaseButton
				{...rest}
				disabled={local.disabled}
				disabledStyle={[disabledStyle(local.variant), local.disabledStyle]}
				ref={pointerBlur.ref}
				onMouseUp={pointerBlur.onMouseUp}
				class={buttonVariants(local)}
				style={[
					tactileTransition(
						"color, background-color, border-color, box-shadow, opacity, scale",
					),
					{ boxShadow: shadow(local.variant) },
					local.style,
				]}
				focusVisibleStyle={focusRingStyle(
					token("ring"),
					shadow(local.variant),
					local.focusVisibleStyle,
				)}
			/>
		</Foreground.Provider>
	);
}

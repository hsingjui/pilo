import { split, token, type StyleProp, type ViewStyle } from "nsh";
import {
	Button as BaseButton,
	type ButtonProps as BaseButtonProps,
} from "nsh/base";
import { styleVar } from "./theme-style";
import { Foreground } from "./foreground";

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

const sizes = {
	default: "h-(--pilo-button-height) px-4 py-2",
	sm: "h-(--pilo-button-sm-height) px-3 py-0 text-xs",
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
	return [
		"flex-row items-center justify-center gap-(--pilo-button-gap) whitespace-nowrap rounded-(--pilo-radius-md) text-sm font-medium font-sans text-foreground transition-[color,background-color,border-color,scale] active:scale-[0.96] focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/60 disabled:opacity-50",
		variants[props.variant ?? "default"],
		sizes[props.size ?? "default"],
		props.class,
	]
		.filter(Boolean)
		.join(" ");
}

function shadow(variant: ButtonProps["variant"]): StyleProp<ViewStyle> {
	if (variant === "ghost" || variant === "link") return undefined;
	return {
		boxShadow: styleVar(
			variant === "default" || variant === undefined
				? "pilo-button-primary-shadow"
				: "pilo-button-secondary-shadow",
		),
	};
}

export function Button(props: ButtonProps) {
	const [local, rest] = split(props, ["variant", "size", "class", "style"]);
	const foreground = () =>
		token(
			local.variant === "destructive"
				? "destructive-foreground"
				: local.variant === "secondary"
					? "button-secondary-foreground"
					: local.variant === "link"
						? "primary"
						: local.variant === "ghost" || local.variant === "outline"
							? "foreground"
							: "primary-foreground",
		);
	return (
		<Foreground.Provider value={foreground}>
			<BaseButton
				{...rest}
				class={buttonVariants(local)}
				style={[shadow(local.variant), local.style]}
			/>
		</Foreground.Provider>
	);
}

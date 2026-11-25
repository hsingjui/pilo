import { colorScheme, reduceMotion, signal, split, token } from "nsh";
import {
	Checkbox as BaseCheckbox,
	type CheckboxProps as BaseCheckboxProps,
} from "nsh/base";
import { classNames } from "./class-names";
import { focusRingStyle } from "./focus-ring-style";
import { Icon } from "./icon";
import { MOTION, springTransition } from "./motion";
import { styleVar } from "./theme-style";

export interface CheckboxProps extends Omit<
	BaseCheckboxProps,
	"children" | "indicator"
> {
	defaultChecked?: boolean;
	indicatorColor?: string;
	invalid?: boolean;
}

export function Checkbox(props: CheckboxProps) {
	const [local, rest] = split(props, [
		"checked",
		"indeterminate",
		"defaultChecked",
		"onChange",
		"class",
		"style",
		"indicatorClass",
		"indicatorStyle",
		"indicatorColor",
		"focusVisibleStyle",
		"invalid",
	]);
	const ownChecked = signal(local.defaultChecked ?? false);
	const checked = () => local.checked ?? ownChecked();
	const marked = () => checked() || local.indeterminate;
	return (
		<BaseCheckbox
			{...rest}
			checked={checked()}
			indeterminate={local.indeterminate}
			onChange={(event) => {
				if (local.checked === undefined) ownChecked.set(event.checked);
				local.onChange?.(event);
			}}
			class={classNames(
				"size-4 shrink-0 items-center justify-center rounded-[4px] border duration-[110ms] active:scale-[0.92] focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
				marked()
					? "bg-primary border-primary"
					: "border-input-border dark:bg-input/30",
				local.invalid ? "border-destructive" : "focus-visible:border-ring",
				local.class,
			)}
			style={[
				reduceMotion()
					? { transitionProperty: "none" }
					: {
							transitionProperty:
								"background-color, border-color, box-shadow, opacity, scale",
							transitionTimingFunction: MOTION.easing.standard,
						},
				{ boxShadow: styleVar("pilo-shadow-xs") },
				local.style,
			]}
			focusVisibleStyle={focusRingStyle(
				token(local.invalid ? "destructive" : "ring"),
				styleVar("pilo-shadow-xs"),
				local.focusVisibleStyle,
				{
					width: 3,
					opacity: local.invalid ? (colorScheme() === "dark" ? 40 : 20) : 100,
				},
			)}
			indicatorClass={classNames(
				"size-3.5 shrink-0 items-center justify-center",
				local.indicatorClass,
			)}
			indicatorStyle={[
				springTransition("opacity, transform", "crisp"),
				marked()
					? { opacity: 1, transform: [{ scale: 1 }] }
					: { opacity: 0, transform: [{ scale: 0.6 }] },
				local.indicatorStyle,
			]}
			indicator={
				<Icon
					name={local.indeterminate ? "Minus" : "Check"}
					size={14}
					color={local.indicatorColor ?? token("primary-foreground")}
				/>
			}
		/>
	);
}

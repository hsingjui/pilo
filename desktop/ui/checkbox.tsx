import { colorScheme, signal, split, token } from "nsh";
import {
	Checkbox as BaseCheckbox,
	type CheckboxProps as BaseCheckboxProps,
} from "nsh/base";
import { classNames } from "./class-names";
import { focusRingStyle } from "./focus-ring-style";
import { Icon } from "./icon";
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
				"size-4 shrink-0 items-center justify-center rounded-[4px] border transition-shadow focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-50",
				marked()
					? "bg-primary border-primary"
					: "border-input-border dark:bg-input/30",
				local.invalid ? "border-destructive" : "focus-visible:border-ring",
				local.class,
			)}
			style={[{ boxShadow: styleVar("pilo-shadow-xs") }, local.style]}
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
			indicatorStyle={local.indicatorStyle}
			indicator={
				local.indeterminate ? (
					<Icon
						name="Minus"
						size={14}
						color={local.indicatorColor ?? token("primary-foreground")}
					/>
				) : checked() ? (
					<Icon
						name="Check"
						size={14}
						color={local.indicatorColor ?? token("primary-foreground")}
					/>
				) : null
			}
		/>
	);
}

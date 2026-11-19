import { split } from "nsh";
import { Input as BaseInput, type InputProps } from "nsh/base";
import { styleVar } from "./theme-style";

export type { InputProps } from "nsh/base";

export function Input(props: InputProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"multiline",
		"disabled",
		"readonly",
	]);
	return (
		<BaseInput
			{...rest}
			disabled={local.disabled}
			readonly={local.disabled || local.readonly}
			multiline={local.multiline}
			class={[
				"w-full rounded-(--pilo-radius-md) border border-input-border bg-input-field text-sm font-sans text-input-foreground placeholder:text-input-placeholder hover:border-(--pilo-field-hover-border) focus-visible:border-(--pilo-field-focus-border) focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/60 disabled:bg-muted disabled:opacity-60",
				local.multiline
					? "min-h-20 px-3 py-2"
					: "h-(--pilo-field-height) px-3 py-1",
				local.class,
			]
				.filter(Boolean)
				.join(" ")}
			style={[{ boxShadow: styleVar("pilo-field-shadow") }, local.style]}
		/>
	);
}

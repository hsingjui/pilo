import { split } from "nsh";
import { Input as BaseInput, type InputProps } from "nsh/base";
import { classNames } from "./class-names";

export interface TextareaProps extends Omit<InputProps, "multiline"> {
	rows?: number;
}

export function Textarea(props: TextareaProps) {
	const [local, rest] = split(props, ["rows", "class", "disabled", "readonly"]);
	const rows = () => {
		const value = Math.floor(local.rows ?? 2);
		return Number.isFinite(value) && value > 0 ? value : 2;
	};
	return (
		<BaseInput
			{...rest}
			multiline
			disabled={local.disabled}
			readonly={local.disabled || local.readonly}
			class={classNames(
				"w-full rounded-(--pilo-radius-md) border border-input-border bg-input-field px-3 py-2 text-sm leading-5 font-sans text-input-foreground ring-offset-background placeholder:text-input-placeholder hover:border-(--pilo-field-hover-border) focus-visible:border-(--pilo-field-focus-border) focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60",
				`h-[${rows() * 20 + 18}px]`,
				local.class,
			)}
		/>
	);
}

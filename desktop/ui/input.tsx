import { platform, split, token } from "nsh";
import {
	Input as BaseInput,
	type InputProps as BaseInputProps,
} from "nsh/base";
import { styleVar } from "./theme-style";
import { focusRingStyle } from "./focus-ring-style";

/** Single-line field heights: `sm` matches Button's `sm`, for compact rows such as settings. */
export const fieldSizes = {
	default: "h-(--pilo-field-height) px-3 py-1",
	sm: "h-(--pilo-button-sm-height) px-2.5 py-0",
} as const;

const MONO_FONT_CLASS = /(?:^|\s)font-mono(?:\s|$)/;

/**
 * On Windows, nsh 0.6.1's native Input shifts the baseline of some
 * user-installed monospace/Nerd fonts (such as Maple Mono NF CN) to the bottom
 * edge and clips the glyphs. Override `font-mono` fields to Windows' built-in
 * `ui-monospace` face so single-line inputs stay vertically centered.
 */
export function windowsMonoInputStyle(
	className: string | undefined,
	os: string = platform.os,
) {
	if (os !== "windows" || !className || !MONO_FONT_CLASS.test(className))
		return undefined;
	return { fontFamily: "ui-monospace" } as const;
}

export interface InputProps extends BaseInputProps {
	/** The single-line height; ignored when `multiline`. */
	size?: keyof typeof fieldSizes;
}

export function Input(props: InputProps) {
	const [local, rest] = split(props, [
		"class",
		"style",
		"multiline",
		"disabled",
		"readonly",
		"focusVisibleStyle",
		"size",
	]);
	return (
		<BaseInput
			{...rest}
			disabled={local.disabled}
			readonly={local.disabled || local.readonly}
			multiline={local.multiline}
			class={[
				"w-full rounded-(--pilo-radius-md) border border-input-border bg-input-field text-sm font-sans text-input-foreground placeholder:text-input-placeholder hover:border-(--pilo-field-hover-border) focus-visible:border-(--pilo-field-focus-border) focus-visible:outline-hidden disabled:bg-muted disabled:opacity-60",
				local.multiline
					? "min-h-20 px-3 py-2"
					: fieldSizes[local.size ?? "default"],
				local.class,
			]
				.filter(Boolean)
				.join(" ")}
			style={[
				{ boxShadow: styleVar("pilo-field-shadow") },
				windowsMonoInputStyle(local.class),
				local.style,
			]}
			focusVisibleStyle={focusRingStyle(
				token("ring"),
				styleVar("pilo-field-shadow"),
				local.focusVisibleStyle,
			)}
		/>
	);
}

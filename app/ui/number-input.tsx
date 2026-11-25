import { split, Text, token, View, type ViewProps } from "nsh";
import {
	NumberInput as BaseNumberInput,
	type NumberInputProps as BaseNumberInputProps,
} from "nsh/base";
import { classNames } from "./class-names";
import { focusRingStyle } from "./focus-ring-style";
import type { fieldSizes } from "./input";
import { tactileTransition } from "./motion";
import { styleVar } from "./theme-style";

export interface NumberInputProps extends Omit<
	BaseNumberInputProps,
	"controlsRight" | "controlsClass" | "suffix" | "class" | "testID"
> {
	/** Classes of the bordered field (its width). */
	class?: string;
	testID?: string;
	/** Muted text inside the field after the number (a unit: `px`, `min`). */
	suffix?: string;
	/** The height, as Input's: `sm` for compact rows such as settings. */
	size?: keyof typeof fieldSizes;
	onKeyDown?: ViewProps["onKeyDown"];
}

/**
 * A number field with Input's look and no stepper buttons, as React's
 * `<Input type="number">` with the spinners hidden. NumberInput leaves its
 * look to the app; the border sits on a wrapper because this nsh build wraps
 * the `suffix` slot under the field, so the unit is a sibling instead.
 */
export function NumberInput(props: NumberInputProps) {
	const [local, rest] = split(props, [
		"class",
		"suffix",
		"size",
		"inputClass",
		"onKeyDown",
	]);
	return (
		<View
			class={classNames(
				"flex-row items-center rounded-(--pilo-radius-md) border border-input-border bg-input-field hover:border-(--pilo-field-hover-border) focus-within:border-(--pilo-field-focus-border)",
				local.size === "sm"
					? "h-(--pilo-button-sm-height)"
					: "h-(--pilo-field-height)",
				local.suffix && "pr-3",
				rest.disabled && "bg-muted opacity-60",
				local.class,
			)}
			style={[
				tactileTransition(
					"border-color, background-color, box-shadow, opacity",
				),
				{ boxShadow: styleVar("pilo-field-shadow") },
			]}
			focusWithinStyle={focusRingStyle(
				token("ring"),
				styleVar("pilo-field-shadow"),
			)}
			onKeyDown={local.onKeyDown}
		>
			<BaseNumberInput
				{...rest}
				class="min-w-0 flex-1 border-0 bg-transparent"
				controlsRight
				controlsClass="hidden"
				inputClass={classNames(
					"font-sans text-sm text-input-foreground shadow-none",
					local.size === "sm" ? "px-2.5" : "px-3",
					local.suffix && "pr-1",
					local.inputClass,
				)}
			/>
			{local.suffix ? (
				<Text class="font-sans shrink-0 text-xs text-muted-foreground">
					{local.suffix}
				</Text>
			) : null}
		</View>
	);
}

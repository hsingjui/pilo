import { Text, token, View, type ViewProps } from "nsh";
import { classNames } from "./class-names";
import { focusRingStyle } from "./focus-ring-style";
import { Icon, type IconName } from "./icon";
import { styleVar } from "./theme-style";

type SelectTriggerProps = Pick<
	ViewProps,
	"class" | "disabled" | "testID" | "accessibilityLabel" | "onLayout"
> & {
	value?: string | null;
	placeholder?: string | null;
	/** The trailing icon's name; a ChevronDown when unset. */
	icon?: IconName;
};

export function SelectTrigger(props: SelectTriggerProps) {
	return (
		<View
			testID={props.testID}
			accessibilityLabel={props.accessibilityLabel}
			disabled={props.disabled}
			onLayout={props.onLayout}
			class={classNames(
				"flex-row min-w-0 max-w-full items-center justify-between gap-2 h-(--pilo-field-height) rounded-(--pilo-radius-md) border border-input-border bg-input-field px-3 py-2 text-sm font-sans text-input-foreground hover:border-(--pilo-field-hover-border) focus-visible:border-(--pilo-field-focus-border) focus-visible:outline-hidden disabled:bg-muted disabled:opacity-60",
				props.class ?? "w-full",
			)}
			style={{ boxShadow: styleVar("pilo-field-shadow") }}
			focusVisibleStyle={focusRingStyle(
				token("ring"),
				styleVar("pilo-field-shadow"),
			)}
		>
			<Text
				class={classNames(
					"font-sans min-w-0 flex-1 truncate",
					!props.value && "text-input-placeholder",
				)}
			>
				{() => props.value ?? props.placeholder ?? ""}
			</Text>
			<Icon
				name={props.icon ?? "ChevronDown"}
				color={token("input-foreground")}
			/>
		</View>
	);
}

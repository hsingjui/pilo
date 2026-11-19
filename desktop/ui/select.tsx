import { signal, split, token, Text, View } from "nsh";
import { Select as BaseSelect, type SelectProps } from "nsh/base";
import { classNames } from "./class-names";
import { Icon } from "./icon";
import { styleVar } from "./theme-style";
import { focusRingStyle } from "./focus-ring-style";

export type { SelectProps, SelectItem } from "nsh/base";

export function Select(props: SelectProps) {
	const [local, rest] = split(props, [
		"value",
		"defaultValue",
		"onChange",
		"trigger",
		"popupClass",
		"popupStyle",
		"listClass",
		"itemClass",
		"renderItem",
	]);
	const value = signal(local.defaultValue ?? null);
	const current = () => (local.value === undefined ? value() : local.value);
	const title = () =>
		props.items?.find((item) => item.value === current())?.title;
	return (
		<BaseSelect
			{...rest}
			value={current()}
			onChange={(event) => {
				value.set(event.value);
				local.onChange?.(event);
			}}
			trigger={
				local.trigger ?? (
					<View
						disabled={props.disabled}
						class="flex-row w-full items-center justify-between gap-2 h-(--pilo-field-height) rounded-(--pilo-radius-md) border border-input-border bg-input-field px-3 py-2 text-sm font-sans text-input-foreground hover:border-(--pilo-field-hover-border) focus-visible:border-(--pilo-field-focus-border) focus-visible:outline-hidden disabled:bg-muted disabled:opacity-60"
						style={{ boxShadow: styleVar("pilo-field-shadow") }}
						focusVisibleStyle={focusRingStyle(
							token("ring"),
							styleVar("pilo-field-shadow"),
						)}
					>
						<Text
							class={classNames("flex-1", !title() && "text-input-placeholder")}
						>
							{() => title() ?? props.placeholder ?? ""}
						</Text>
						<Icon name="ChevronDown" color={token("input-foreground")} />
					</View>
				)
			}
			popupClass={classNames(
				"rounded-(--pilo-floating-radius) border border-border bg-popover text-popover-foreground text-sm font-sans",
				local.popupClass,
			)}
			popupStyle={[
				{
					boxShadow: styleVar("pilo-shadow-floating"),
					zIndex: token("z-popover"),
				},
				local.popupStyle,
			]}
			listClass={classNames(
				"p-(--pilo-select-padding) gap-(--pilo-select-gap)",
				local.listClass,
			)}
			itemClass={classNames(
				"group flex-row min-h-(--pilo-select-item-height) rounded-(--pilo-select-item-radius) pl-2 pr-8 py-1.5 text-sm font-sans focus:bg-hover focus:text-hover-foreground selected:bg-(--pilo-select-checked-background) disabled:opacity-50",
				local.itemClass,
			)}
			renderItem={
				local.renderItem ??
				((item) => (
					<View class="flex-row items-center gap-2 w-full">
						<Text class="flex-1">{item.title}</Text>
						<Icon
							name="Check"
							size={14}
							class="opacity-0 group-selected:opacity-100"
							color={token("popover-foreground")}
						/>
					</View>
				))
			}
		/>
	);
}

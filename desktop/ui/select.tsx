import { signal, split, token, Text, View } from "nsh";
import {
	Select as BaseSelect,
	type SelectProps as BaseSelectProps,
} from "nsh/base";
import { classNames } from "./class-names";
import { Icon } from "./icon";
import type { fieldSizes } from "./input";
import { SelectTrigger } from "./select-trigger";
import { styleVar } from "./theme-style";

export type { SelectItem } from "nsh/base";

export interface SelectProps extends BaseSelectProps {
	/** The default trigger's height, as Input's: `sm` for compact rows such as settings. */
	size?: keyof typeof fieldSizes;
}

export function selectItemSpacing() {
	// The scroll view wraps a virtual list, so its gap does not reach the rows.
	return { marginBottom: Math.max(3, token("pilo-select-gap")) };
}

export function Select(props: SelectProps) {
	const [local, rest] = split(props, [
		"class",
		"value",
		"defaultValue",
		"onChange",
		"trigger",
		"popupClass",
		"popupStyle",
		"listClass",
		"itemClass",
		"itemStyle",
		"groupClass",
		"searchClass",
		"renderItem",
		"size",
	]);
	const value = signal(local.defaultValue ?? null);
	const current = () => (local.value === undefined ? value() : local.value);
	const title = () =>
		props.items?.find((item) => item.value === current())?.title;
	return (
		<BaseSelect
			cover={false}
			offset={4}
			{...rest}
			class={classNames("min-w-0 max-w-full", local.class)}
			value={current()}
			onChange={(event) => {
				value.set(event.value);
				local.onChange?.(event);
			}}
			trigger={
				local.trigger ?? (
					<SelectTrigger
						size={local.size}
						disabled={props.disabled}
						value={title()}
						placeholder={props.placeholder}
					/>
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
			listClass={classNames("p-(--pilo-select-padding)", local.listClass)}
			itemClass={classNames(
				"group flex-row min-w-0 min-h-(--pilo-select-item-height) rounded-(--pilo-select-item-radius) px-2 py-1.5 text-sm font-sans focus:bg-hover focus:text-hover-foreground selected:bg-(--pilo-select-checked-background) disabled:opacity-50",
				local.itemClass,
			)}
			itemStyle={[selectItemSpacing(), local.itemStyle]}
			groupClass={classNames(
				"px-2 py-1.5 text-xs font-medium text-muted-foreground",
				local.groupClass,
			)}
			searchClass={classNames(
				"h-8 flex-1 bg-transparent px-3 text-sm outline-hidden placeholder:text-muted-foreground border-b border-border",
				local.searchClass,
			)}
			renderItem={
				local.renderItem ??
				((item) => (
					<View class="min-w-0 flex-1 flex-row items-center gap-2">
						<Text class="font-sans min-w-0 flex-1 truncate">{item.title}</Text>
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

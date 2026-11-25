import { signal, split, token, Text, View, windowSize } from "nsh";
import {
	Select as BaseSelect,
	type SelectProps as BaseSelectProps,
} from "nsh/base";
import { classNames } from "./class-names";
import { Icon } from "./icon";
import type { fieldSizes } from "./input";
import { popupMotionStyles, tactileTransition } from "./motion";
import { SelectTrigger } from "./select-trigger";
import { styleVar } from "./theme-style";

export type { SelectItem } from "nsh/base";

/** Default maximum height of a dropdown list (~8-9 compact rows) before scrolling. */
export const SELECT_LIST_MAX_HEIGHT = 288;

/**
 * Suitable maximum list height for dropdown pickers: caps long lists around
 * 8-9 compact rows on desktop while shrinking on short viewports (e.g. mobile
 * soft keyboard) so the popup stays usable.
 */
export function selectListMaxHeight(): number {
	return Math.min(
		SELECT_LIST_MAX_HEIGHT,
		Math.max(160, Math.round(windowSize().height * 0.45)),
	);
}

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
		"open",
		"defaultOpen",
		"onOpenChange",
		"trigger",
		"popupClass",
		"popupStyle",
		"popupStartingStyle",
		"popupEndingStyle",
		"listClass",
		"listStyle",
		"itemClass",
		"itemStyle",
		"groupClass",
		"searchClass",
		"renderItem",
		"size",
	]);
	const value = signal(local.defaultValue ?? null);
	const ownOpen = signal(local.defaultOpen ?? false);
	const current = () => (local.value === undefined ? value() : local.value);
	const isOpen = () =>
		local.open === undefined ? ownOpen() : Boolean(local.open);
	const title = () =>
		props.items?.find((item) => item.value === current())?.title;
	const motion = () => popupMotionStyles();
	return (
		<BaseSelect
			cover={false}
			offset={4}
			{...rest}
			class={classNames("min-w-0 max-w-full", local.class)}
			value={current()}
			open={local.open}
			defaultOpen={local.defaultOpen}
			onOpenChange={(event) => {
				if (local.open === undefined) ownOpen.set(event.open);
				local.onOpenChange?.(event);
			}}
			onChange={(event) => {
				value.set(event.value);
				local.onChange?.(event);
			}}
			trigger={
				local.trigger ?? (
					<SelectTrigger
						size={local.size}
						open={isOpen()}
						disabled={props.disabled}
						value={title()}
						placeholder={props.placeholder}
					/>
				)
			}
			popupClass={classNames(
				"overflow-hidden rounded-(--pilo-floating-radius) border border-border bg-popover text-popover-foreground text-sm text-(length:--pilo-ui-text-sm) font-sans",
				// Keep padding off the inner Scroll: nsh Scroll adds padding to its
				// content size, causing a scrollbar even when all items fit.
				!props.searchable && "p-(--pilo-select-padding)",
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
				props.searchable && "m-(--pilo-select-padding)",
				local.listClass,
			)}
			listStyle={[{ maxHeight: selectListMaxHeight() }, local.listStyle]}
			itemClass={classNames(
				"group flex-col items-stretch justify-center min-w-0 min-h-(--pilo-select-item-height) rounded-(--pilo-select-item-radius) px-2 py-1.5 text-sm text-(length:--pilo-ui-text-sm) font-sans focus:bg-hover focus:text-hover-foreground selected:bg-(--pilo-select-checked-background) disabled:opacity-50",
				local.itemClass,
			)}
			itemStyle={[
				selectItemSpacing(),
				tactileTransition("background-color, color"),
				local.itemStyle,
			]}
			groupClass={classNames(
				"px-2 py-1.5 text-xs text-(length:--pilo-ui-text-xs) font-medium text-muted-foreground",
				local.groupClass,
			)}
			searchClass={classNames(
				"h-8 flex-1 bg-transparent px-3 text-sm text-(length:--pilo-ui-text-sm) outline-hidden placeholder:text-muted-foreground border-b border-border",
				local.searchClass,
			)}
			renderItem={
				local.renderItem ??
				((item) => (
					<View class="w-full min-w-0 flex-row items-center gap-2">
						<Text class="font-sans min-w-0 flex-1 truncate">{item.title}</Text>
						<Icon
							name="Check"
							size={14}
							class="shrink-0 opacity-0 group-selected:opacity-100"
							style={tactileTransition("opacity")}
							color={token("popover-foreground")}
						/>
					</View>
				))
			}
		/>
	);
}

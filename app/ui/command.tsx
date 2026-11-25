import { split, Text, View, token } from "nsh";
import {
	Command as BaseCommand,
	type CommandEntry,
	type CommandProps,
} from "nsh/base";
import { classNames } from "./class-names";
import { Foreground } from "./foreground";
import { Icon } from "./icon";
import { tactileTransition } from "./motion";

export type {
	CommandEntry,
	CommandGroup,
	CommandItem,
	CommandProps,
	CommandRef,
} from "nsh/base";

function renderItem(item: CommandEntry) {
	return (
		<View class="w-full flex-row items-center gap-(--pilo-command-item-gap)">
			<Text class="font-sans">{item.label}</Text>
			{item.shortcutLabel ? (
				<View class="ml-auto">
					<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) tracking-widest text-muted-foreground">
						{item.shortcutLabel}
					</Text>
				</View>
			) : null}
		</View>
	);
}

export function Command(props: CommandProps) {
	const [local, rest] = split(props, [
		"class",
		"searchBarClass",
		"searchClass",
		"listClass",
		"itemClass",
		"itemStyle",
		"groupClass",
		"separatorClass",
		"renderItem",
		"searchPrefix",
		"empty",
		"separator",
	]);
	return (
		<Foreground.Provider value={() => token("popover-foreground")}>
			<BaseCommand
				{...rest}
				class={classNames(
					"h-full w-full flex-col overflow-hidden bg-popover text-popover-foreground font-sans",
					local.class,
				)}
				searchBarClass={classNames(
					"h-(--pilo-command-input-height) shrink-0 flex-row items-center gap-3 border-b border-border px-4",
					local.searchBarClass,
				)}
				searchClass={classNames(
					"h-full flex-1 bg-transparent text-sm text-(length:--pilo-ui-text-sm) outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
					local.searchClass,
				)}
				// Margin instead of padding on the inner Scroll avoids inflating its
				// scroll content size and showing a scrollbar when all rows fit.
				listClass={local.listClass ?? "max-h-72 m-1"}
				itemClass={classNames(
					"group flex-col items-stretch justify-center min-h-(--pilo-command-item-height) rounded-(--pilo-radius-md) px-2.5 py-2 text-sm text-(length:--pilo-ui-text-sm) text-foreground outline-hidden hover:bg-hover focus:bg-hover hover:text-hover-foreground focus:text-hover-foreground disabled:opacity-50",
					local.itemClass,
				)}
				itemStyle={[
					tactileTransition("background-color, color"),
					local.itemStyle,
				]}
				groupClass={classNames(
					"px-2 py-1.5 text-xs text-(length:--pilo-ui-text-xs) font-medium text-muted-foreground",
					local.groupClass,
				)}
				separatorClass={classNames("h-px bg-border", local.separatorClass)}
				separator={local.separator ?? false}
				searchPrefix={
					local.searchPrefix ?? (
						<Icon name="Search" size={16} color={token("muted-foreground")} />
					)
				}
				renderItem={local.renderItem ?? renderItem}
				empty={
					local.empty ? (
						<View class="items-center py-6 text-sm text-(length:--pilo-ui-text-sm)">
							{local.empty}
						</View>
					) : undefined
				}
			/>
		</Foreground.Provider>
	);
}

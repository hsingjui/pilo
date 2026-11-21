import { signal, Text, View } from "nsh";
import type { CommandItem } from "nsh/base";

import { t } from "../app/i18n";
import type { FontOption } from "@shared/font-settings";
import { Command } from "../ui/command";
import { Icon } from "../ui/icon";
import { Popover } from "../ui/popover";
import { selectItemSpacing } from "../ui/select";
import { SelectTrigger } from "../ui/select-trigger";

export type FontSelectGroup = {
	label: string;
	options: ReadonlyArray<FontOption>;
};

/** The id the "use the typed name" item carries: no font family is NUL. */
const CUSTOM_ITEM_ID = "\x00custom";

/**
 * A searchable picker of font families grouped by section: a trigger opens a
 * popover whose command list previews every option in its own font. The
 * search's text is offered as a custom family too (`useCustomFont`), for a
 * family the system list leaves out.
 */
export function FontSelect(props: {
	value: string;
	groups: ReadonlyArray<FontSelectGroup>;
	onChange: (value: string) => void;
	class?: string;
	testID?: string;
	accessibilityLabel?: string;
}) {
	const open = signal(false);
	const query = signal("");
	const triggerWidth = signal<number | undefined>(undefined);
	const label = (option: FontOption) =>
		option.labelKey ? String(t(option.labelKey)) : option.label;
	const optionByValue = () => {
		const map = new Map<string, FontOption>();
		for (const group of props.groups)
			for (const option of group.options) map.set(option.value, option);
		return map;
	};
	/** The typed name while no option's value or label already covers it. */
	const customName = () => {
		const name = query().trim();
		if (!name) return undefined;
		const key = name.toLowerCase();
		for (const option of optionByValue().values()) {
			if (option.value.toLowerCase() === key) return undefined;
			if (label(option).toLowerCase() === key) return undefined;
		}
		return name;
	};
	const items = (): CommandItem[] => {
		const list: CommandItem[] = props.groups
			.filter((group) => group.options.length > 0)
			.flatMap((group) =>
				group.options.map((option) => ({
					id: option.value,
					label: label(option),
					group: group.label,
					checked: option.value === props.value,
				})),
			);
		const custom = customName();
		if (custom) {
			list.push({
				id: CUSTOM_ITEM_ID,
				label: String(t("settings.useCustomFont", { font: custom })),
				checked: props.value === custom,
			});
		}
		return list;
	};
	const selectedTitle = () => {
		const option = optionByValue().get(props.value);
		return option ? label(option) : props.value;
	};
	const itemFamily = (id: string) => {
		if (id === CUSTOM_ITEM_ID) return customName();
		return optionByValue().get(id)?.family;
	};
	return (
		<Popover
			open={open()}
			onOpenChange={({ open: next }) => open.set(next)}
			align="start"
			offset={4}
			popupClass="p-0 overflow-hidden"
			popupStyle={{ width: triggerWidth() }}
			trigger={
				<SelectTrigger
					testID={props.testID}
					accessibilityLabel={props.accessibilityLabel}
					size="sm"
					class={props.class}
					value={selectedTitle()}
					icon="ChevronsUpDown"
					onLayout={({ bounds }) => triggerWidth.set(bounds.size.width)}
				/>
			}
		>
			<Command
				items={items()}
				itemStyle={selectItemSpacing()}
				autoFocus
				placeholder={String(t("settings.searchFonts"))}
				searchAccessibilityLabel={String(t("settings.searchFonts"))}
				empty={
					<Text class="font-sans text-muted-foreground">
						{t("settings.noMatchingFonts")}
					</Text>
				}
				onSelect={({ id }) => {
					props.onChange(id === CUSTOM_ITEM_ID ? customName()! : id);
					open.set(false);
				}}
				onQueryChange={({ query: next }) => query.set(next)}
				onCancel={() => open.set(false)}
				renderItem={(entry) => {
					const family = itemFamily(entry.id);
					return (
						<View class="min-w-0 flex-row items-center gap-2">
							<Text
								class="min-w-0 flex-1 truncate"
								style={family ? { fontFamily: `"${family}"` } : undefined}
							>
								{entry.label}
							</Text>
							<Icon
								name="Check"
								class={entry.checked ? "shrink-0" : "shrink-0 opacity-0"}
								size={14}
							/>
						</View>
					);
				}}
			/>
		</Popover>
	);
}

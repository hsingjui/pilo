import { token, Text, View } from "nsh";
import type { SelectItem } from "nsh/base";

import { t } from "../app/i18n";
import type { FontOption } from "@/lib/font-settings";
import { classNames } from "../ui/class-names";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
import { Select } from "../ui/select";
import { styleVar } from "../ui/theme-style";

export type FontSelectGroup = {
	label: string;
	options: ReadonlyArray<FontOption>;
};

/**
 * A searchable picker of font families grouped by section, as
 * `font-select.tsx` in the Tauri app: each row previews its font, the trigger
 * shows the chosen label (the raw value while it is in no group).
 */
export function FontSelect(props: {
	value: string;
	groups: ReadonlyArray<FontSelectGroup>;
	onChange: (value: string) => void;
	class?: string;
	testID?: string;
	accessibilityLabel?: string;
}) {
	const label = (option: FontOption) =>
		option.labelKey ? String(t(option.labelKey)) : option.label;
	const items = (): SelectItem[] =>
		props.groups
			.filter((group) => group.options.length > 0)
			.flatMap((group) =>
				group.options.map((option) => ({
					value: option.value,
					title: label(option),
					group: group.label,
				})),
			);
	const optionByValue = () => {
		const map = new Map<string, FontOption>();
		for (const group of props.groups)
			for (const option of group.options) map.set(option.value, option);
		return map;
	};
	const selectedTitle = () => optionByValue().get(props.value);
	return (
		<Select
			testID={props.testID}
			accessibilityLabel={props.accessibilityLabel}
			class={props.class}
			items={items()}
			value={props.value}
			searchable
			searchPlaceholder={String(t("settings.searchFonts"))}
			searchAccessibilityLabel={String(t("settings.searchFonts"))}
			empty={
				<View class="px-3 py-4">
					<Text class="text-sm text-muted-foreground text-center">
						{t("settings.noMatchingFonts")}
					</Text>
				</View>
			}
			onChange={({ value }) => {
				if (value !== null) props.onChange(value);
			}}
			trigger={
				<View
					class={classNames(
						"flex-row w-full items-center justify-between gap-2 h-(--pilo-field-height) rounded-(--pilo-radius-md) border border-input-border bg-input-field px-3 py-2 text-sm font-sans text-input-foreground hover:border-(--pilo-field-hover-border) focus-visible:border-(--pilo-field-focus-border) focus-visible:outline-hidden",
						props.class,
					)}
					style={{ boxShadow: styleVar("pilo-field-shadow") }}
					focusVisibleStyle={focusRingStyle(
						token("ring"),
						styleVar("pilo-field-shadow"),
					)}
				>
					<Text class="flex-1 truncate">
						{() => (selectedTitle() ? label(selectedTitle()!) : props.value)}
					</Text>
					<Icon name="ChevronsUpDown" color={token("input-foreground")} />
				</View>
			}
			renderItem={(entry) => {
				const option = optionByValue().get(entry.value);
				return (
					<View class="flex-row items-center gap-2 w-full">
						<Text
							class="flex-1 truncate"
							style={
								option?.family
									? { fontFamily: `"${option.family}"` }
									: undefined
							}
						>
							{entry.title}
						</Text>
						<Icon
							name="Check"
							class="opacity-0 group-selected:opacity-100 shrink-0"
							size={14}
						/>
					</View>
				);
			}}
		/>
	);
}

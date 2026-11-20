import { mount, signal, Text, View } from "nsh";

import {
	MONOSPACE_FONT_BUILTIN_OPTIONS,
	PAGE_FONT_BUILTIN_OPTIONS,
} from "@/lib/font-settings";
import "../app/fonts";
import { initializeI18n, t } from "../app/i18n";
import { FontSelect } from "../settings/font-select";

initializeI18n();

mount(() => {
	const value = signal("system-sans");
	const groups = () => [
		{
			label: String(t("settings.builtIn")),
			options: PAGE_FONT_BUILTIN_OPTIONS,
		},
		{
			label: String(t("settings.systemFonts")),
			options: [
				{ value: "sf-pro", label: "SF Pro", family: "SF Pro" },
				{ value: "helvetica", label: "Helvetica", family: "Helvetica" },
			],
		},
	];
	return (
		<View class="p-12 gap-4 bg-background w-[300px]">
			<FontSelect
				testID="font-select"
				value={value()}
				groups={groups()}
				onChange={(next) => value.set(next)}
			/>
			<FontSelect
				testID="mono-select"
				value="jetbrains-mono"
				groups={[
					{
						label: String(t("settings.builtIn")),
						options: MONOSPACE_FONT_BUILTIN_OPTIONS,
					},
				]}
				onChange={() => {}}
			/>
			<Text>{() => `Value: ${value()}`}</Text>
		</View>
	);
});

import { mount, signal, Text, View } from "nsh";

import "../shell/fonts";
import { initializeI18n } from "../shell/i18n";
import { FontSizeInput } from "../settings/font-size-input";
import { Button } from "../ui/button";

initializeI18n();

mount(() => {
	const value = signal(15);
	const saved = signal("none");
	return (
		<View class="p-12 gap-4 bg-background">
			<FontSizeInput
				testID="size"
				class="w-28"
				label="Interface"
				min={12}
				max={18}
				value={value()}
				onChange={(next) => {
					value.set(next);
					saved.set(String(next));
				}}
			/>
			<Text>{() => `Value: ${value()}; saved: ${saved()}`}</Text>
			<Button testID="elsewhere">
				<Text>Elsewhere</Text>
			</Button>
		</View>
	);
});

import { mount, signal, token, Text, View } from "nsh";
import "../shell/fonts";
import { Switch } from "../ui/switch";

mount(() => {
	const checked = signal(false);
	const changes = signal(0);
	return (
		<View class="p-4 gap-4 items-start bg-background">
			<Switch
				testID="switch"
				accessibilityLabel="Automatic titles"
				checked={checked()}
				onChange={(event) => {
					checked.set(event.checked);
					changes.update((n) => n + 1);
				}}
			/>
			<Text>{() => `Checked: ${checked()}; changes: ${changes()}`}</Text>
			<Switch
				testID="disabled"
				accessibilityLabel="Disabled setting"
				disabled
				onChange={() => changes.update((n) => n + 1)}
			/>
			<Switch
				testID="disabled-checked"
				accessibilityLabel="Disabled enabled setting"
				checked
				disabled
				onChange={() => changes.update((n) => n + 1)}
			/>
			<View
				testID="reference-on"
				style={{
					width: 1,
					height: 1,
					opacity: 0,
					backgroundColor: token("primary"),
				}}
			/>
			<View
				testID="reference-off"
				style={{
					width: 1,
					height: 1,
					opacity: 0,
					backgroundColor: token("switch-track"),
				}}
			/>
		</View>
	);
});

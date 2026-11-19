import { mount, signal, Text, View } from "nsh";
import "../app/fonts";
import { Select } from "../ui/select";

mount(() => {
	const value = signal<string | null>(null);
	const changes = signal(0);
	const items = [
		{ value: "fast", title: "Fast" },
		{ value: "quality", title: "Quality" },
		{ value: "blocked", title: "Unavailable", disabled: true },
	];
	return (
		<View class="p-12 gap-8 bg-background">
			<Select
				items={items}
				placeholder="Choose a model"
				value={value()}
				onChange={({ value: next }) => {
					value.set(next);
					changes.update((n) => n + 1);
				}}
			/>
			<Text>{() => `Value: ${value() ?? "none"}; changes: ${changes()}`}</Text>
			<Select items={items} placeholder="Disabled select" disabled />
			<Select
				items={items}
				defaultValue="fast"
				accessibilityLabel="Uncontrolled"
			/>
			<Select
				items={[]}
				placeholder="Empty select"
				empty={<Text>No options</Text>}
			/>
		</View>
	);
});

import { mount, signal, Text, View } from "nsh";
import "../shell/fonts";
import { Select } from "../ui/select";

const manyItems = Array.from({ length: 24 }, (_, index) => ({
	value: `option-${index + 1}`,
	title: `Option ${index + 1}`,
}));

mount(() => {
	const value = signal<string | null>(null);
	const changes = signal(0);
	const longValue = signal<string | null>(null);
	const searchableValue = signal<string | null>(null);
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
			<Select
				testID="long-select"
				items={manyItems}
				placeholder="Choose many"
				value={longValue()}
				onChange={({ value: next }) => longValue.set(next)}
			/>
			<Text>{() => `Long: ${longValue() ?? "none"}`}</Text>
			<Select
				testID="searchable-select"
				searchable
				searchPlaceholder="Filter options"
				searchAccessibilityLabel="Filter options"
				items={items}
				placeholder="Searchable select"
				value={searchableValue()}
				onChange={({ value: next }) => searchableValue.set(next)}
			/>
			<Text>{() => `Searchable: ${searchableValue() ?? "none"}`}</Text>
		</View>
	);
});

import { mount, signal, token, Text, View } from "nsh";
import { Tabs } from "../ui/tabs";
import { Tab } from "../ui/tab";

mount(() => {
	const selected = signal("overview");
	const presses = signal(0);
	return (
		<View class="p-4 gap-4 bg-background items-start">
			<Tabs accessibilityLabel="Session sections">
				{["overview", "history", "disabled"].map((id) => (
					<Tab
						testID={id}
						selected={selected() === id}
						disabled={id === "disabled"}
						onPress={() => {
							selected.set(id);
							presses.update((n) => n + 1);
						}}
					>
						<Text>{id}</Text>
					</Tab>
				))}
			</Tabs>
			{() => (
				<Text>
					{selected() === "overview" ? "Overview panel" : "History panel"}
				</Text>
			)}
			<Text>{() => `Presses: ${presses()}`}</Text>
			<Tabs testID="empty" />
			<Tabs accessibilityLabel="Fixed selection">
				<Tab selected testID="fixed-selected">
					<Text>Fixed selected</Text>
				</Tab>
				<Tab testID="fixed-other" onPress={() => presses.update((n) => n + 1)}>
					<Text>Fixed other</Text>
				</Tab>
			</Tabs>
			<View
				testID="reference-selected"
				style={{
					width: 1,
					height: 1,
					opacity: 0,
					backgroundColor: token("background"),
				}}
			/>
		</View>
	);
});

import { mount, signal, Text, View, type InputRef } from "nsh";
import "../app/fonts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { styleVar } from "../ui/theme-style";

mount(() => {
	const value = signal("");
	const submitted = signal("");
	const multiline = signal("");
	const changes = signal(0);
	const geometry = signal("");
	let field: InputRef | undefined;
	return (
		<View class="p-4 gap-3 bg-background" style={{ width: 400 }}>
			<Input
				testID="input"
				placeholder="Session title"
				value={value()}
				onChange={(event) => {
					value.set(event.value);
					changes.update((n) => n + 1);
				}}
				onSubmit={(event) => submitted.set(event.text)}
				ref={(ref) => {
					field = ref;
				}}
			/>
			<Text>{() => `Value: ${value()}`}</Text>
			<Text>{() => `Changes: ${changes()}`}</Text>
			<Text>{() => `Submitted: ${submitted()}`}</Text>
			<Input
				testID="disabled"
				disabled
				value="Unchanged"
				onChange={() => value.set("Incorrect disabled edit")}
			/>
			<Input
				testID="multiline"
				multiline
				placeholder="Session notes"
				value={multiline()}
				onChange={({ value }) => multiline.set(value)}
			/>
			<Text>{() => `Notes: ${multiline()}`}</Text>
			<Input testID="uncontrolled" defaultValue="Initial" />
			<Button
				testID="measure"
				onPress={async () =>
					geometry.set(
						`Field height: ${(await field?.measure())?.bounds.size.height}`,
					)
				}
			>
				<Text>Measure</Text>
			</Button>
			<Text>{geometry}</Text>
			<Text>{() => `Shadow: ${styleVar("pilo-field-shadow")}`}</Text>
		</View>
	);
});

import {
	mount,
	setTheme,
	signal,
	Text,
	View,
	type InputRef,
	type ViewRef,
} from "nsh";
import "../app/fonts";
import claude from "../claude-theme.json";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { setStyleTheme } from "../ui/theme-style";

mount(() => {
	const rows = signal(2);
	const value = signal("Initial notes");
	const focused = signal(false);
	const grown = signal(38);
	const sizes = signal("Sizes: pending");
	const refs: Record<string, InputRef> = {};
	let before: ViewRef | undefined;
	return (
		<View class="flex-1 p-8 gap-4 bg-background text-foreground font-sans">
			<View class="flex-row gap-4">
				<Button
					testID="claude"
					onPress={() => {
						setTheme({ cssVars: claude.cssVars });
						setStyleTheme(claude.styleVars);
					}}
				>
					<Text>Claude theme</Text>
				</Button>
				<Button
					testID="before"
					ref={(ref) => {
						before = ref;
					}}
					onPress={() => before?.focus()}
				>
					<Text>Focus before fields</Text>
				</Button>
			</View>
			<View class="flex-row gap-6">
				<View class="flex-1 gap-2">
					<Text>Default two rows · empty</Text>
					<Textarea
						testID="empty"
						accessibilityLabel="Session notes"
						placeholder="Write session notes…"
						ref={(ref) => {
							refs.empty = ref;
						}}
						onFocus={() => focused.set(true)}
						onBlur={() => focused.set(false)}
					/>
					<Text>Controlled · configurable rows</Text>
					<Textarea
						testID="controlled"
						accessibilityLabel="Controlled notes"
						rows={rows()}
						value={value()}
						onChange={({ value: next }) => value.set(next)}
						ref={(ref) => {
							refs.controlled = ref;
						}}
					/>
					<Text>Four rows · uncontrolled default</Text>
					<Textarea
						testID="four"
						accessibilityLabel="Four-row notes"
						rows={4}
						defaultValue={"First line\nSecond line\nThird line\nFourth line"}
						ref={(ref) => {
							refs.four = ref;
						}}
					/>
				</View>
				<View class="flex-1 gap-2">
					<Text>Disabled</Text>
					<Textarea
						testID="disabled"
						accessibilityLabel="Disabled notes"
						disabled
						value="Locked notes"
						ref={(ref) => {
							refs.disabled = ref;
						}}
					/>
					<Text>Read only · selectable</Text>
					<Textarea
						testID="readonly"
						accessibilityLabel="Read-only notes"
						readonly
						defaultValue="Read-only notes"
						ref={(ref) => {
							refs.readonly = ref;
						}}
					/>
					<Text>Caller height overrides four rows</Text>
					<Textarea
						testID="custom"
						accessibilityLabel="Caller-sized notes"
						rows={4}
						class="h-16"
						ref={(ref) => {
							refs.custom = ref;
						}}
					/>
					<Text>Invalid rows fall back to two</Text>
					<Textarea
						testID="invalid"
						accessibilityLabel="Fallback rows"
						rows={0}
						ref={(ref) => {
							refs.invalid = ref;
						}}
					/>
				</View>
			</View>
			<Text>Caller-owned autosize · capped at 138pt</Text>
			<Textarea
				testID="grow"
				accessibilityLabel="Growing notes"
				rows={1}
				placeholder="This example grows with its content"
				style={{ height: grown() }}
				onContentSizeChange={({ size }) =>
					grown.set(Math.max(38, Math.min(138, Math.ceil(size.height) + 18)))
				}
				ref={(ref) => {
					refs.grow = ref;
				}}
			/>
			<View class="flex-row gap-4">
				<Button testID="rows" onPress={() => rows.set(rows() === 2 ? 4 : 2)}>
					<Text>Toggle controlled rows</Text>
				</Button>
				<Button
					testID="measure"
					onPress={async () => {
						const measured = await Promise.all(
							Object.entries(refs).map(
								async ([name, ref]) =>
									`${name} ${(await ref.measure())?.bounds.size.height}`,
							),
						);
						sizes.set(`Sizes: ${measured.join("; ")}`);
					}}
				>
					<Text>Measure fields</Text>
				</Button>
			</View>
			<Text>{() => `Rows: ${rows()}`}</Text>
			<Text>{() => `Value: ${value()}`}</Text>
			<Text>{() => `Empty focused: ${focused()}`}</Text>
			<Text>{() => `Grown: ${grown()}`}</Text>
			<Text>{sizes}</Text>
			<View class="flex-row gap-2">
				<View testID="reference-field" class="size-3 bg-input-field" />
				<View testID="reference-muted" class="size-3 bg-muted" />
			</View>
		</View>
	);
});

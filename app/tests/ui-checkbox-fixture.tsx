import { mount, setTheme, signal, Text, View, type ViewRef } from "nsh";
import claude from "../../theme/claude-theme.json";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { setStyleTheme } from "../ui/theme-style";

mount(() => {
	const checked = signal(false);
	const mixed = signal(true);
	const mixedChecked = signal(false);
	const changes = signal(0);
	const defaultValue = signal(true);
	const lockedEvent = signal("none");
	const measured = signal("");
	const slow = signal(false);
	const blocking = signal("JS ready");
	let before: ViewRef | undefined;
	const refs: ViewRef[] = [];
	return (
		<View class="flex-1 p-8 gap-4 bg-background text-foreground font-sans">
			<Text class="text-2xl font-semibold">Pilo / Checkbox</Text>
			<View class="flex-row gap-4">
				<Button
					testID="claude"
					onPress={() => {
						setTheme({ cssVars: claude.cssVars });
						setStyleTheme(claude.styleVars);
					}}
				>
					<Text>Claude</Text>
				</Button>
				<Button
					testID="before"
					ref={(ref) => {
						before = ref;
					}}
					onPress={() => before?.focus()}
				>
					<Text>Focus controls</Text>
				</Button>
			</View>
			<View class="gap-3 text-sm">
				<View class="flex-row items-center gap-3">
					<Checkbox
						testID="control"
						class={slow() ? "duration-[2000ms]" : undefined}
						accessibilityLabel="Choose session"
						checked={checked()}
						ref={(ref) => {
							refs[0] = ref;
						}}
						onChange={(event) => {
							checked.set(event.checked);
							changes.update((n) => n + 1);
						}}
					/>
					<Text>Controlled · 16pt box / 14pt mark</Text>
				</View>
				<View class="flex-row items-center gap-3">
					<Checkbox
						testID="mixed"
						accessibilityLabel="Choose all sessions"
						checked={mixedChecked()}
						indeterminate={mixed()}
						onChange={(event) => {
							mixed.set(false);
							mixedChecked.set(event.checked);
							changes.update((n) => n + 1);
						}}
					/>
					<Text>Indeterminate → checked</Text>
				</View>
				<View class="flex-row items-center gap-3">
					<Checkbox
						testID="locked"
						accessibilityLabel="Caller-owned checked value"
						checked
						onChange={(event) => lockedEvent.set(String(event.checked))}
					/>
					<Text>Checked · caller keeps value</Text>
				</View>
				<View class="flex-row items-center gap-3">
					<Checkbox
						testID="disabled"
						accessibilityLabel="Disabled unchecked"
						disabled
						onChange={() => changes.update((n) => n + 1)}
					/>
					<Text>Disabled unchecked</Text>
				</View>
				<View class="flex-row items-center gap-3">
					<Checkbox
						testID="disabled-checked"
						accessibilityLabel="Disabled checked"
						disabled
						checked
						onChange={() => changes.update((n) => n + 1)}
					/>
					<Text>Disabled checked</Text>
				</View>
				<View class="flex-row items-center gap-3">
					<Checkbox
						testID="disabled-mixed"
						accessibilityLabel="Disabled mixed"
						disabled
						indeterminate
						onChange={() => changes.update((n) => n + 1)}
					/>
					<Text>Disabled indeterminate</Text>
				</View>
				<View class="flex-row items-center gap-3">
					<Checkbox
						testID="default"
						accessibilityLabel="Default checked"
						defaultChecked
						onChange={(event) => defaultValue.set(event.checked)}
					/>
					<Text>Uncontrolled default checked</Text>
				</View>
				<View class="flex-row items-center gap-3">
					<Checkbox
						testID="invalid"
						accessibilityLabel="Invalid option"
						invalid
					/>
					<Text>Invalid option</Text>
				</View>
				<View class="flex-row items-center gap-3">
					<Checkbox
						testID="empty"
						accessibilityLabel="Empty checkbox"
						ref={(ref) => {
							refs[1] = ref;
						}}
					/>
					<Text>Empty indicator keeps its geometry</Text>
				</View>
			</View>
			<View class="flex-row gap-4">
				<Button
					testID="measure"
					class="flex-1"
					onPress={async () => {
						const frames = await Promise.all(refs.map((ref) => ref.measure()));
						measured.set(
							frames
								.map(
									(frame) =>
										`${frame?.bounds.size.width}x${frame?.bounds.size.height}`,
								)
								.join(", "),
						);
					}}
				>
					<Text>Measure</Text>
				</Button>
				<Button
					testID="block"
					class="flex-1"
					onPress={() => {
						blocking.set("Blocking JS for 1500ms");
						slow.set(true);
						setTimeout(() => {
							refs[0]?.focus();
							setTimeout(() => {
								const start = Date.now();
								console.log(`CHECKBOX_BLOCK_START ${start}`);
								while (Date.now() - start < 1500) {}
								const end = Date.now();
								console.log(`CHECKBOX_BLOCK_END ${end}`);
								blocking.set(`JS resumed after ${end - start}ms`);
							}, 50);
						}, 100);
					}}
				>
					<Text>Slow focus + block JS</Text>
				</Button>
			</View>
			<Text>
				{() =>
					`Checked: ${checked()} · Mixed: ${mixed()}/${mixedChecked()} · Changes: ${changes()}`
				}
			</Text>
			<Text>
				{() => `Default: ${defaultValue()} · Locked event: ${lockedEvent()}`}
			</Text>
			<Text>{measured}</Text>
			<Text>{blocking}</Text>
			<View class="absolute opacity-0 pointer-events-none">
				<View
					testID="primary-reference"
					class="size-px bg-primary border border-primary"
				/>
				<View
					testID="empty-reference"
					class="size-px border border-input-border dark:bg-input/30"
				/>
			</View>
		</View>
	);
});

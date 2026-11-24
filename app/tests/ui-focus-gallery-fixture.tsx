import {
	mount,
	setTheme,
	signal,
	Text,
	View,
	Scroll,
	type ScrollRef,
	type ViewRef,
} from "nsh";
import claude from "../../theme/claude-theme.json";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tabs } from "../ui/tabs";
import { Tab } from "../ui/tab";
import { Select } from "../ui/select";
import { Popover } from "../ui/popover";
import { Tooltip } from "../ui/tooltip";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { Toast } from "../ui/toast";
import { Scrollbar } from "../ui/scrollbar";
import { setStyleTheme } from "../ui/theme-style";

mount(() => {
	const checked = signal(false);
	const selected = signal("overview");
	const pressed = signal(0);
	const after = signal(0);
	let scroll: ScrollRef | undefined;
	let beforeBar: ViewRef | undefined;
	return (
		<View class="flex-1 p-8 gap-5 bg-background text-foreground font-sans">
			<View class="flex-row items-center gap-4">
				<Text class="text-2xl font-semibold">
					Pilo / Focus feedback gallery
				</Text>
				<Button
					testID="claude"
					variant="outline"
					onPress={() => {
						setTheme({ cssVars: claude.cssVars });
						setStyleTheme(claude.styleVars);
					}}
				>
					<Text>Claude</Text>
				</Button>
			</View>
			<View class="flex-row gap-8 items-start">
				<View class="w-80 gap-4">
					<Text>Input · 1px ring at 60%</Text>
					<Input testID="input" placeholder="Session title" />
					<Button testID="button" onPress={() => pressed.update((n) => n + 1)}>
						<Text>{() => `Primary action · ${pressed()}`}</Text>
					</Button>
					<Text>Switch · 2px ring, 2px offset</Text>
					<Switch
						testID="switch"
						accessibilityLabel="Automatic titles"
						checked={checked()}
						onChange={({ checked: value }) => checked.set(value)}
					/>
					<Text>{() => `Switch: ${checked()}`}</Text>
					<Text>Tabs · 2px ring, 2px offset</Text>
					<Tabs accessibilityLabel="Sections">
						{(["overview", "history"] as const).map((id) => (
							<Tab
								testID={id}
								selected={selected() === id}
								onPress={() => selected.set(id)}
							>
								<Text>{id}</Text>
							</Tab>
						))}
					</Tabs>
					<Text>Select trigger</Text>
					<Select
						items={[
							{ value: "fast", title: "Fast" },
							{ value: "quality", title: "Quality" },
						]}
						placeholder="Choose a model"
					/>
					<Button
						testID="before-bar"
						variant="outline"
						ref={(ref) => {
							beforeBar = ref;
						}}
						onPress={() => beforeBar?.focus()}
					>
						<Text>Before scrollbar</Text>
					</Button>
					<View class="relative h-20 border border-border rounded-md">
						<Scroll
							ref={(ref) => {
								scroll = ref;
							}}
							scrollbar={false}
							class="size-full"
						>
							<View class="h-80 shrink-0 p-3">
								<Text>Scrollbar · pointer only, no keyboard ring</Text>
							</View>
						</Scroll>
						<Scrollbar scroll={scroll} mode="always" />
					</View>
					<Button
						testID="after-bar"
						variant="outline"
						onPress={() => after.update((n) => n + 1)}
					>
						<Text>{() => `After scrollbar · ${after()}`}</Text>
					</Button>
				</View>
				<View class="w-80 gap-4">
					<Text>Popover / Tooltip triggers</Text>
					<Popover
						align="start"
						trigger={
							<Button testID="popover" variant="outline">
								<Text>Session details</Text>
							</Button>
						}
					>
						<Text>Session details content</Text>
					</Popover>
					<Button
						testID="tooltip"
						variant="secondary"
						tooltip={
							<Tooltip delay={0}>
								<Text>Helpful hint</Text>
							</Tooltip>
						}
					>
						<Text>Tooltip trigger</Text>
					</Button>
					<Text>Menu · focus uses row highlighting</Text>
					<Menu
						trigger={
							<Button testID="menu" variant="outline">
								<Text>Session actions</Text>
							</Button>
						}
					>
						<MenuItem testID="menu-new">
							<Text>New session</Text>
						</MenuItem>
						<MenuItem>
							<Text>Archive session</Text>
						</MenuItem>
					</Menu>
					<Text>Toast close · ghost button</Text>
					<Toast
						transitionStatus="present"
						description="Tab back from the button below."
						closeLabel="Dismiss focus toast"
						onDismissRequest={() => {}}
					>
						<Text>Session saved</Text>
					</Toast>
					<Button testID="after-toast" variant="outline">
						<Text>After toast</Text>
					</Button>
				</View>
			</View>
		</View>
	);
});

import { mount, setTheme, signal, Text, View } from "nsh";
import "../app/fonts";
import claude from "../claude-theme.json";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Tab } from "../ui/tab";
import { Tabs } from "../ui/tabs";
import { Tooltip } from "../ui/tooltip";
import { setStyleTheme } from "../ui/theme-style";

mount(() => {
	const theme = signal("Lody");
	const selected = signal("overview");
	const enabled = signal(true);
	return (
		<View class="flex-1 bg-background p-8 gap-6 font-sans text-foreground">
			<View class="flex-row items-center justify-between">
				<View class="gap-1">
					<Text class="text-2xl font-semibold">Pilo / Native UI</Text>
					<Text class="text-sm text-muted-foreground">
						{() => `${theme()} theme · nsh 0.6.0 · macOS`}
					</Text>
				</View>
				<View class="flex-row gap-2">
					<Button
						testID="lody"
						variant="outline"
						onPress={() => {
							setTheme(null);
							setStyleTheme(null);
							theme.set("Lody");
						}}
					>
						<Text>Lody</Text>
					</Button>
					<Button
						testID="claude"
						variant="outline"
						onPress={() => {
							setTheme({ cssVars: claude.cssVars });
							setStyleTheme(claude.styleVars);
							theme.set("Claude");
						}}
					>
						<Text>Claude</Text>
					</Button>
				</View>
			</View>
			<View class="flex-row gap-8">
				<View class="gap-4" style={{ width: 540 }}>
					<Text class="text-lg font-semibold">
						Buttons &amp; inherited icon colors
					</Text>
					{(
						[
							"default",
							"secondary",
							"destructive",
							"outline",
							"ghost",
							"link",
						] as const
					).map((variant) => (
						<View class="flex-row items-center gap-2">
							<Text class="w-20 text-sm text-muted-foreground">{variant}</Text>
							{(["default", "sm", "lg", "icon"] as const).map((size) => (
								<Button
									variant={variant}
									size={size}
									accessibilityLabel={`${variant} ${size}`}
								>
									<Icon name="Plus" />
									{size === "icon" ? null : (
										<Text>
											{size === "default"
												? "Default"
												: size === "sm"
													? "Small"
													: "Large"}
										</Text>
									)}
								</Button>
							))}
						</View>
					))}
					<View class="flex-row gap-2">
						<Button disabled>
							<Icon name="Plus" />
							<Text>Disabled</Text>
						</Button>
						<Button variant="outline">
							<Icon name="Plus" color="#8750b2" />
							<Text>Explicit icon color</Text>
						</Button>
					</View>
					<Text class="text-sm text-muted-foreground">
						Icon color is inherited; explicit colors still win.
					</Text>
				</View>
				<View class="gap-5" style={{ width: 400 }}>
					<View class="gap-2">
						<Text class="text-lg font-semibold">Input</Text>
						<Input testID="gallery-input" placeholder="Session title" />
						<Input multiline placeholder="Write session notes…" />
						<Input disabled value="Disabled field" />
					</View>
					<View class="gap-2">
						<Text class="text-lg font-semibold">Switch</Text>
						<View class="flex-row items-center gap-3">
							<Switch accessibilityLabel="Unchecked setting" />
							<Text>Off</Text>
							<Switch
								testID="gallery-switch"
								accessibilityLabel="Automatic titles"
								checked={enabled()}
								onChange={({ checked }) => enabled.set(checked)}
							/>
							<Text>On</Text>
							<Switch accessibilityLabel="Disabled setting" checked disabled />
							<Text>Disabled</Text>
						</View>
					</View>
					<View class="gap-2">
						<Text class="text-lg font-semibold">Tabs</Text>
						<Tabs accessibilityLabel="Session sections">
							{["overview", "history", "disabled"].map((id) => (
								<Tab
									testID={`gallery-${id}`}
									selected={selected() === id}
									disabled={id === "disabled"}
									onPress={() => selected.set(id)}
								>
									<Text>
										{id === "overview"
											? "Overview"
											: id === "history"
												? "History"
												: "Disabled"}
									</Text>
								</Tab>
							))}
						</Tabs>
						<Text class="text-sm">
							{() =>
								selected() === "overview"
									? "Overview panel — content belongs to the caller."
									: "History panel — selected by the caller."
							}
						</Text>
					</View>
					<View class="gap-2 items-start">
						<Text class="text-lg font-semibold">Tooltip</Text>
						<Button
							testID="gallery-tooltip"
							variant="secondary"
							tooltip={
								<Tooltip placement="bottom" delay={0}>
									<Text>Pilo tooltip · bottom placement</Text>
								</Tooltip>
							}
						>
							<Text>Hover for a helpful hint</Text>
						</Button>
					</View>
				</View>
			</View>
		</View>
	);
});

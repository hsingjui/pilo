import {
	mount,
	setTheme,
	signal,
	Text,
	View,
	type Bounds,
	type ViewRef,
} from "nsh";
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
import { Popover } from "../ui/popover";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { MenuSeparator } from "../ui/menu-separator";
import { Submenu } from "../ui/submenu";
import { Select } from "../ui/select";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";

mount(() => {
	const theme = signal("Lody");
	const selected = signal("overview");
	const enabled = signal(true);
	const floating = signal(false);
	const dialog = signal(false);
	const model = signal<string | null>(null);
	const alignment = signal("Not measured");
	let popoverTrigger: ViewRef | undefined;
	let menuTrigger: ViewRef | undefined;
	let popoverBounds: Bounds | undefined;
	let menuBounds: Bounds | undefined;
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
			<View class="flex-row items-center gap-3">
				<Button
					testID="show-floating"
					variant="outline"
					onPress={() => floating.set(true)}
				>
					<Text>Show floating surfaces</Text>
				</Button>
				<Button
					testID="show-dialog"
					onPress={() => {
						floating.set(false);
						dialog.set(true);
					}}
				>
					<Text>Open dialog</Text>
				</Button>
				<Button
					testID="measure-floating"
					variant="outline"
					onPress={async () => {
						const [popover, menu] = await Promise.all([
							popoverTrigger?.measure(),
							menuTrigger?.measure(),
						]);
						if (popover && menu && popoverBounds && menuBounds)
							alignment.set(
								`Popover: ${popoverBounds.origin.x.toFixed(1)} / ${popover.pagePosition.x.toFixed(1)}; Menu: ${menuBounds.origin.x.toFixed(1)} / ${menu.pagePosition.x.toFixed(1)}`,
							);
					}}
				>
					<Text>Measure alignment</Text>
				</Button>
			</View>
			<Text class="text-xs text-muted-foreground">{() => alignment()}</Text>
			<View class="flex-row gap-8">
				<View class="w-72 gap-2 items-start">
					<Text class="text-lg font-semibold">Popover</Text>
					<Popover
						align="start"
						popupClass="w-72"
						onPosition={({ bounds }) => {
							popoverBounds = bounds;
						}}
						open={floating()}
						onOpenChange={({ open }) => floating.set(open)}
						trigger={
							<Button
								variant="outline"
								ref={(view) => {
									popoverTrigger = view;
								}}
							>
								<Text>Session details</Text>
							</Button>
						}
					>
						<View class="gap-2">
							<Text class="font-semibold">Session details</Text>
							<Text class="text-sm text-muted-foreground">
								Anchored content · outside / Escape to close
							</Text>
						</View>
					</Popover>
				</View>
				<View class="w-72 gap-2 items-start">
					<Text class="text-lg font-semibold">Menu</Text>
					<Menu
						onPosition={({ bounds }) => {
							menuBounds = bounds;
						}}
						open={floating()}
						onOpenChange={({ open }) => floating.set(open)}
						trigger={
							<Button
								variant="outline"
								ref={(view) => {
									menuTrigger = view;
								}}
							>
								<Text>Session actions</Text>
							</Button>
						}
					>
						<MenuItem icon={<Icon name="Plus" size={14} />} shortcut="⌘N">
							<Text>New session</Text>
						</MenuItem>
						<MenuItem checked>
							<Text>Show timestamps</Text>
						</MenuItem>
						<MenuItem disabled>
							<Text>Unavailable action</Text>
						</MenuItem>
						<MenuSeparator />
						<Submenu label="More actions">
							<MenuItem>
								<Text>Archive session</Text>
							</MenuItem>
						</Submenu>
						<MenuItem
							variant="destructive"
							icon={<Icon name="Trash2" size={14} />}
						>
							<Text>Delete session</Text>
						</MenuItem>
					</Menu>
				</View>
				<View class="w-72 gap-2">
					<Text class="text-lg font-semibold">Select</Text>
					<Select
						value={model()}
						onChange={({ value }) => model.set(value)}
						open={floating()}
						onOpenChange={({ open }) => floating.set(open)}
						placeholder="Choose model"
						items={[
							{ value: "fast", title: "Fast" },
							{ value: "balanced", title: "Balanced" },
							{ value: "quality", title: "Quality", disabled: true },
						]}
					/>
				</View>
			</View>
			<Dialog
				open={dialog()}
				animation="none"
				accessibilityLabel="Edit session"
				onOpenChange={({ open }) => dialog.set(open)}
			>
				<DialogHeader>
					<DialogTitle>Edit session</DialogTitle>
					<DialogDescription>
						Update the details of this coding session.
					</DialogDescription>
				</DialogHeader>
				<Input value="Build native Pilo components" />
				<DialogFooter>
					<Button variant="outline" onPress={() => dialog.set(false)}>
						<Text>Cancel</Text>
					</Button>
					<Button testID="gallery-save" onPress={() => dialog.set(false)}>
						<Text>Save changes</Text>
					</Button>
				</DialogFooter>
			</Dialog>
		</View>
	);
});

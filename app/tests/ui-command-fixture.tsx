import { mount, signal, Text, View, setTheme } from "nsh";
import type { CommandRef } from "nsh/base";
import claude from "../../theme/claude-theme.json";
import { Command } from "../ui/command";
import { CommandDialog } from "../ui/command-dialog";
import { Button } from "../ui/button";
import { setStyleTheme } from "../ui/theme-style";

const items = [
	{
		id: "new",
		label: "New session",
		group: "Sessions",
		keywords: ["create", "start"],
		shortcut: "mod+n",
	},
	{
		id: "archive",
		label: "Archive session",
		group: "Sessions",
		disabled: true,
	},
	{
		id: "settings",
		label: "Settings",
		group: "Workspace",
		keywords: ["preferences"],
		shortcut: "mod+,",
	},
	{
		id: "projects",
		label: "Projects",
		group: "Workspace",
		keywords: ["folders"],
	},
];

mount(() => {
	const query = signal("");
	const highlighted = signal<string | null>(null);
	const selected = signal("none");
	const cancelled = signal(0);
	const controlled = signal(false);
	const custom = signal(false);
	const filterable = signal(true);
	const noItems = signal(false);
	const many = signal(false);
	const loading = signal(false);
	const modal = signal(false);
	const corner = signal(false);
	const modalGeometry = signal("pending");
	const measured = signal("");
	let command: CommandRef | undefined;
	let modalCommand: CommandRef | undefined;
	const footer = () => (
		<View class="gap-1 border-t border-border p-3 text-xs text-muted-foreground">
			<Text>{() => `Query: ${query()}`}</Text>
			<Text>{() => `Highlighted: ${highlighted() ?? "none"}`}</Text>
			<Text>{() => `Selected: ${selected()}`}</Text>
			<Text>{() => `Cancelled: ${cancelled()}`}</Text>
		</View>
	);
	return (
		<View class="flex-1 p-8 gap-4 bg-background text-foreground font-sans">
			<View class="flex-row gap-2">
				<Button
					testID="claude"
					onPress={() => {
						setTheme({ cssVars: claude.cssVars });
						setStyleTheme(claude.styleVars);
					}}
				>
					<Text>Claude theme</Text>
				</Button>
				<Button testID="controlled" onPress={() => controlled.set(true)}>
					<Text>Controlled query</Text>
				</Button>
				<Button testID="unfiltered" onPress={() => filterable.set(false)}>
					<Text>Caller filters</Text>
				</Button>
				<Button testID="empty" onPress={() => noItems.set(!noItems())}>
					<Text>Toggle empty</Text>
				</Button>
				<Button testID="loading" onPress={() => loading.set(!loading())}>
					<Text>Toggle loading</Text>
				</Button>
			</View>
			<View class="flex-row gap-2">
				<Button testID="focus" onPress={() => command?.focus()}>
					<Text>Focus commands</Text>
				</Button>
				<Button testID="custom" onPress={() => custom.set(true)}>
					<Text>Custom rows</Text>
				</Button>
				<Button testID="many" onPress={() => many.set(true)}>
					<Text>Many commands</Text>
				</Button>
				<Button
					testID="open"
					onPress={() => {
						query.set("");
						corner.set(false);
						modal.set(true);
					}}
				>
					<Text>Open command dialog</Text>
				</Button>
				<Button
					testID="measure"
					onPress={async () => {
						const size = await command?.node.measure();
						measured.set(
							`Command: ${size?.bounds.size.width}x${size?.bounds.size.height}; matches ${await command?.matchedCount()}`,
						);
					}}
				>
					<Text>Measure</Text>
				</Button>
			</View>
			{() =>
				!modal() ? (
					<View class="w-[640px] h-[390px] overflow-hidden rounded-(--pilo-radius-xl) border border-border">
						<Command
							testID="command"
							ref={(ref) => {
								command = ref;
							}}
							items={
								noItems()
									? []
									: many()
										? [
												...items,
												...Array.from({ length: 40 }, (_, index) => ({
													id: `extra-${index}`,
													label: `Extra command ${index}`,
													group: "More commands",
												})),
											]
										: items
							}
							query={controlled() ? query() : undefined}
							filterable={filterable()}
							itemClass={
								custom() ? "text-destructive focus:text-destructive" : undefined
							}
							loading={loading()}
							placeholder="Search commands…"
							accessibilityLabel="Commands"
							searchAccessibilityLabel="Find commands"
							separator
							onQueryChange={({ query: next }) => query.set(next)}
							onHighlightChange={({ highlighted: next }) =>
								highlighted.set(next)
							}
							onSelect={({ id }) => selected.set(id)}
							onCancel={() => cancelled.update((n) => n + 1)}
							empty={<Text>No matching commands</Text>}
							footer={footer()}
						/>
					</View>
				) : null
			}
			<Text>{measured}</Text>
			<Text>{() => `Dialog open: ${modal()}`}</Text>
			<CommandDialog
				open={modal()}
				class={corner() ? "self-start" : undefined}
				style={corner() ? { width: 256, height: 200, marginTop: 0 } : undefined}
				backdropTestID="backdrop"
				accessibilityLabel="Command palette"
				onOpen={() => modalCommand?.focus()}
				onOpenChange={({ open }) => modal.set(open)}
			>
				<Command
					ref={(ref) => {
						modalCommand = ref;
					}}
					items={items}
					autoFocus
					placeholder="Search commands…"
					accessibilityLabel="Dialog commands"
					searchAccessibilityLabel="Find dialog commands"
					onSelect={({ id }) => {
						selected.set(id);
						modal.set(false);
					}}
					onQueryChange={({ query: next }) => query.set(next)}
					onHighlightChange={({ highlighted: next }) => highlighted.set(next)}
					onCancel={() => modal.set(false)}
					empty={<Text>No matching commands</Text>}
					footer={
						<View class="gap-2 border-t border-border p-3">
							<Text class="text-xs text-muted-foreground">
								Return to choose · Escape to clear, then close
							</Text>
							<View class="flex-row gap-2">
								<Button
									testID="measure-modal"
									onPress={async () => {
										const layout = await modalCommand?.node.measure();
										modalGeometry.set(
											layout
												? `${layout.bounds.size.width}x${layout.bounds.size.height} at ${layout.pagePosition.x},${layout.pagePosition.y}`
												: "missing",
										);
									}}
								>
									<Text>Measure dialog</Text>
								</Button>
								<Button testID="corner" onPress={() => corner.set(true)}>
									<Text>Backdrop probe layout</Text>
								</Button>
							</View>
							<Text class="text-xs text-muted-foreground">
								{() => `Modal geometry: ${modalGeometry()}`}
							</Text>
						</View>
					}
				/>
			</CommandDialog>
			<View class="flex-row gap-2">
				<View testID="reference-popover" class="size-3 bg-popover" />
				<Text class="text-destructive">Custom color</Text>
				<Text testID="reference-foreground" class="text-foreground">
					Foreground
				</Text>
				<Text testID="reference-muted" class="text-muted-foreground">
					Muted
				</Text>
			</View>
		</View>
	);
});

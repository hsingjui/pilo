import { type Bounds, mount, setTheme, signal, token, Text, View } from "nsh";
import { Button } from "../ui/button";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { MenuSeparator } from "../ui/menu-separator";
import { Submenu } from "../ui/submenu";
import { Icon } from "../ui/icon";
import lody from "../../theme/theme.json";

mount(() => {
	setTheme({
		cssVars: {
			...lody.cssVars,
			light: { ...lody.cssVars.light, "hover-foreground": "#123456" },
			dark: { ...lody.cssVars.dark, "hover-foreground": "#123456" },
		},
	});
	const count = signal(0);
	const checked = signal(true);
	const firstBounds = signal<Bounds | null>(null);
	const secondBounds = signal<Bounds | null>(null);
	const itemGap = () => {
		const first = firstBounds();
		const second = secondBounds();
		if (!first || !second) return "Item gap: unmeasured";
		const gap = Math.round(
			second.origin.y - (first.origin.y + first.size.height),
		);
		return `Item gap: ${gap}`;
	};
	return (
		<View class="p-12 gap-6 items-start bg-background">
			<Menu
				trigger={
					<Button testID="trigger">
						<Text>Actions</Text>
					</Button>
				}
			>
				<>
					<MenuItem
						testID="choose"
						icon={<Icon name="Plus" size={14} />}
						shortcut="⌘N"
						onLayout={({ bounds }) => firstBounds.set(bounds)}
						onSelect={() => count.update((n) => n + 1)}
					>
						<Text>New session</Text>
					</MenuItem>
					<MenuItem
						testID="disabled"
						disabled
						onLayout={({ bounds }) => secondBounds.set(bounds)}
						onSelect={() => count.update((n) => n + 1)}
					>
						<Text>Unavailable</Text>
					</MenuItem>
				</>
				<MenuItem
					testID="checked"
					checked={checked()}
					indicator={
						<View testID="indicator">
							<Icon name="Check" size={14} />
						</View>
					}
					onSelect={() => checked.update((v) => !v)}
				>
					<Text>{() => `Checked: ${checked()}`}</Text>
				</MenuItem>
				<MenuSeparator />
				<MenuItem variant="destructive">
					<Text>Delete</Text>
				</MenuItem>
				<Submenu testID="sub" label="More">
					<MenuItem testID="nested" onSelect={() => count.update((n) => n + 1)}>
						<Text>Nested action</Text>
					</MenuItem>
				</Submenu>
			</Menu>
			<Text>{() => `Selections: ${count()}`}</Text>
			<Text>{itemGap}</Text>
			<Text
				testID="hover-reference"
				style={{ color: token("hover-foreground") }}
			>
				Hover reference
			</Text>
		</View>
	);
});

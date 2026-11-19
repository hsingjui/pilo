import { mount, setTheme, signal, token, Text, View } from "nsh";
import "../app/fonts";
import { Button } from "../ui/button";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { MenuSeparator } from "../ui/menu-separator";
import { Submenu } from "../ui/submenu";
import { Icon } from "../ui/icon";
import lody from "../theme.json";

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
	return (
		<View class="p-12 gap-6 items-start bg-background">
			<Menu
				trigger={
					<Button testID="trigger">
						<Text>Actions</Text>
					</Button>
				}
			>
				<MenuItem
					testID="choose"
					icon={<Icon name="Plus" size={14} />}
					shortcut="⌘N"
					onSelect={() => count.update((n) => n + 1)}
				>
					<Text>New session</Text>
				</MenuItem>
				<MenuItem
					testID="disabled"
					disabled
					onSelect={() => count.update((n) => n + 1)}
				>
					<Text>Unavailable</Text>
				</MenuItem>
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
			<Text
				testID="hover-reference"
				style={{ color: token("hover-foreground") }}
			>
				Hover reference
			</Text>
		</View>
	);
});

import { mount, setTheme, signal, Text, View } from "nsh";
import "../shell/fonts";
import claude from "../../theme/claude-theme.json";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogTitle } from "../ui/dialog-title";
import { Input } from "../ui/input";
import { setStyleTheme } from "../ui/theme-style";

mount(() => {
	const visible = signal(false);
	const focused = signal(false);
	const pressed = signal(0);
	return (
		<View class="flex-1 p-8 gap-4 bg-background">
			<Button
				testID="claude"
				onPress={() => {
					setTheme({ cssVars: claude.cssVars });
					setStyleTheme(claude.styleVars);
				}}
			>
				<Text>Claude</Text>
			</Button>
			<Button testID="open" onPress={() => visible.set(true)}>
				<Text>Open focus-edge dialog</Text>
			</Button>
			<Dialog
				open={visible()}
				animation="none"
				onOpenChange={({ open }) => visible.set(open)}
			>
				<DialogTitle>Focus rings at the content edges</DialogTitle>
				<Text>
					{() =>
						`The input fills the left and right edges. The button fills the left, right and bottom edges. Input focused: ${focused()}`
					}
				</Text>
				<Input
					testID="edge-input"
					placeholder="Full-width input"
					onFocus={() => focused.set(true)}
					onBlur={() => focused.set(false)}
				/>
				<Button
					testID="edge-button"
					class="w-full"
					onPress={() => pressed.update((value) => value + 1)}
				>
					<Text>{() => `Full-width bottom button · ${pressed()}`}</Text>
				</Button>
			</Dialog>
		</View>
	);
});

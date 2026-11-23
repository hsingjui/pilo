import { mount, setTheme, signal, Text, View, type ViewRef } from "nsh";
import "../shell/fonts";
import claude from "../../theme/claude-theme.json";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogTitle } from "../ui/dialog-title";
import { setStyleTheme } from "../ui/theme-style";

mount(() => {
	const visible = signal(false);
	const start = signal("pending");
	const end = signal("pending");
	let first: ViewRef | undefined;
	let last: ViewRef | undefined;
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
				<Text>Open tall dialog</Text>
			</Button>
			<Dialog
				testID="tall-dialog"
				open={visible()}
				animation="none"
				onOpenChange={({ open }) => visible.set(open)}
				onOpen={async () => {
					const top = await first?.measure();
					if (top) start.set(top.pagePosition.y.toFixed(0));
				}}
			>
				<View
					ref={(ref) => {
						first = ref;
					}}
					class="gap-2 shrink-0"
				>
					<DialogTitle>Tall dialog</DialogTitle>
					<Text>{() => `Start: ${start()}`}</Text>
				</View>
				{Array.from({ length: 24 }, (_, i) => (
					<Text class="shrink-0 py-2">{`Section ${i + 1}: scrollable dialog content`}</Text>
				))}
				<View
					ref={(ref) => {
						last = ref;
					}}
					class="gap-2 shrink-0"
				>
					<Text>{() => `End: ${end()}`}</Text>
					<Button
						testID="measure-end"
						onPress={async () => {
							const bottom = await last?.measure();
							if (bottom)
								end.set(
									(bottom.pagePosition.y + bottom.bounds.size.height).toFixed(
										0,
									),
								);
						}}
					>
						<Text>Measure visible end</Text>
					</Button>
				</View>
			</Dialog>
		</View>
	);
});

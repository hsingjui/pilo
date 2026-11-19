import { mount, setTheme, signal, Text, View, type ViewRef } from "nsh";
import "../app/fonts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";
import { setStyleTheme } from "../ui/theme-style";
import claude from "../claude-theme.json";

mount(() => {
	const visible = signal(false);
	const alert = signal(false);
	const focused = signal("");
	const center = signal("pending");
	let header: ViewRef | undefined;
	let footer: ViewRef | undefined;
	return (
		<View class="p-12 gap-6 bg-background">
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
				testID="open"
				onPress={() => {
					alert.set(false);
					visible.set(true);
				}}
			>
				<Text>Open dialog</Text>
			</Button>
			<Button
				testID="alert"
				onPress={() => {
					alert.set(true);
					visible.set(true);
				}}
			>
				<Text>Open alert</Text>
			</Button>
			<Input testID="outside" onFocus={() => focused.set("outside")} />
			<Dialog
				open={visible()}
				animation="none"
				role={alert() ? "alertdialog" : "dialog"}
				class={alert() ? "self-start my-0 w-64" : undefined}
				accessibilityLabel="Edit session"
				accessibilityDescription="Change the session title"
				backdropTestID="backdrop"
				onOpenChange={({ open }) => visible.set(open)}
				onOpen={async () => {
					const [top, bottom] = await Promise.all([
						header?.measure(),
						footer?.measure(),
					]);
					if (top && bottom)
						center.set(
							(
								(top.pagePosition.y +
									bottom.pagePosition.y +
									bottom.bounds.size.height) /
								2
							).toFixed(0),
						);
				}}
			>
				<DialogHeader
					ref={(view) => {
						header = view;
					}}
				>
					<DialogTitle>
						{() => (alert() ? "Confirm action" : "Edit session")}
					</DialogTitle>
					<DialogDescription>Change the session title</DialogDescription>
				</DialogHeader>
				<Input
					testID="first"
					placeholder="Title"
					onFocus={() => focused.set("first")}
				/>
				<Input
					testID="second"
					placeholder="Description"
					onFocus={() => focused.set("second")}
				/>
				<Text>{() => `Focus: ${focused()}`}</Text>
				<Text>{() => `Center: ${center()}`}</Text>
				<DialogFooter
					ref={(view) => {
						footer = view;
					}}
				>
					<Button testID="close" onPress={() => visible.set(false)}>
						<Text>Done</Text>
					</Button>
				</DialogFooter>
			</Dialog>
		</View>
	);
});

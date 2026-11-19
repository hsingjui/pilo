import { mount, signal, Text, View } from "nsh";
import "../app/fonts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";

mount(() => {
	const visible = signal(false);
	const alert = signal(false);
	const focused = signal("");
	return (
		<View class="p-12 gap-6 bg-background">
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
				accessibilityLabel="Edit session"
				accessibilityDescription="Change the session title"
				backdropTestID="backdrop"
				onOpenChange={({ open }) => visible.set(open)}
			>
				<DialogHeader>
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
				<DialogFooter>
					<Button testID="close" onPress={() => visible.set(false)}>
						<Text>Done</Text>
					</Button>
				</DialogFooter>
			</Dialog>
		</View>
	);
});

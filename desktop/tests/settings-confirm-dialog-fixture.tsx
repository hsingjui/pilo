import { mount, signal, Text, View } from "nsh";

import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { SettingsConfirmDialog } from "../settings/settings-confirm-dialog";
import { Button } from "../ui/button";

initializeI18n();

mount(() => {
	const visible = signal(false);
	const busy = signal(false);
	const outcome = signal("idle");
	return (
		<View class="p-12 gap-4 bg-background">
			<Button
				testID="open"
				onPress={() => {
					busy.set(false);
					visible.set(true);
				}}
			>
				<Text>Open confirm</Text>
			</Button>
			<Button
				testID="open-busy"
				onPress={() => {
					busy.set(true);
					visible.set(true);
				}}
			>
				<Text>Open busy</Text>
			</Button>
			<SettingsConfirmDialog
				testID="confirm"
				open={visible()}
				title="Remove connection"
				description="This removes the saved connection."
				confirmLabel="Remove"
				busyLabel="Removing…"
				busy={busy()}
				destructive
				onOpenChange={(next) => {
					visible.set(next);
					if (!next) outcome.set("closed");
				}}
				onConfirm={() => outcome.set("confirmed")}
			/>
			<Text>{() => `Outcome: ${outcome()}`}</Text>
		</View>
	);
});

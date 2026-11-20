import type { JSX } from "nsh";
import { token, Text } from "nsh";

import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";

/**
 * A small confirm dialog over the settings surface, as
 * `settings-confirm-dialog.tsx` in the Tauri app: a cancel and a confirm
 * button; while `busy` the dialog cannot be dismissed and the buttons are
 * disabled with the confirm one showing `busyLabel`.
 */
export function SettingsConfirmDialog(props: {
	open: boolean;
	title: string;
	description?: JSX.Element;
	confirmLabel: string;
	busyLabel?: string;
	busy?: boolean;
	destructive?: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	testID?: string;
}) {
	const busy = () => props.busy ?? false;
	return (
		<Dialog
			testID={props.testID}
			open={props.open}
			role="alertdialog"
			accessibilityLabel={props.title}
			closeOnEscape={!busy()}
			closeOnBackdropPress={!busy()}
			onOpenChange={({ open }) => {
				if (busy() && !open) return;
				props.onOpenChange(open);
			}}
			backdropClass="bg-black/20"
			backdropStyle={{ zIndex: token("z-dialog") }}
		>
			<DialogHeader>
				<DialogTitle class="text-sm font-semibold">{props.title}</DialogTitle>
				<DialogDescription class="text-xs leading-relaxed">
					{props.description}
				</DialogDescription>
			</DialogHeader>
			<DialogFooter class="border-t border-border/60 -mx-(--pilo-dialog-padding) -mb-(--pilo-dialog-padding) px-5 py-3">
				<Button
					variant="ghost"
					size="sm"
					disabled={busy()}
					onPress={() => props.onOpenChange(false)}
				>
					<Text>{t("common.cancel")}</Text>
				</Button>
				<Button
					testID={props.testID ? `${props.testID}-confirm` : undefined}
					variant={props.destructive ? "destructive" : "default"}
					size="sm"
					disabled={busy()}
					onPress={props.onConfirm}
				>
					<Text class="font-sans">
						{() =>
							busy()
								? (props.busyLabel ?? t("common.processing"))
								: props.confirmLabel
						}
					</Text>
				</Button>
			</DialogFooter>
		</Dialog>
	);
}

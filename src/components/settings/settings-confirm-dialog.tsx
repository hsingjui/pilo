import type { ReactNode } from "react";

import { Button } from "@/ui";
import {
	Dialog,
	DialogContentWithoutClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/ui/dialog";

import { SETTINGS_NESTED_DIALOG_OVERLAY_CLASS } from "./compact-layout";

type SettingsConfirmDialogProps = {
	open: boolean;
	title: string;
	description: ReactNode;
	confirmLabel: string;
	busyLabel?: string;
	busy?: boolean;
	destructive?: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
};

export function SettingsConfirmDialog({
	open,
	title,
	description,
	confirmLabel,
	busyLabel = "处理中…",
	busy = false,
	destructive = false,
	onOpenChange,
	onConfirm,
}: SettingsConfirmDialogProps) {
	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (busy && !nextOpen) return;
				onOpenChange(nextOpen);
			}}
		>
			<DialogContentWithoutClose
				overlayClassName={SETTINGS_NESTED_DIALOG_OVERLAY_CLASS}
				className="w-[min(400px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0 shadow-popover sm:max-w-none sm:p-0"
			>
				<DialogHeader className="px-5 pb-3 pt-4 text-left">
					<DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
					<DialogDescription className="text-xs leading-relaxed">
						{description}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter className="border-t border-border/60 px-5 py-3 sm:gap-2">
					<Button
						variant="ghost"
						size="sm"
						className="h-8 px-3 text-xs"
						disabled={busy}
						onClick={() => onOpenChange(false)}
					>
						取消
					</Button>
					<Button
						variant={destructive ? "destructive" : "default"}
						size="sm"
						className="h-8 px-3 text-xs"
						disabled={busy}
						onClick={onConfirm}
					>
						{busy ? busyLabel : confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContentWithoutClose>
		</Dialog>
	);
}

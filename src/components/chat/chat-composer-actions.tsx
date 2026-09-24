import { ArrowUp, Square } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME } from "@/components/chat/chat-composer-frame";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";

type ComposerActionsProps = {
	value: string;
	hasAttachments: boolean;
	disabled: boolean;
	running: boolean;
	sendMessageShortcut: "enter" | "mod-enter";
	showShortcutHint?: boolean;
	onStop?: () => void;
	canSteer: boolean;
	submitBlocked?: boolean;
	onPrimary: () => void;
};

export function ComposerActions({
	value,
	hasAttachments,
	disabled,
	running,
	sendMessageShortcut,
	showShortcutHint = true,
	onStop,
	canSteer,
	submitBlocked = false,
	onPrimary,
}: ComposerActionsProps) {
	const { t } = useTranslation();
	const hasValue = Boolean(value.trim()) || hasAttachments;
	const shortcutHint = showShortcutHint
		? ` · ${sendMessageShortcut === "enter" ? "Enter" : "Ctrl/⌘ Enter"}`
		: "";
	return (
		<div className="ml-auto flex shrink-0 items-center gap-1.5">
			{running ? (
				hasValue ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								size="icon"
								className={CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME}
								aria-label={t("chat.adjust")}
								disabled={!canSteer || submitBlocked}
								onClick={onPrimary}
							>
								<ArrowUp className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("chat.adjust") + shortcutHint}</TooltipContent>
					</Tooltip>
				) : (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-7 rounded-full bg-foreground text-background transition-[background-color,scale] duration-100 enabled:hover:bg-foreground/85 active:scale-[0.96]"
								aria-label={t("chat.stop")}
								onClick={onStop}
							>
								<Square className="size-3 fill-current" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("chat.stop")}</TooltipContent>
					</Tooltip>
				)
			) : (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							size="icon"
							className={CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME}
							aria-label={t("chat.send")}
							disabled={!hasValue || disabled || submitBlocked}
							onClick={onPrimary}
						>
							<ArrowUp className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{t("chat.send") + shortcutHint}</TooltipContent>
				</Tooltip>
			)}
		</div>
	);
}

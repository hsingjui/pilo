import {
	ArrowUp,
	ChevronDown,
	CornerDownRight,
	ListPlus,
	Square,
	Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
	CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME,
	CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME,
} from "@/components/chat/chat-composer-frame";
import type { ComposerSendMode } from "@/lib/chat/composer-send-mode";
import { cn } from "@/lib/utils";
import { menuItemIconClassName } from "@/ui/menu-styles";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
	DropdownMenuTrigger,
} from "@/ui";

const SEND_MODE_OPTIONS = [
	{
		mode: "steer",
		icon: CornerDownRight,
		label: "chat.sendModeSteer",
		detail: "chat.sendModeSteerDetail",
	},
	{
		mode: "follow_up",
		icon: ListPlus,
		label: "chat.sendModeFollowUp",
		detail: "chat.sendModeFollowUpDetail",
	},
	{
		mode: "send_now",
		icon: Zap,
		label: "chat.sendModeNow",
		detail: "chat.sendModeNowDetail",
	},
] as const;

type ComposerActionsProps = {
	/** 与发送方式同组、一起贴右的附加操作，例如草稿优化。 */
	leadingActions?: ReactNode;
	value: string;
	hasAttachments: boolean;
	disabled: boolean;
	running: boolean;
	sendMessageShortcut: "enter" | "mod-enter";
	showShortcutHint?: boolean;
	onStop?: () => void;
	canSteer: boolean;
	canFollowUp: boolean;
	canSendNow: boolean;
	canSubmit: boolean;
	sendMode: ComposerSendMode;
	onSendModeChange: (mode: ComposerSendMode) => void;
	submitBlocked?: boolean;
	onPrimary: () => void;
};

export function ComposerActions({
	leadingActions,
	value,
	hasAttachments,
	disabled,
	running,
	sendMessageShortcut,
	showShortcutHint = true,
	onStop,
	canSteer,
	canFollowUp,
	canSendNow,
	canSubmit,
	sendMode,
	onSendModeChange,
	submitBlocked = false,
	onPrimary,
}: ComposerActionsProps) {
	const { t } = useTranslation();
	const hasValue = Boolean(value.trim()) || hasAttachments;
	const showStop = running && !hasValue;
	const shortcutHint = showShortcutHint
		? ` · ${sendMessageShortcut === "enter" ? "Enter" : "Ctrl/⌘ Enter"}`
		: "";
	const selectedOption =
		SEND_MODE_OPTIONS.find((option) => option.mode === sendMode) ??
		SEND_MODE_OPTIONS[0];
	const SendModeIcon = selectedOption.icon;
	const sendModeLabel = t("chat.sendModeCurrent", {
		mode: t(selectedOption.label),
	});
	const actionLabel = showStop
		? t("chat.stop")
		: running
			? t(selectedOption.label)
			: t("chat.send");
	return (
		<div
			data-chat-composer-actions=""
			className="ms-auto flex shrink-0 items-center gap-1.5 @max-[40rem]/toolbar:gap-0.5"
		>
			{leadingActions}
			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								disabled={disabled || submitBlocked}
								className={cn(
									CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME,
									"gap-1 px-1.5 motion-reduce:active:scale-100 pointer-coarse:h-11 pointer-coarse:min-w-11",
								)}
								aria-label={sendModeLabel}
							>
								<SendModeIcon className="size-3.5" aria-hidden="true" />
								<ChevronDown className="size-3" aria-hidden="true" />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>{sendModeLabel}</TooltipContent>
				</Tooltip>
				<DropdownMenuContent
					side="top"
					align="end"
					sideOffset={8}
					collisionPadding={16}
					className="max-w-[calc(100vw-2rem)]"
				>
					<DropdownMenuLabel>{t("chat.sendMode")}</DropdownMenuLabel>
					<DropdownMenuRadioGroup
						value={sendMode}
						onValueChange={(mode) => {
							if (
								mode === "steer" ||
								mode === "follow_up" ||
								mode === "send_now"
							)
								onSendModeChange(mode);
						}}
					>
						{SEND_MODE_OPTIONS.map((option) => (
							<DropdownMenuRadioItem
								key={option.mode}
								value={option.mode}
								disabled={
									running &&
									(option.mode === "steer"
										? !canSteer
										: option.mode === "follow_up"
											? !canFollowUp
											: !canSendNow)
								}
								textValue={t(option.label)}
								className="py-1 pointer-coarse:min-h-11"
							>
								<span className={menuItemIconClassName}>
									<option.icon aria-hidden="true" />
								</span>
								<span className="flex min-w-0 flex-1 flex-col">
									<span className="font-medium">{t(option.label)}</span>
									<span className="text-xs leading-tight text-muted-foreground">
										{t(option.detail)}
									</span>
								</span>
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<div className="flex shrink-0 items-center justify-center pointer-coarse:size-11">
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							size="icon"
							data-chat-composer-send=""
							className={cn(
								CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME,
								"motion-reduce:active:scale-100 pointer-coarse:relative pointer-coarse:size-8",
								"pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5 pointer-coarse:after:content-['']",
							)}
							aria-label={actionLabel}
							disabled={
								showStop
									? disabled
									: !hasValue || disabled || !canSubmit || submitBlocked
							}
							onClick={showStop ? onStop : onPrimary}
						>
							{showStop ? (
								<Square className="size-3 fill-current" aria-hidden="true" />
							) : (
								<ArrowUp className="size-4" aria-hidden="true" />
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						{actionLabel + (showStop ? "" : shortcutHint)}
					</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
}

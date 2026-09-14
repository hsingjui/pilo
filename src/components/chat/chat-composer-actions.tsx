import { ArrowUp, ListPlus, Square } from "lucide-react";

import { CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME } from "@/components/chat/chat-composer-frame";
import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";

type ComposerActionsProps = {
	value: string;
	hasAttachments: boolean;
	disabled: boolean;
	running: boolean;
	sendMessageShortcut: "enter" | "mod-enter";
	onStop?: () => void;
	canSteer: boolean;
	canFollowUp: boolean;
	onPrimary: () => void;
	onFollowUp: () => void;
};

export function ComposerActions({
	value,
	hasAttachments,
	disabled,
	running,
	sendMessageShortcut,
	onStop,
	canSteer,
	canFollowUp,
	onPrimary,
	onFollowUp,
}: ComposerActionsProps) {
	const hasValue = Boolean(value.trim()) || hasAttachments;
	return (
		<div className="ml-auto flex shrink-0 items-center gap-1.5">
			{running ? (
				<>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-7 rounded-full bg-foreground text-background shadow-xs transition-all hover:bg-foreground/90 hover:text-background active:translate-y-px"
								aria-label="停止"
								onClick={onStop}
							>
								<Square className="size-2.5 fill-current" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>停止</TooltipContent>
					</Tooltip>
					{hasValue ? (
						<>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="outline"
										size="icon"
										className="size-7 rounded-md active:scale-[0.96]"
										aria-label="回复结束后发送"
										disabled={!canFollowUp}
										onClick={onFollowUp}
									>
										<ListPlus className="size-3.5" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									回复完成后发送 ·{" "}
									{sendMessageShortcut === "enter"
										? "Alt Enter"
										: "Ctrl/⌘ Alt Enter"}
								</TooltipContent>
							</Tooltip>
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon"
										className={CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME}
										aria-label="调整当前回复"
										disabled={!canSteer}
										onClick={onPrimary}
									>
										<ArrowUp className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									调整当前回复 ·{" "}
									{sendMessageShortcut === "enter" ? "Enter" : "Ctrl/⌘ Enter"}
								</TooltipContent>
							</Tooltip>
						</>
					) : null}
				</>
			) : (
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							size="icon"
							className={CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME}
							aria-label="发送"
							disabled={!hasValue || disabled}
							onClick={onPrimary}
						>
							<ArrowUp className="size-4" />
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						发送 · {sendMessageShortcut === "enter" ? "Enter" : "Ctrl/⌘ Enter"}
					</TooltipContent>
				</Tooltip>
			)}
		</div>
	);
}

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Copy } from "lucide-react";

import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@/ui";

const COPY_RESET_DELAY_MS = 1_600;

export function ChatCopyButton({ text }: { text: string }) {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<number | undefined>(undefined);

	useEffect(() => () => window.clearTimeout(resetTimer.current), []);

	function handleCopy() {
		void navigator.clipboard
			.writeText(text)
			.then(() => {
				window.clearTimeout(resetTimer.current);
				setCopied(true);
				resetTimer.current = window.setTimeout(() => {
					setCopied(false);
				}, COPY_RESET_DELAY_MS);
			})
			.catch(() => {});
	}

	const label = copied ? t("chat.copied") : t("chat.copy");

	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-7 rounded-md text-muted-foreground opacity-0 transition-opacity duration-100 group-hover:opacity-100 focus-visible:opacity-100"
					aria-label={label}
					onClick={handleCopy}
				>
					{copied ? (
						<Check className="size-3.5 chat-copy-success-icon" />
					) : (
						<Copy className="size-3.5" />
					)}
				</Button>
			</TooltipTrigger>
			<TooltipContent>{label}</TooltipContent>
		</Tooltip>
	);
}

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const CHAT_COMPOSER_TEXTAREA_CLASS_NAME = cn(
	"input-scrollbar resize-none border-transparent bg-transparent text-sm leading-6 shadow-none",
	"focus-visible:ring-0 focus-visible:ring-offset-0",
	"text-input-foreground placeholder:text-input-placeholder",
	"min-h-12 px-1 py-0",
);

export const CHAT_COMPOSER_TOOLBAR_CLASS_NAME =
	"flex select-none items-center gap-2 pt-0.5";

export const CHAT_COMPOSER_ATTACHMENT_BUTTON_CLASS_NAME =
	"size-7 rounded-md text-muted-foreground";

export const CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME = cn(
	"inline-flex h-7 min-w-0 select-none items-center gap-1.5 rounded-[4px] px-2 text-xs leading-tight",
	"text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
	"data-[state=open]:bg-muted data-[state=open]:text-foreground disabled:cursor-default disabled:opacity-70",
);

export const CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME = cn(
	"size-7 rounded-full bg-foreground text-background disabled:bg-muted-foreground",
	"transition-[background-color,scale] duration-100 enabled:hover:bg-foreground/85 active:scale-[0.96]",
);

export const DEFAULT_CHAT_COMPOSER_PLACEHOLDER =
	"按 @ 提及文件，/ 使用 Pi 命令";

export function ChatComposerRoot({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return <div className={cn("relative w-full", className)}>{children}</div>;
}

export function ChatComposerSurface({ children }: { children: ReactNode }) {
	return (
		<div
			className={cn(
				"group relative flex w-full flex-col border bg-background transition-colors duration-150",
				"border-foreground/[0.10] focus-within:border-ring/40",
				"dark:border-input-border/70",
				"gap-1 rounded-xl px-2 py-1.5 dark:bg-input/90",
			)}
		>
			{children}
		</div>
	);
}

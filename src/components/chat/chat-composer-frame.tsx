import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export const CHAT_COMPOSER_TEXTAREA_CLASS_NAME = cn(
	"input-scrollbar resize-none border-transparent bg-transparent text-sm leading-6 shadow-none",
	"focus-visible:ring-0 focus-visible:ring-offset-0",
	"text-input-foreground placeholder:text-input-placeholder",
	"min-h-12 px-1 py-0",
	"disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100",
);

export const CHAT_COMPOSER_TOOLBAR_CLASS_NAME =
	"flex select-none items-center gap-2 pt-0.5";

export const CHAT_COMPOSER_ATTACHMENT_BUTTON_CLASS_NAME =
	"size-7 rounded-md text-muted-foreground";

export const CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME = cn(
	"inline-flex h-7 min-w-0 select-none items-center gap-1.5 rounded-md px-2 text-xs leading-tight",
	"text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
	"data-[state=open]:bg-muted data-[state=open]:text-foreground disabled:cursor-default disabled:opacity-70",
);

export const CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME = cn(
	"size-7 rounded-full bg-foreground text-background disabled:bg-muted-foreground",
	"transition-[background-color,scale] duration-100 enabled:hover:bg-foreground/85 active:scale-[0.96]",
);

export const DEFAULT_CHAT_COMPOSER_PLACEHOLDER = "给 Pi 发消息，@ 提及文件";

export function ChatComposerRoot({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return <div className={cn("relative w-full", className)}>{children}</div>;
}

export function ChatComposerSurface({
	children,
	muted = false,
}: {
	children: ReactNode;
	muted?: boolean;
}) {
	return (
		<div
			className={cn(
				"group relative flex w-full flex-col border transition-colors duration-150",
				"gap-1 rounded-xl px-2 py-1.5",
				muted
					? "border-border/60 bg-muted text-muted-foreground dark:border-border/50 dark:bg-muted"
					: "border-foreground/[0.10] bg-background focus-within:border-ring/40 dark:border-input-border/70 dark:bg-input/90",
			)}
		>
			{children}
		</div>
	);
}

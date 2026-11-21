import type { ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";

// Keep native font leading so WebKit does not stretch the caret after a newline.
export const CHAT_COMPOSER_TEXTAREA_CLASS_NAME = cn(
	"input-scrollbar resize-none border-0 bg-transparent text-[length:var(--pilo-reading-font-size)] leading-[normal] shadow-none",
	"focus-visible:ring-0 focus-visible:ring-offset-0",
	"text-input-foreground placeholder:text-input-placeholder",
	"min-h-(--pilo-ui-composer-input-height) px-1 py-[max(0px,calc((var(--pilo-composer-line-height)_-_1lh)/2))]",
	"disabled:bg-transparent disabled:text-muted-foreground disabled:opacity-100",
);

// 工具栏作为具名容器：子项按工具栏实际宽度做渐进显示，不依赖视口。
export const CHAT_COMPOSER_TOOLBAR_CLASS_NAME =
	"@container/toolbar -ms-1 flex select-none items-center gap-(--pilo-ui-composer-toolbar-gap) pt-0.5";

export const CHAT_COMPOSER_ATTACHMENT_BUTTON_CLASS_NAME =
	"h-(--pilo-ui-composer-control-size) w-(--pilo-ui-composer-attachment-width) rounded-md text-muted-foreground";

export const CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME = cn(
	"inline-flex h-(--pilo-ui-composer-control-size) min-w-0 select-none items-center gap-1.5 rounded-md p-(--pilo-ui-composer-run-config-padding) text-xs leading-tight",
	"text-muted-foreground transition-colors hover:bg-hover hover:text-hover-foreground motion-reduce:transition-none",
	"focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
	"data-[state=open]:bg-hover data-[state=open]:text-hover-foreground disabled:cursor-default disabled:opacity-70",
);

export const CHAT_COMPOSER_SEND_BUTTON_CLASS_NAME = cn(
	"size-(--pilo-ui-composer-control-size) rounded-full bg-foreground text-background shadow-none disabled:bg-muted-foreground",
	"transition-[background-color,scale] duration-100 enabled:hover:bg-foreground/85 active:scale-[0.96]",
);

export function ChatComposerRoot({
	children,
	className,
	elementRef,
}: {
	children: ReactNode;
	className?: string;
	elementRef?: Ref<HTMLDivElement>;
}) {
	return (
		<div
			ref={elementRef}
			data-session-mention-target=""
			className={cn(
				"relative w-full rounded-composer data-[session-drop-state=allowed]:ring-2 data-[session-drop-state=allowed]:ring-ring data-[session-drop-state=denied]:ring-2 data-[session-drop-state=denied]:ring-destructive",
				className,
			)}
		>
			{children}
		</div>
	);
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
				"group relative flex w-full flex-col border shadow-composer transition-colors duration-[var(--dur-1)] ease-[var(--ease)] motion-reduce:transition-none",
				"pilo-composer-layout rounded-composer",
				muted
					? "border-border/60 bg-muted text-muted-foreground dark:border-border/50 dark:bg-muted"
					: "pilo-composer-surface",
			)}
		>
			{children}
		</div>
	);
}

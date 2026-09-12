import { lazy, memo, Suspense } from "react";

import { cn } from "@/lib/utils";

const ChatMarkdownRuntime = lazy(() =>
	import("./chat-markdown-runtime").then((module) => ({
		default: module.ChatMarkdown,
	})),
);

export const ChatMarkdown = memo(function ChatMarkdown({
	text,
	isStreaming = false,
	className,
}: {
	text: string;
	isStreaming?: boolean;
	className?: string;
}) {
	return (
		<Suspense
			fallback={
				<div className={cn("whitespace-pre-wrap text-foreground", className)}>
					{text}
				</div>
			}
		>
			<ChatMarkdownRuntime
				text={text}
				isStreaming={isStreaming}
				className={className}
			/>
		</Suspense>
	);
});

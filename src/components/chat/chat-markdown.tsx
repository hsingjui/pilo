import { memo } from "react";

export type ChatMarkdownProps = {
	text: string;
	isStreaming?: boolean;
	className?: string;
};

type ChatMarkdownRuntimeComponent =
	(typeof import("./chat-markdown-runtime"))["ChatMarkdown"];

let chatMarkdownRuntime: ChatMarkdownRuntimeComponent | null = null;
let chatMarkdownRuntimePromise: Promise<ChatMarkdownRuntimeComponent> | null =
	null;

export const ChatMarkdown = memo(function ChatMarkdown(
	props: ChatMarkdownProps,
) {
	const Runtime = chatMarkdownRuntime;
	if (!Runtime) {
		// The ChatPage-level Suspense boundary already owns loading UI. Suspending
		// here keeps the Markdown runtime code-split without ever exposing raw
		// Markdown as an intermediate frame. Empty chats must not load this runtime.
		chatMarkdownRuntimePromise ??= import("./chat-markdown-runtime").then(
			(module) => {
				chatMarkdownRuntime = module.ChatMarkdown;
				return module.ChatMarkdown;
			},
		);
		throw chatMarkdownRuntimePromise;
	}
	return <Runtime {...props} />;
});

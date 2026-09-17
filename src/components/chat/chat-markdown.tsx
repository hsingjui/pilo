import { memo } from "react";

export type ChatMarkdownProps = {
	text: string;
	isStreaming?: boolean;
	className?: string;
};

type ChatMarkdownRuntimeComponent =
	(typeof import("./chat-markdown-runtime"))["ChatMarkdown"];

let chatMarkdownRuntime: ChatMarkdownRuntimeComponent | null = null;
const chatMarkdownRuntimePromise = import("./chat-markdown-runtime").then(
	(module) => {
		chatMarkdownRuntime = module.ChatMarkdown;
		return module.ChatMarkdown;
	},
);

export const ChatMarkdown = memo(function ChatMarkdown(
	props: ChatMarkdownProps,
) {
	const Runtime = chatMarkdownRuntime;
	if (!Runtime) {
		// The ChatPage-level Suspense boundary already owns loading UI. Suspending
		// here keeps the Markdown runtime code-split without ever exposing raw
		// Markdown as an intermediate frame. The import starts as soon as the
		// ChatPage chunk evaluates, so empty/new chats prewarm it in the background.
		throw chatMarkdownRuntimePromise;
	}
	return <Runtime {...props} />;
});

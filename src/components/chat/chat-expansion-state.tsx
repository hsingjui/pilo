import {
	createContext,
	useCallback,
	useContext,
	useState,
	type ReactNode,
	type SetStateAction,
} from "react";

import type { AssistantContentItem } from "@/lib/chat/chat-activity-state";

type ChatExpansionStore = Map<string, boolean>;

const ChatExpansionStateContext = createContext<ChatExpansionStore | null>(
	null,
);

export function ChatExpansionStateProvider({
	children,
}: {
	children: ReactNode;
}) {
	const [store] = useState<ChatExpansionStore>(() => new Map());
	return (
		<ChatExpansionStateContext.Provider value={store}>
			{children}
		</ChatExpansionStateContext.Provider>
	);
}

export function chatToolExpansionKey(messageId: string, toolCallId: string) {
	return `tool:${messageId}:${toolCallId}`;
}

export function useFindExpandedToolIndex(messageId: string) {
	const store = useContext(ChatExpansionStateContext);
	return useCallback(
		(content: readonly AssistantContentItem[]) =>
			content.findIndex(
				(item) =>
					item.type === "tool" &&
					store?.get(chatToolExpansionKey(messageId, item.id)) === true,
			),
		[messageId, store],
	);
}

export function useChatExpansionState(
	key: string,
	initialOpen: boolean | (() => boolean),
) {
	const store = useContext(ChatExpansionStateContext);
	const [open, setOpenState] = useState(
		() =>
			store?.get(key) ??
			(typeof initialOpen === "function" ? initialOpen() : initialOpen),
	);
	const setOpen = useCallback(
		(next: SetStateAction<boolean>) => {
			setOpenState((current) => {
				const resolved = typeof next === "function" ? next(current) : next;
				store?.set(key, resolved);
				return resolved;
			});
		},
		[key, store],
	);
	return [open, setOpen] as const;
}

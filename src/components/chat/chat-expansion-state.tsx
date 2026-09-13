import {
	createContext,
	useCallback,
	useContext,
	useState,
	type ReactNode,
	type SetStateAction,
} from "react";

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

export function useChatExpansionState(key: string, initialOpen: boolean) {
	const store = useContext(ChatExpansionStateContext);
	const [open, setOpenState] = useState(() => store?.get(key) ?? initialOpen);
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

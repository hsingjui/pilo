import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
} from "react";

import {
	trimOpenedChats,
	type OpenChat,
} from "@/components/app/app-chat-state";
import { useRestoreActiveChatRuntimes } from "@/components/app/use-restore-active-chat-runtimes";
import { stopChatSession } from "@/lib/chat-session-client";
import type { Project } from "@/lib/projects";

type UseOpenedChatControllersOptions = {
	projects: Project[];
	projectsReady: boolean;
	openedChats: OpenChat[];
	setOpenedChats: Dispatch<SetStateAction<OpenChat[]>>;
};

export type BusyChatControllersRef = MutableRefObject<Set<string>>;

export function useOpenedChatControllers({
	projects,
	projectsReady,
	openedChats,
	setOpenedChats,
}: UseOpenedChatControllersOptions) {
	const previousOpenedChatsRef = useRef(new Map<string, OpenChat>());
	const busyChatControllersRef = useRef(new Set<string>());
	const [busyChatControllerIds, setBusyChatControllerIds] = useState<
		ReadonlySet<string>
	>(() => new Set());

	const handleChatRuntimeBusyChange = useCallback(
		(controllerId: string, busy: boolean) => {
			const busyControllers = busyChatControllersRef.current;
			const changed = busy
				? !busyControllers.has(controllerId)
				: busyControllers.has(controllerId);
			if (busy) busyControllers.add(controllerId);
			else busyControllers.delete(controllerId);
			if (changed) setBusyChatControllerIds(new Set(busyControllers));
			if (!busy) {
				setOpenedChats((current) => trimOpenedChats(current, busyControllers));
			}
		},
		[setOpenedChats],
	);

	useEffect(() => {
		const next = new Map(
			openedChats.map((entry) => [entry.controllerId, entry] as const),
		);
		let busyChanged = false;
		for (const [controllerId, entry] of previousOpenedChatsRef.current) {
			if (next.has(controllerId)) continue;
			busyChanged =
				busyChatControllersRef.current.delete(controllerId) || busyChanged;
			void stopChatSession(
				entry.session.projectRecord.id,
				entry.session.id,
			).catch((error) =>
				console.warn("Failed to stop evicted chat session", error),
			);
		}
		if (busyChanged) {
			setBusyChatControllerIds(new Set(busyChatControllersRef.current));
		}
		previousOpenedChatsRef.current = next;
	}, [openedChats]);

	useRestoreActiveChatRuntimes({
		projects,
		projectsReady,
		setOpenedChats,
	});

	return {
		busyChatControllersRef,
		busyChatControllerIds,
		handleChatRuntimeBusyChange,
	};
}

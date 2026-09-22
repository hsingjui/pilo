import { useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { i18n } from "../../i18n/index.ts";
import {
	upsertOpenedChat,
	type OpenChat,
} from "@/components/app/app-chat-state";
import type { ChatSession } from "@/components/chat/chat-page";
import { listChatSessionRuntimeStates } from "@/lib/chat-session-client";
import { listSessions } from "@/lib/sessions";
import type { Project } from "@/lib/projects";

type UseRestoreActiveChatRuntimesOptions = {
	projects: readonly Project[];
	projectsReady: boolean;
	setOpenedChats: Dispatch<SetStateAction<OpenChat[]>>;
};

export function useRestoreActiveChatRuntimes({
	projects,
	projectsReady,
	setOpenedChats,
}: UseRestoreActiveChatRuntimesOptions) {
	const restoredSessionKeysRef = useRef(new Set<string>());

	useEffect(() => {
		if (!projectsReady || projects.length === 0) return;
		let disposed = false;

		void listChatSessionRuntimeStates()
			.then(async (states) => {
				const active = states.filter(
					(state) => state.activeTurn && state.snapshot.state === "running",
				);
				if (active.length === 0) return;

				const projectIds = [...new Set(active.map((state) => state.projectId))];
				const indexedByProject = new Map<
					string,
					Awaited<ReturnType<typeof listSessions>>
				>();
				await Promise.all(
					projectIds.map(async (projectId) => {
						try {
							indexedByProject.set(projectId, await listSessions(projectId));
						} catch {
							indexedByProject.set(projectId, []);
						}
					}),
				);
				if (disposed) return;

				const restored = active.flatMap((state) => {
					if (restoredSessionKeysRef.current.has(state.sessionKey)) return [];

					let parsed: unknown;
					try {
						parsed = JSON.parse(state.sessionKey);
					} catch {
						return [];
					}
					if (
						!Array.isArray(parsed) ||
						parsed.length !== 2 ||
						typeof parsed[0] !== "string" ||
						parsed[0] !== state.projectId ||
						typeof parsed[1] !== "string"
					) {
						return [];
					}

					const project = projects.find(
						(candidate) => candidate.id === state.projectId,
					);
					if (!project) return [];

					const indexed = state.sessionPath
						? indexedByProject
								.get(state.projectId)
								?.find((session) => session.sessionPath === state.sessionPath)
						: undefined;
					const session: ChatSession = {
						id: parsed[1],
						title:
							indexed?.titleOverride ??
							indexed?.name ??
							indexed?.firstUserMessagePreview ??
							i18n.t("app.chat"),
						projectRecord: project,
						sessionPath: state.sessionPath ?? undefined,
					};
					return [{ sessionKey: state.sessionKey, session }];
				});
				if (restored.length === 0) return;

				setOpenedChats((current) => {
					let next = current;
					for (const entry of restored) {
						next = upsertOpenedChat(next, entry.session);
					}
					// These entries represent live Pi turns and their ChatPage controllers
					// have not mounted yet, so do not trim them against frontend busy state.
					return next;
				});
				for (const entry of restored) {
					restoredSessionKeysRef.current.add(entry.sessionKey);
				}
			})
			.catch((error) =>
				console.warn("Failed to restore active chat runtimes", error),
			);

		return () => {
			disposed = true;
		};
	}, [projects, projectsReady, setOpenedChats]);
}

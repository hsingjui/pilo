import { effect, Notifications, signal, untracked } from "nsh";

import type { PiloClientEvent } from "@/lib/api/pilo-client";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import type { AppStore } from "../state/app-store";
import type { DesktopShell } from "./desktop-shell";
import { t } from "./i18n";

const SESSION_PREFIX = "pilo-session:";

function decodeTarget(id: string) {
	if (!id.startsWith(SESSION_PREFIX)) return null;
	try {
		const target: unknown = JSON.parse(id.slice(SESSION_PREFIX.length));
		if (!Array.isArray(target) || target.length !== 2) return null;
		const [projectId, sessionPath]: unknown[] = target;
		return typeof projectId === "string" &&
			projectId &&
			typeof sessionPath === "string" &&
			sessionPath
			? { projectId, sessionPath }
			: null;
	} catch {
		return null;
	}
}

export function connectSessionNotifications(
	client: Pick<NshPiloClient, "chatState">,
	store: AppStore,
	desktop: Pick<DesktopShell, "show" | "isQuitting">,
) {
	const requested = signal<ReturnType<typeof decodeTarget>>(null);
	let loading: ReturnType<typeof decodeTarget> = null;
	Notifications.on("press", ({ id }) => {
		const target = decodeTarget(id);
		if (!target || desktop.isQuitting()) return;
		desktop.show();
		requested.set(target);
	});
	effect(() => {
		const target = requested();
		if (!target || desktop.isQuitting()) return;
		const state = store.state();
		if (state.status.type !== "ready") return;
		const { projectId, sessionPath } = target;
		if (!state.projects.some((project) => project.id === projectId)) {
			requested.set(null);
			return;
		}
		if (loading !== target) {
			loading = target;
			untracked(() => void store.loadSessions(projectId));
			return;
		}
		// Another index refresh can supersede our load. Wait for its result too.
		const index = state.sessionIndexes[projectId];
		if (index?.status === "loading") return;
		requested.set(null);
		if (
			index?.status === "loaded" &&
			index.sessions.some((session) => session.sessionPath === sessionPath)
		) {
			untracked(() => store.selectSession(projectId, sessionPath));
		}
	});

	return async (event: PiloClientEvent) => {
		if (
			event.type !== "assistant_message_end" ||
			event.stopReason === "aborted"
		)
			return;
		const { projectId, sessionKey } = event;
		if (
			!projectId ||
			!sessionKey ||
			!store.state().preferences?.values.desktopNotifications
		)
			return;
		const held = store
			.state()
			.chatSessions.find(
				(chat) =>
					chat.sessionKey === sessionKey && chat.projectId === projectId,
			);
		const chat = held?.sessionPath ? held : await client.chatState(sessionKey);
		const sessionPath = chat?.sessionPath;
		if (
			chat?.projectId !== projectId ||
			!sessionPath ||
			desktop.isQuitting() ||
			!store.state().preferences?.values.desktopNotifications
		)
			return;
		const session = store
			.state()
			.sessionIndexes[projectId]?.sessions.find(
				(entry) => entry.sessionPath === sessionPath,
			);
		const failed =
			event.stopReason === "error" || Boolean(event.errorMessage?.trim());
		const label = t(failed ? "notifications.error" : "notifications.completed");
		const name = (session?.titleOverride ?? session?.name)?.trim();
		await Notifications.show({
			id: SESSION_PREFIX + JSON.stringify([projectId, sessionPath]),
			title: name
				? `${Array.from(name).slice(0, 100).join("")} · ${label}`
				: t(
						failed
							? "notifications.agentFailed"
							: "notifications.agentCompleted",
					),
			body: t(
				failed ? "notifications.errorBody" : "notifications.completedBody",
			),
		});
	};
}

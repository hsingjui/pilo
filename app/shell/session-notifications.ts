import { effect, lifecycle, signal, untracked } from "nsh";

import type { PiloClientEvent } from "@shared/api/pilo-client";
import { runtimeSessionPathKey } from "@shared/chat/chat-session-runtime-model";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import type { AppStore } from "../state/app-store";
import {
	defaultDesktopNotifications,
	type DesktopNotificationsApi,
} from "./desktop-notifications";
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
	notifications: DesktopNotificationsApi = defaultDesktopNotifications(),
	options?: {
		/** 当用户前台正停留在目标会话聊天视图时返回 true，以静默抑制打扰通知。 */
		isViewingSession?: (projectId: string, sessionPath: string) => boolean;
		onSelectTarget?: (projectId: string) => void;
	},
) {
	const requested = signal<ReturnType<typeof decodeTarget>>(null);
	let loading: ReturnType<typeof decodeTarget> = null;
	notifications.onPress(({ id }) => {
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
		const pathKey = runtimeSessionPathKey(sessionPath);
		const index = state.sessionIndexes[projectId];
		// 命中已有索引直接秒跳，无需等待全量重扫。
		if (index?.status === "loaded") {
			const cached = index.sessions.find(
				(entry) => runtimeSessionPathKey(entry.sessionPath) === pathKey,
			);
			if (cached) {
				requested.set(null);
				loading = null;
				untracked(() => {
					options?.onSelectTarget?.(projectId);
					store.selectSession(projectId, cached.sessionPath);
				});
				return;
			}
		}
		if (loading !== target) {
			loading = target;
			untracked(() => void store.loadSessions(projectId));
			return;
		}
		// Another index refresh can supersede our load. Wait for its result too.
		if (index?.status === "loading") return;
		requested.set(null);
		if (index?.status !== "loaded") return;
		const session = index.sessions.find(
			(entry) => runtimeSessionPathKey(entry.sessionPath) === pathKey,
		);
		if (session) {
			untracked(() => {
				options?.onSelectTarget?.(projectId);
				store.selectSession(projectId, session.sessionPath);
			});
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
		const pathKey = runtimeSessionPathKey(sessionPath);
		// 前台且正停留在目标会话聊天视图时不弹出打扰用户的系统通知。
		const activeWindow = lifecycle() === "active";
		if (activeWindow) {
			const viewing = options?.isViewingSession
				? options.isViewingSession(projectId, sessionPath)
				: (() => {
						const open = store.state().navigation.session;
						return Boolean(
							open &&
							open.projectId === projectId &&
							open.sessionPath &&
							runtimeSessionPathKey(open.sessionPath) === pathKey,
						);
					})();
			if (viewing) return;
		}
		const session = store
			.state()
			.sessionIndexes[projectId]?.sessions.find(
				(entry) => runtimeSessionPathKey(entry.sessionPath) === pathKey,
			);
		const failed =
			event.stopReason === "error" || Boolean(event.errorMessage?.trim());
		const label = t(failed ? "notifications.error" : "notifications.completed");
		const name = (session?.titleOverride ?? session?.name)?.trim();
		await notifications.show({
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
			waitForClick: true,
		});
	};
}

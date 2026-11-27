import { cleanup, computed, effect, signal, untracked } from "nsh";

import type { PiAgentState } from "@shared/api/pi-runtime-types";
import {
	createNextPromptSessionCache,
	type NextPromptSessionOptions,
} from "@shared/chat/next-prompt-session-cache";
import type { NextPromptSettings } from "@shared/next-prompt";
import { promptEnhancementModel } from "@shared/prompt-enhancement";
import type { PromptEnhancementSettings } from "@shared/prompt-enhancement-types";
import { requestPiRpc } from "../client/chat-rpc";
import type { DesktopHostClient } from "../client/host-api";
import type { AppStore } from "../state/app-store";

export type ComposerAssistanceClient = Pick<
	DesktopHostClient,
	| "loadNextPromptSettings"
	| "requestNextPrompt"
	| "loadPromptEnhancementSettings"
	| "enhancePrompt"
	| "sendChatCommand"
	| "connectEvents"
>;

type Options = Omit<NextPromptSessionOptions, "client" | "getSessionState"> & {
	projectId: string | null;
};

/** Desktop binds its live stream and editor signals to the shared session cache. */
export function createComposerAssistance(
	client: ComposerAssistanceClient,
	store: AppStore,
	options: () => Options,
) {
	const cache = createNextPromptSessionCache();
	const connectionId = computed(() => options().connectionId);
	const nextSettings = signal<NextPromptSettings | null>(null);
	const enhancement = signal<PromptEnhancementSettings | null>(null);
	const revision = signal(0);
	const acceptNext = (settings: NextPromptSettings) => {
		if (settings.connectionId !== connectionId()) return;
		nextSettings.update((current) =>
			current?.connectionId === settings.connectionId &&
			current.updatedAtMs >= settings.updatedAtMs
				? current
				: settings,
		);
	};
	const acceptEnhancement = (settings: PromptEnhancementSettings) => {
		if (settings.connectionId !== connectionId()) return;
		enhancement.update((current) =>
			current?.connectionId === settings.connectionId &&
			current.updatedAtMs >= settings.updatedAtMs
				? current
				: settings,
		);
	};

	let settingsRead = 0;
	const refreshSettings = () => {
		const id = connectionId();
		const read = ++settingsRead;
		if (!id) return;
		void client
			.loadNextPromptSettings(id)
			.then((settings) => {
				if (read === settingsRead) acceptNext(settings);
			})
			.catch(() => {});
		void client
			.loadPromptEnhancementSettings(id)
			.then((settings) => {
				if (read === settingsRead) acceptEnhancement(settings);
			})
			.catch(() => {});
	};
	const selection = () => ({
		...options(),
		client,
		getSessionState: (sessionKey: string) =>
			requestPiRpc<PiAgentState>(client, sessionKey, { type: "get_state" }),
	});
	const update = () => {
		const selected = selection();
		const settings = nextSettings();
		cache.update(
			selected,
			settings?.connectionId === selected.connectionId ? settings : null,
			false,
		);
	};
	const result = computed(() => {
		revision();
		return cache.getResult(selection());
	});
	const unsubscribeCache = cache.subscribe(() =>
		revision.set(cache.getSnapshot()),
	);
	const unsubscribeEvents = store.subscribeLiveEvents((event) => {
		if (!event) {
			cache.invalidate("transport_resync");
			refreshSettings();
			return;
		}
		if (event.type === "next_prompt_settings_changed")
			acceptNext(event.settings);
		if (event.type === "prompt_enhancement_settings_changed")
			acceptEnhancement(event.settings);
		if (
			event.type === "assistant_message_end" &&
			event.sessionKey === options().sessionKey
		)
			update();
		cache.handleEvent(event);
	});
	effect(refreshSettings);
	effect(update);
	cleanup(() => {
		settingsRead++;
		unsubscribeEvents();
		unsubscribeCache();
		cache.clear("view_unmounted");
	});
	return {
		result,
		dismiss: () => cache.dismiss(options().sessionKey),
		refreshSettings: () => untracked(refreshSettings),
		canEnhance: () => {
			const settings = enhancement();
			return (
				settings?.enabled === true && settings.connectionId === connectionId()
			);
		},
		enhance: (draft: string) => {
			const { projectId, model } = options();
			return projectId
				? client.enhancePrompt(projectId, draft, promptEnhancementModel(model))
				: Promise.resolve("");
		},
	};
}

export type ComposerAssistance = ReturnType<typeof createComposerAssistance>;

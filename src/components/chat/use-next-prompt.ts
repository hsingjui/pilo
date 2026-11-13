import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import type { ChatDraftStore } from "@/components/chat/chat-draft-store";
import type { PiloClientEventMessage } from "@/lib/api/pilo-client";
import {
	createNextPromptSessionCache,
	type NextPromptSessionOptions,
} from "@/lib/next-prompt-session-cache";
import { useNextPromptSettings } from "@/lib/use-next-prompt-settings";

type Options = Omit<NextPromptSessionOptions, "draft"> & {
	draftStore: ChatDraftStore;
	/** Desktop uses the existing multiplexed event channel; WebUI supplies its socket frames. */
	subscribe?: boolean;
	refreshKey?: string;
};

export function useNextPrompt({ draftStore, ...options }: Options) {
	const config = useNextPromptSettings(
		options.client,
		options.connectionId,
		options.refreshKey,
	);
	const [cache] = useState(createNextPromptSessionCache);
	useSyncExternalStore(cache.subscribe, cache.getSnapshot);
	const latestRef = useRef({ options, config });
	const liveFloorRef = useRef(Number.POSITIVE_INFINITY);
	useLayoutEffect(() => {
		latestRef.current = { options, config };
	}, [options, config]);

	// Selection changes preserve sessions; only real transport changes clear them.
	useLayoutEffect(() => {
		cache.setTransport(options.client, options.refreshKey, options.connected);
	}, [cache, options.client, options.refreshKey, options.connected]);
	useLayoutEffect(() => {
		if (options.connected !== false) {
			cache.update(
				{ ...options, draft: draftStore.getSnapshot() },
				config.settings,
				config.saving,
			);
		}
	}, [cache, draftStore, options, config.settings, config.saving]);
	useLayoutEffect(() => {
		return draftStore.subscribe((previous) => {
			const draft = draftStore.getSnapshot();
			if (Boolean(previous) === Boolean(draft)) return;
			const { options, config } = latestRef.current;
			// Invalidate predictions without making the page a draft subscriber.
			if (options.connected !== false)
				cache.update({ ...options, draft }, config.settings, config.saving);
		});
	}, [cache, draftStore]);
	useEffect(() => () => cache.clear("view_unmounted"), [cache]);

	const dismiss = useCallback(
		(reason = "dismissed") => {
			cache.dismiss(latestRef.current.options.sessionKey, reason);
		},
		[cache],
	);
	const handleMessage = useCallback(
		(message: PiloClientEventMessage) => {
			if (message.type !== "events") {
				liveFloorRef.current = message.latestSequence;
				cache.invalidate("transport_resync");
				void latestRef.current.config.refresh();
				return;
			}
			for (const event of message.events) {
				const live = event.sequence > liveFloorRef.current;
				if (live) liveFloorRef.current = event.sequence;
				latestRef.current.config.handleEvent(event);
				cache.handleEvent(event, live);
			}
		},
		[cache],
	);

	useEffect(() => {
		if (!options.subscribe || !options.client) return;
		let disposed = false;
		let stop: (() => void) | undefined;
		void options.client
			.connectEvents({
				onMessage: (message) => {
					if (message.type !== "events") return;
					for (const event of message.events) {
						latestRef.current.config.handleEvent(event);
						cache.handleEvent(event);
					}
				},
				onStatus: (connected) => {
					if (!connected && !disposed)
						cache.invalidate("transport_disconnected");
				},
			})
			.then((unlisten) => {
				if (disposed) unlisten();
				else stop = unlisten;
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
			stop?.();
		};
	}, [options.client, options.subscribe, cache]);

	const result = cache.getResult({
		...options,
		draft: draftStore.getSnapshot(),
	});
	return {
		config,
		handleMessage,
		dismiss,
		text: result?.text ?? null,
		unavailable: result?.unavailable ?? false,
	};
}

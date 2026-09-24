import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";

import type { ChatUiStatePatch } from "@/components/app/chat-ui-state-cache";

const BACKGROUND_VISUAL_RETENTION_MS = 60_000;

/**
 * Keeps a background chat's painted DOM around so switching back reveals it
 * immediately. A controller that was visible stays frozen for its whole
 * background run; a never-opened session never builds a hidden tree. Also owns
 * the "visual ready" latch that tells the app a controller has painted.
 */
export function useChatVisualRetention({
	active,
	retainBackgroundVisual,
	runtimeBusy,
	uiStateKey,
	writeUiState,
	onVisualReadyChange,
}: {
	active: boolean;
	retainBackgroundVisual: boolean;
	runtimeBusy: boolean;
	uiStateKey?: string;
	writeUiState?: (key: string, patch: ChatUiStatePatch) => void;
	onVisualReadyChange?: (ready: boolean) => void;
}) {
	useEffect(() => {
		if (active || !runtimeBusy || !uiStateKey || !writeUiState) return;
		// A frozen background transcript deliberately stops consuming store
		// updates. The assistant can therefore grow without changing message count,
		// making a previously persisted Virtua height cache stale even though the
		// old count still matches. Drop only the measurement cache when background
		// work starts; draft/scroll ownership remain available for the next reveal.
		writeUiState(uiStateKey, {
			virtualizerCache: undefined,
			virtualizerMessageCount: undefined,
		});
	}, [active, runtimeBusy, uiStateKey, writeUiState]);
	const [backgroundVisualRetained, setBackgroundVisualRetained] =
		useState(active);
	useEffect(() => {
		if (active) {
			if (backgroundVisualRetained) return;
			const frame = requestAnimationFrame(() =>
				setBackgroundVisualRetained(true),
			);
			return () => cancelAnimationFrame(frame);
		}
		if (!retainBackgroundVisual) {
			if (!backgroundVisualRetained) return;
			const frame = requestAnimationFrame(() =>
				setBackgroundVisualRetained(false),
			);
			return () => cancelAnimationFrame(frame);
		}
		// A controller that was visible stays frozen for its whole background run.
		// Do not create a hidden visual tree for a session that was never opened.
		if (runtimeBusy || !backgroundVisualRetained) return;
		const timer = window.setTimeout(
			() => setBackgroundVisualRetained(false),
			BACKGROUND_VISUAL_RETENTION_MS,
		);
		return () => window.clearTimeout(timer);
	}, [active, backgroundVisualRetained, retainBackgroundVisual, runtimeBusy]);
	const renderVisual =
		active || (retainBackgroundVisual && backgroundVisualRetained);
	const visualReadyRef = useRef(false);
	const onVisualReadyChangeRef = useRef(onVisualReadyChange);
	useLayoutEffect(() => {
		onVisualReadyChangeRef.current = onVisualReadyChange;
	}, [onVisualReadyChange]);
	const handleVisualReady = useCallback(() => {
		if (visualReadyRef.current) return;
		visualReadyRef.current = true;
		onVisualReadyChange?.(true);
	}, [onVisualReadyChange]);
	useEffect(
		() => () => {
			if (visualReadyRef.current) onVisualReadyChangeRef.current?.(false);
		},
		[],
	);
	useLayoutEffect(() => {
		if (!visualReadyRef.current) return;
		// A retained, idle visual tree is still a valid warm cache. Invalidate it
		// only when the DOM is actually evicted or when a background run can make
		// the frozen transcript stale.
		if (renderVisual && (active || !runtimeBusy)) return;
		visualReadyRef.current = false;
		onVisualReadyChange?.(false);
	}, [active, onVisualReadyChange, renderVisual, runtimeBusy]);
	return { renderVisual, handleVisualReady };
}

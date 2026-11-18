import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import { pushCoalescedConversationAction } from "@/lib/chat/conversation-replay";
import type { ConversationAction } from "@/lib/chat/conversation-types";
import {
	recordChatPresentationFlush,
	recordChatPresentationInterval,
} from "@/lib/chat/chat-performance";

const INACTIVE_RUNTIME_FLUSH_MS = 150;
// Hidden windows may not get a frame. Count inputs before coalescing so a
// stream that keeps merging into one action still flushes periodically.
const MAX_PENDING_RUNTIME_INPUTS = 128;

function isPresentationBatchedAction(action: ConversationAction) {
	return (
		action.type === "assistant_text_delta" ||
		action.type === "assistant_thinking_delta" ||
		action.type === "tool_execution_update"
	);
}

type ScheduledFlush =
	| { kind: "frame"; id: number }
	| { kind: "timeout"; id: number };

export function useRuntimeConversationDispatch(
	active: boolean,
	dispatchConversationBatch: (
		targetSessionId: string,
		actions: readonly ConversationAction[],
	) => void,
	getActiveFlushIntervalMs: () => number,
) {
	const pendingRuntimeActionsRef = useRef<{
		sessionId: string;
		actions: ConversationAction[];
		inputActions: number;
	} | null>(null);
	const scheduledFlushRef = useRef<ScheduledFlush | null>(null);
	const lastPresentationFlushAtRef = useRef(0);

	const cancelScheduledFlush = useCallback(() => {
		const scheduled = scheduledFlushRef.current;
		if (!scheduled) return;
		if (scheduled.kind === "frame") cancelAnimationFrame(scheduled.id);
		else window.clearTimeout(scheduled.id);
		scheduledFlushRef.current = null;
	}, []);

	const takePendingRuntimeActions = useCallback(() => {
		cancelScheduledFlush();
		const pending = pendingRuntimeActionsRef.current;
		pendingRuntimeActionsRef.current = null;
		return pending;
	}, [cancelScheduledFlush]);

	const discardRuntimeActions = useCallback(() => {
		cancelScheduledFlush();
		pendingRuntimeActionsRef.current = null;
		lastPresentationFlushAtRef.current = 0;
	}, [cancelScheduledFlush]);

	const flushRuntimeActions = useCallback(() => {
		const pending = takePendingRuntimeActions();
		if (!pending || pending.actions.length === 0) return;
		recordChatPresentationFlush({
			active,
			inputActions: pending.inputActions,
			coalescedActions: pending.actions.length,
		});
		dispatchConversationBatch(pending.sessionId, pending.actions);
		lastPresentationFlushAtRef.current = performance.now();
	}, [active, dispatchConversationBatch, takePendingRuntimeActions]);

	const scheduleRuntimeFlush = useCallback(() => {
		if (scheduledFlushRef.current !== null) return;
		if (active) {
			const intervalMs = Math.max(16, getActiveFlushIntervalMs());
			recordChatPresentationInterval(intervalMs);
			const elapsedMs = performance.now() - lastPresentationFlushAtRef.current;
			const delayMs = Math.max(0, intervalMs - elapsedMs);
			if (delayMs <= 8) {
				const id = requestAnimationFrame(() => {
					scheduledFlushRef.current = null;
					flushRuntimeActions();
				});
				scheduledFlushRef.current = { kind: "frame", id };
				return;
			}
			const id = window.setTimeout(() => {
				scheduledFlushRef.current = null;
				flushRuntimeActions();
			}, delayMs);
			scheduledFlushRef.current = { kind: "timeout", id };
			return;
		}
		const id = window.setTimeout(() => {
			scheduledFlushRef.current = null;
			flushRuntimeActions();
		}, INACTIVE_RUNTIME_FLUSH_MS);
		scheduledFlushRef.current = { kind: "timeout", id };
	}, [active, flushRuntimeActions, getActiveFlushIntervalMs]);

	const queueRuntimeAction = useCallback(
		(sessionId: string, action: ConversationAction) => {
			if (
				pendingRuntimeActionsRef.current &&
				pendingRuntimeActionsRef.current.sessionId !== sessionId
			) {
				flushRuntimeActions();
			}
			const pending = (pendingRuntimeActionsRef.current ??= {
				sessionId,
				actions: [],
				inputActions: 0,
			});
			pushCoalescedConversationAction(pending.actions, action);
			pending.inputActions += 1;
			if (pending.inputActions >= MAX_PENDING_RUNTIME_INPUTS) {
				flushRuntimeActions();
				return;
			}
			scheduleRuntimeFlush();
		},
		[flushRuntimeActions, scheduleRuntimeFlush],
	);

	const dispatchConversationActions = useCallback(
		(targetSessionId: string, actions: readonly ConversationAction[]) => {
			const pending = takePendingRuntimeActions();
			if (pending?.actions.length) {
				recordChatPresentationFlush({
					active,
					inputActions: pending.inputActions,
					coalescedActions: pending.actions.length,
				});
				if (pending.sessionId === targetSessionId) {
					dispatchConversationBatch(targetSessionId, [
						...pending.actions,
						...actions,
					]);
				} else {
					dispatchConversationBatch(pending.sessionId, pending.actions);
					dispatchConversationBatch(targetSessionId, actions);
				}
			} else if (actions.length > 0) {
				dispatchConversationBatch(targetSessionId, actions);
			}
			lastPresentationFlushAtRef.current = performance.now();
		},
		[active, dispatchConversationBatch, takePendingRuntimeActions],
	);

	const dispatchConversation = useCallback(
		(targetSessionId: string, action: ConversationAction) => {
			dispatchConversationActions(targetSessionId, [action]);
		},
		[dispatchConversationActions],
	);

	// Switching to a background-running session flushes its coalesced tail before
	// paint. The conversation store is ref-backed, so this produces one React
	// commit with the latest text instead of replaying intermediate token frames.
	useLayoutEffect(() => {
		if (active) flushRuntimeActions();
	}, [active, flushRuntimeActions]);

	useEffect(() => () => discardRuntimeActions(), [discardRuntimeActions]);

	return {
		queueRuntimeAction,
		dispatchConversationActions,
		dispatchConversation,
		flushRuntimeActions,
		discardRuntimeActions,
	};
}

export { isPresentationBatchedAction };

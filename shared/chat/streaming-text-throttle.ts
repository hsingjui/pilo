/**
 * Default commit cadence for streaming Markdown on Web.
 *
 * nsh Web's `TextView` rebuilds the active trailing block's DOM subtree on
 * every document change. Throttling streaming updates from ~60Hz down to
 * ~13Hz eliminates visible text flicker and mobile main-thread churn while
 * keeping typing motion fluid and flushing the final text immediately.
 */
export const WEB_STREAMING_MARKDOWN_INTERVAL_MS = 75;

export interface StreamingTextThrottleOptions {
	intervalMs?: number;
	now?: () => number;
	schedule?: (callback: () => void, delayMs: number) => unknown;
	cancel?: (handle: unknown) => void;
	onCommit: (text: string) => void;
}

export interface StreamingTextThrottle {
	push(text: string, streaming: boolean, key?: string): void;
	dispose(): void;
}

/**
 * Leading + trailing throttle for streaming text updates.
 *
 * - First non-empty chunk, key switches, text shrink/resets, and settled
 *   (`streaming === false`) updates commit synchronously with zero tail lag.
 * - While `streaming === true` and text is growing under the same key, commits
 *   are spaced by at least `intervalMs` and always flush the latest value.
 */
export function createStreamingTextThrottle(
	options: StreamingTextThrottleOptions,
): StreamingTextThrottle {
	const intervalMs = Math.max(
		0,
		options.intervalMs ?? WEB_STREAMING_MARKDOWN_INTERVAL_MS,
	);
	const now = options.now ?? (() => Date.now());
	const schedule =
		options.schedule ??
		((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
	const cancel =
		options.cancel ??
		((handle: unknown) =>
			clearTimeout(handle as ReturnType<typeof setTimeout>));

	let disposed = false;
	let hasCommitted = false;
	let committedText = "";
	let committedKey: string | undefined;
	let lastCommitAt = Number.NEGATIVE_INFINITY;
	let pendingText: string | undefined;
	let timer: unknown;

	const clearTimer = () => {
		if (timer === undefined) return;
		cancel(timer);
		timer = undefined;
	};

	const commitNow = (
		text: string,
		key: string | undefined,
		keyChanged = false,
	) => {
		clearTimer();
		pendingText = undefined;
		const changed = !hasCommitted || text !== committedText;
		hasCommitted = true;
		committedText = text;
		committedKey = key;
		if (changed || keyChanged) {
			lastCommitAt = now();
		}
		if (changed) options.onCommit(text);
	};

	return {
		push(text: string, streaming: boolean, key?: string) {
			if (disposed) return;

			const keyChanged = hasCommitted && key !== committedKey;
			const shouldCommitImmediately =
				!streaming ||
				intervalMs === 0 ||
				!hasCommitted ||
				keyChanged ||
				text.length === 0 ||
				(committedText.length === 0 && text.length > 0) ||
				text.length < committedText.length;

			if (shouldCommitImmediately) {
				commitNow(text, key, keyChanged);
				return;
			}

			if (text === committedText) {
				clearTimer();
				pendingText = undefined;
				return;
			}

			const elapsed = now() - lastCommitAt;
			if (elapsed >= intervalMs) {
				commitNow(text, key);
				return;
			}

			pendingText = text;
			if (timer === undefined) {
				const delay = Math.max(0, intervalMs - elapsed);
				timer = schedule(() => {
					timer = undefined;
					if (disposed || pendingText === undefined) return;
					const next = pendingText;
					pendingText = undefined;
					commitNow(next, committedKey);
				}, delay);
			}
		},

		dispose() {
			disposed = true;
			pendingText = undefined;
			clearTimer();
		},
	};
}

const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const ERROR_PREFIX = "PILO_STREAM_STALLED:";
const TURN_COMPLETED = "pilo.turn-completed.v1";

function clearTimer(current) {
	clearTimeout(current.timer);
	current.timer = undefined;
}

export default function (pi) {
	const configured = Number(process.env.PILO_MODEL_STREAM_IDLE_TIMEOUT_MS);
	const idleTimeoutMs =
		Number.isSafeInteger(configured) &&
		configured > 0 &&
		configured <= 2_147_483_647
			? configured
			: DEFAULT_IDLE_TIMEOUT_MS;
	let running = false;
	let sawAssistant = false;
	let watch;

	function stopWatching() {
		if (!watch) return;
		clearTimer(watch);
		watch.signal?.removeEventListener("abort", watch.onAbort);
		watch = undefined;
	}

	function touch() {
		const current = watch;
		if (!current || current.timedOut || current.signal?.aborted) return;
		clearTimer(current);
		current.timer = setTimeout(() => {
			if (watch !== current || current.signal?.aborted) return;
			current.timedOut = true;
			clearTimer(current);
			current.context.abort();
		}, idleTimeoutMs);
		current.timer.unref?.();
	}

	// Retries and boundary continuations emit agent_start without before_agent_start.
	pi.on("agent_start", () => {
		stopWatching();
		running = true;
	});
	pi.on("before_provider_request", (_event, ctx) => {
		if (!running || ctx.signal?.aborted) return;
		stopWatching();
		const current = {
			context: ctx,
			signal: ctx.signal,
			timedOut: false,
			timer: undefined,
			onAbort: () => clearTimer(current),
		};
		watch = current;
		current.signal?.addEventListener("abort", current.onAbort, { once: true });
		touch();
	});
	pi.on("provider_stream_event", touch);
	// Also support providers which only emit normalized assistant updates.
	pi.on("message_update", touch);
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant") return;
		sawAssistant = true;
		const timedOut = watch?.timedOut;
		stopWatching();
		if (!timedOut || event.message.stopReason !== "aborted") return;
		return {
			message: {
				...event.message,
				stopReason: "error",
				// Avoid retryable provider-error wording: never replay a stalled turn.
				errorMessage: `${ERROR_PREFIX} No model events for ${idleTimeoutMs} ms. Pilo stopped this turn. Send a new message to continue.`,
			},
		};
	});
	pi.on("agent_settled", (_event, ctx) => {
		const hasAssistant = sawAssistant;
		sawAssistant = false;
		if (hasAssistant && ctx.mode === "rpc") {
			// Pi emits entry_appended for this record before forwarding agent_settled.
			pi.appendEntry(TURN_COMPLETED, { completedAtMs: Date.now() });
		}
	});
	pi.on("agent_end", () => {
		running = false;
		stopWatching();
	});
	for (const event of ["session_start", "session_switch", "session_shutdown"]) {
		pi.on(event, () => {
			running = false;
			sawAssistant = false;
			stopWatching();
		});
	}
}

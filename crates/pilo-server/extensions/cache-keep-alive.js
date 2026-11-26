import { convertToLlm } from "@mariozechner/pi-coding-agent";

const WIDGET_KEY = "pilo.cache-keep-alive.v1";
const INTERVAL_RATIO = 0.9;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_SNAPSHOT_CHARACTERS = 16 * 1024 * 1024;

function modelKey(model) {
	return model
		? JSON.stringify([model.provider, model.id ?? model.modelId])
		: "";
}

function exceedsCharacterLimit(value, limit) {
	let count = 0;
	const stack = [value];
	while (stack.length > 0) {
		const item = stack.pop();
		if (item === null || item === undefined) {
			count += 4;
		} else if (typeof item === "string") {
			count += item.length + 2;
		} else if (typeof item === "number" || typeof item === "boolean") {
			count += 8;
		} else if (Array.isArray(item)) {
			count += 2 + item.length;
			for (let i = item.length - 1; i >= 0; i--) stack.push(item[i]);
		} else if (typeof item === "object") {
			count += 2;
			for (const key of Object.keys(item)) {
				count += key.length + 4;
				if (count > limit) return true;
				stack.push(item[key]);
			}
		}
		if (count > limit) return true;
	}
	return false;
}

function isReplayablePayload(payload, api) {
	if (
		!payload ||
		typeof payload !== "object" ||
		payload.previous_response_id ||
		(payload.thinking &&
			payload.thinking.type !== "disabled" &&
			!(api === "anthropic-messages" && payload.thinking.type === "adaptive"))
	)
		return false;
	if (
		api === "anthropic-messages" ||
		api === "openai-responses" ||
		api === "openai-responses-ws"
	)
		return true;
	if (api === "openai-completions")
		return "max_completion_tokens" in payload || "max_tokens" in payload;
	return false;
}

function replayPayload(copy, api) {
	if (!isReplayablePayload(copy, api)) return null;
	if (api === "anthropic-messages") copy.max_tokens = 1;
	else if (api === "openai-responses" || api === "openai-responses-ws") {
		// The custom WS adapter calls onPayload after normalization, preserving this cap.
		copy.max_output_tokens = 1;
	} else if (api === "openai-completions") {
		if ("max_completion_tokens" in copy) copy.max_completion_tokens = 1;
		else if ("max_tokens" in copy) copy.max_tokens = 1;
		else return null;
	} else return null;
	return copy;
}

export default function (pi) {
	const policies = new Map();
	let context;
	let candidate;
	let snapshot;
	let settled;
	let timer;
	let expiryTimer;
	let controller;
	let normalRun = false;
	let lastStopReason;
	let requestCount = 0;
	let inputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let outputTokens = 0;
	let cost = 0;

	function publish(status, reason, expiresAtMs = 0, nextWarmAtMs = null) {
		const model = snapshot?.model ?? context?.model;
		context?.ui.setWidget(WIDGET_KEY, [
			JSON.stringify({
				ready: typeof context.modelRegistry.streamSimple === "function",
				status,
				reason,
				provider: model?.provider ?? null,
				modelId: model?.id ?? null,
				expiresAtMs,
				nextWarmAtMs,
				requestCount,
				inputTokens,
				cacheReadTokens,
				cacheWriteTokens,
				outputTokens,
				cost,
			}),
		]);
	}

	function clearTimers() {
		clearTimeout(timer);
		clearTimeout(expiryTimer);
		timer = undefined;
		expiryTimer = undefined;
		if (controller) {
			cost = null;
			controller.abort();
		}
		controller = undefined;
	}

	function stop(reason, unavailable = false) {
		clearTimers();
		candidate = undefined;
		snapshot = undefined;
		settled = undefined;
		publish(unavailable ? "unavailable" : "stopped", reason);
	}

	function policy() {
		return policies.get(modelKey(context?.model));
	}

	function contextLeafId() {
		// Renames and auxiliary usage records do not alter the cached model context.
		const branch = context.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			if (!["session_info", "usage"].includes(branch[index].type))
				return branch[index].id;
		}
		return null;
	}

	function isCurrent(current, leaf) {
		return (
			snapshot === current &&
			settled === leaf &&
			context.isIdle() &&
			context.sessionManager.getSessionId() === leaf.sessionId &&
			contextLeafId() === leaf.leafId &&
			modelKey(context.model) === current.key &&
			policy()?.enabled
		);
	}

	function schedule(reason = "scheduled") {
		clearTimeout(timer);
		clearTimeout(expiryTimer);
		const current = snapshot;
		const leaf = settled;
		const settings = policy();
		if (!current || !leaf || !settings?.enabled) return;
		if (!isCurrent(current, leaf)) return stop("context_changed");
		const now = Date.now();
		const expiresAt = leaf.at + settings.idleKeepAliveSeconds * 1000;
		const ttl = settings.cacheTtlSeconds * 1000;
		const nextWarmAt = current.usedAt + ttl * INTERVAL_RATIO;
		// Keep half of the pre-expiry margin for event-loop delay and dispatch.
		if (now >= current.usedAt + ttl * 0.95) return stop("cache_expired");
		if (now >= expiresAt) return stop("window_ended");
		publish(
			"scheduled",
			nextWarmAt < expiresAt ? reason : "window_ending",
			expiresAt,
			nextWarmAt < expiresAt ? Math.max(now, nextWarmAt) : null,
		);
		expiryTimer = setTimeout(() => stop("window_ended"), expiresAt - now);
		expiryTimer.unref?.();
		if (nextWarmAt < expiresAt) {
			timer = setTimeout(
				() => void warm(current, leaf, expiresAt),
				Math.max(0, nextWarmAt - now),
			);
			timer.unref?.();
		}
	}

	async function warm(current, leaf, expiresAt) {
		if (!isCurrent(current, leaf)) return stop("context_changed");
		const startedAt = Date.now();
		if (startedAt >= expiresAt) return stop("window_ended");
		const dispatchDeadline = current.usedAt + policy().cacheTtlSeconds * 950;
		if (startedAt >= dispatchDeadline) return stop("cache_expired");
		const abort = new AbortController();
		controller = abort;
		requestCount++;
		publish("warming", "warming", expiresAt);
		let timeout;
		try {
			const deadline = new Promise((resolve) => {
				timeout = setTimeout(
					() => {
						abort.abort();
						resolve(null);
					},
					Math.min(REQUEST_TIMEOUT_MS, expiresAt - startedAt),
				);
			});
			const response = await Promise.race([
				context.modelRegistry
					.streamSimple(current.model, current.context, {
						signal: abort.signal,
						maxTokens: 1,
						maxRetries: 0,
						sessionId: leaf.sessionId,
						disableContinuation: true,
						// Preserve the exact captured prefix, cache markers and thinking options.
						onPayload: (_payload, model) => {
							if (
								abort.signal.aborted ||
								!isCurrent(current, leaf) ||
								modelKey(model) !== current.key
							)
								throw new Error("stale cache keep-alive request");
							const payload = structuredClone(current.payload);
							// Authentication and payload preparation can outlive the dispatch margin.
							const now = Date.now();
							if (now >= expiresAt || now >= dispatchDeadline) {
								stop(now >= expiresAt ? "window_ended" : "cache_expired");
								throw new Error("cache keep-alive dispatch deadline passed");
							}
							return payload;
						},
					})
					.result(),
				deadline,
			]);
			if (!isCurrent(current, leaf)) return;
			if (!response || abort.signal.aborted) {
				cost = null;
				return stop("timeout", true);
			}
			if (
				response.stopReason === "error" ||
				response.stopReason === "aborted"
			) {
				cost = null;
				return stop("request_failed", true);
			}
			const usage = response.usage;
			inputTokens =
				inputTokens !== null && Number.isFinite(usage?.input)
					? inputTokens + usage.input
					: null;
			cacheReadTokens += usage?.cacheRead ?? 0;
			cacheWriteTokens += usage?.cacheWrite ?? 0;
			outputTokens += usage?.output ?? 0;
			cost =
				cost !== null && Number.isFinite(usage?.cost?.total)
					? cost + usage.cost.total
					: null;
			// A successful HTTP response need not have hit the cache. Never keep rebuilding it.
			if (!(usage?.cacheRead > 0)) return stop("cache_miss", true);
			current.usedAt = startedAt;
			schedule("warmed");
		} catch {
			if (isCurrent(current, leaf)) {
				cost = null;
				stop("request_failed", true);
			}
		} finally {
			clearTimeout(timeout);
			if (controller === abort) controller = undefined;
		}
	}

	pi.registerCommand("pilo-cache-keep-alive", {
		description: "Pilo prompt-cache keep-alive configuration",
		handler: async (args, ctx) => {
			context = ctx;
			let settings;
			try {
				settings = JSON.parse(args);
			} catch {
				return;
			}
			if (settings && !Array.isArray(settings) && settings.action === "pause") {
				if (normalRun) return;
				stop("paused");
				return;
			}
			if (!Array.isArray(settings) || settings.length > 4096) return;
			let changed = false;
			for (const setting of settings) {
				if (
					!setting ||
					typeof setting.provider !== "string" ||
					typeof setting.modelId !== "string" ||
					typeof setting.enabled !== "boolean" ||
					!Number.isSafeInteger(setting.updatedAtMs) ||
					!Number.isInteger(setting.cacheTtlSeconds) ||
					setting.cacheTtlSeconds < 10 ||
					setting.cacheTtlSeconds > 86400 ||
					!Number.isInteger(setting.idleKeepAliveSeconds) ||
					setting.idleKeepAliveSeconds < 60 ||
					setting.idleKeepAliveSeconds > 86400
				)
					continue;
				const key = modelKey(setting);
				if ((policies.get(key)?.updatedAtMs ?? -1) >= setting.updatedAtMs)
					continue;
				policies.set(key, setting);
				if (key === modelKey(ctx.model)) changed = true;
			}
			if (!changed) return;
			if (!policy()?.enabled) stop("disabled");
			else if (snapshot && settled) {
				// Invalidate a pending response without resetting the original idle window.
				settled = { ...settled };
				if (controller) {
					cost = null;
					controller.abort();
				}
				controller = undefined;
				schedule();
			} else publish("stopped", "waiting_request");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		context = ctx;
		normalRun = false;
		stop("waiting_request");
	});
	pi.on("before_agent_start", (_event, ctx) => {
		context = ctx;
		normalRun = true;
		lastStopReason = undefined;
		stop(policy()?.enabled ? "running" : "disabled");
	});
	pi.on("context_with_system", (event, ctx) => {
		context = ctx;
		if (!normalRun || !policy()?.enabled) return;
		snapshot = undefined;
		candidate = {
			context: { messages: convertToLlm(event.messages) },
			key: modelKey(ctx.model),
		};
	});
	pi.on("before_provider_request", (event, ctx) => {
		if (
			!normalRun ||
			!candidate ||
			!policy()?.enabled ||
			!event.payload ||
			typeof event.payload !== "object"
		)
			return;
		if (
			!isReplayablePayload(event.payload, ctx.model?.api) ||
			exceedsCharacterLimit(event.payload, MAX_SNAPSHOT_CHARACTERS)
		) {
			candidate = undefined;
			return;
		}
		candidate.payload = structuredClone(event.payload);
		candidate.usedAt = Date.now();
		candidate.model = ctx.model;
	});
	pi.on("message_end", (event, ctx) => {
		const message = event.message;
		if (!normalRun || message?.role !== "assistant" || !policy()?.enabled)
			return;
		lastStopReason = message.stopReason;
		// Aborting output does not invalidate the already captured provider input.
		if (message.stopReason === "error") {
			snapshot = undefined;
			candidate = undefined;
			return;
		}
		if (!candidate?.payload || candidate.key !== modelKey(ctx.model)) return;
		if (
			message.provider !== ctx.model.provider ||
			message.model !== ctx.model.id
		) {
			candidate = undefined;
			snapshot = undefined;
			return;
		}
		const payload = replayPayload(candidate.payload, ctx.model.api);
		snapshot = payload ? { ...candidate, payload } : undefined;
		candidate = undefined;
	});
	pi.on("agent_end", (_event, ctx) => {
		// Older Pi versions may accept unknown hook names without emitting them.
		// Report missing capture support, but never schedule from agent_end.
		context = ctx;
		if (
			normalRun &&
			policy()?.enabled &&
			lastStopReason &&
			!["error", "aborted"].includes(lastStopReason) &&
			!candidate &&
			!snapshot
		)
			stop("unsupported_request", true);
	});
	pi.on("agent_settled", (event, ctx) => {
		if (!normalRun) return;
		context = ctx;
		normalRun = false;
		if (!policy()?.enabled) return stop("disabled");
		// Stop can arrive before capture or after a reusable request (including during tools).
		if (
			lastStopReason === "error" ||
			(!snapshot &&
				(event.aborted || !lastStopReason || lastStopReason === "aborted"))
		)
			return stop("waiting_request");
		if (!snapshot || typeof ctx.modelRegistry.streamSimple !== "function")
			return stop("unsupported_request", true);
		settled = {
			sessionId: ctx.sessionManager.getSessionId(),
			leafId: contextLeafId(),
			at: Date.now(),
		};
		schedule();
	});
	// Suppress Pi's competing timer only for models managed by Pilo; no settings are written.
	pi.on("cache_warming_decision", (_event, ctx) =>
		policies.get(modelKey(ctx.model))?.enabled ? { action: "stop" } : undefined,
	);
	for (const event of [
		"model_select",
		"thinking_level_select",
		"session_before_switch",
		"session_before_fork",
		"session_before_tree",
		"session_before_compact",
		"session_compact",
		"session_shutdown",
	]) {
		pi.on(event, (_event, ctx) => {
			context = ctx;
			normalRun = false;
			stop("context_changed");
		});
	}
}

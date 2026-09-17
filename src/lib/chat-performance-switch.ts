export type ChatSessionSwitchSample = {
	fromSessionId: string | null;
	requestedSessionId: string;
	readySessionId: string;
	durationMs: number;
	slowScrollFrames: number;
	verySlowScrollFrames: number;
	longTasks: number;
	longTaskMs: number;
	timestamp: string;
};

export type ChatSessionSwitchSummary = {
	count: number;
	medianMs: number | null;
	p95Ms: number | null;
	worstMs: number | null;
	slowScrollFrames: number;
	verySlowScrollFrames: number;
	longTasks: number;
	longTaskMs: number;
};

function roundTenth(value: number) {
	return Math.round(value * 10) / 10;
}

function median(sorted: readonly number[]) {
	if (sorted.length === 0) return null;
	const middle = Math.floor(sorted.length / 2);
	if (sorted.length % 2 === 1) return sorted[middle] ?? null;
	return roundTenth(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function percentileNearestRank(sorted: readonly number[], percentile: number) {
	if (sorted.length === 0) return null;
	const rank = Math.max(1, Math.ceil(percentile * sorted.length));
	return sorted[Math.min(sorted.length - 1, rank - 1)] ?? null;
}

export function summarizeChatSessionSwitchSamples(
	samples: readonly ChatSessionSwitchSample[],
): ChatSessionSwitchSummary {
	const durations: number[] = [];
	for (const sample of samples) {
		let index = durations.length;
		while (index > 0 && durations[index - 1]! > sample.durationMs) index -= 1;
		durations.splice(index, 0, sample.durationMs);
	}

	return {
		count: samples.length,
		medianMs: median(durations),
		p95Ms: percentileNearestRank(durations, 0.95),
		worstMs:
			durations.length > 0 ? (durations[durations.length - 1] ?? null) : null,
		slowScrollFrames: samples.reduce(
			(total, sample) => total + sample.slowScrollFrames,
			0,
		),
		verySlowScrollFrames: samples.reduce(
			(total, sample) => total + sample.verySlowScrollFrames,
			0,
		),
		longTasks: samples.reduce((total, sample) => total + sample.longTasks, 0),
		longTaskMs: roundTenth(
			samples.reduce((total, sample) => total + sample.longTaskMs, 0),
		),
	};
}

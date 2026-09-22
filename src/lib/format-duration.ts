export type DurationUnitLabels = {
	hour: string;
	minute: string;
	second: string;
};

const pad2 = (value: number) => String(value).padStart(2, "0");

export function formatDurationCompact(
	durationMs: number,
	units: DurationUnitLabels,
) {
	if (!Number.isFinite(durationMs) || durationMs < 0) return "";

	const totalSeconds = Math.floor(durationMs / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}${units.hour} ${pad2(minutes)}${units.minute} ${pad2(seconds)}${units.second}`;
	}
	if (minutes > 0) {
		return `${minutes}${units.minute} ${pad2(seconds)}${units.second}`;
	}
	return `${seconds}${units.second}`;
}

export function formatWorkDuration(
	durationMs: number,
	units: DurationUnitLabels,
) {
	return formatDurationCompact(durationMs, units);
}

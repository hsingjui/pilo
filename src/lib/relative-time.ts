export type RelativeTimeValue = string | number | Date | null | undefined;

/**
 * 紧凑相对时间标签（1m / 2h / 3d / 1w / 2mo / 1y）。
 * 侧栏会话行与悬浮卡片共用，保证所有位置的时间格式一致。
 */
export function formatCompactRelativeTime(
	value: RelativeTimeValue,
	now: Date = new Date(),
): string {
	if (value == null) return "--";
	const date = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(date.getTime())) return "--";

	const diffMs = Math.max(0, now.getTime() - date.getTime());
	const minutes = Math.floor(diffMs / 60_000);
	if (minutes < 60) return `${minutes}m`;

	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;

	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;

	const weeks = Math.floor(days / 7);
	if (weeks < 4) return `${weeks}w`;

	const months = Math.floor(days / 30);
	if (months < 12) return `${months}mo`;

	return `${Math.floor(days / 365)}y`;
}

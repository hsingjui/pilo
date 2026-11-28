const pad = (value: number) => String(value).padStart(2, "0");

export function formatLocalDateTime(timestampMs: number | undefined) {
	if (timestampMs === undefined) return "";
	const date = new Date(timestampMs);
	if (!Number.isFinite(date.getTime())) return "";
	const year = String(date.getFullYear()).padStart(4, "0");
	const day = `${year}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	return `${day} ${time}`;
}

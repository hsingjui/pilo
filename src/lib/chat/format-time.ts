export function formatTime(timestampMs = Date.now()) {
	return new Intl.DateTimeFormat("zh-CN", {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	}).format(new Date(timestampMs));
}

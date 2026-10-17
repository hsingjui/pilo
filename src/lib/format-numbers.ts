/**
 * 数值展示的公共格式化：上下文用量、单轮 token、费用共用同一套口径，
 * 避免各处各写一份 `toFixed`。
 */

/** 非有限值（null/NaN/Infinity）统一视为缺失。 */
export function finiteNumber(value: number | null | undefined) {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

/** token 数统一用 k/M（不走 locale 的万/亿），贴合模型界惯例。 */
export function formatCompactTokens(value: number | null | undefined) {
	const normalized = finiteNumber(value);
	if (normalized === undefined) return "—";
	const n = Math.max(0, normalized);
	if (n < 1000) return String(Math.round(n));
	const scaled = (divisor: number) => {
		const text = (n / divisor).toFixed(1);
		return text.endsWith(".0") ? text.slice(0, -2) : text;
	};
	if (n < 1_000_000) {
		const k = scaled(1000);
		return k === "1000" ? "1M" : `${k}k`;
	}
	return `${scaled(1_000_000)}M`;
}

export function formatCost(value: number | undefined) {
	if (value === undefined || !Number.isFinite(value)) return "—";
	if (value < 0.01) return `$${value.toFixed(4)}`;
	return `$${value.toFixed(2)}`;
}

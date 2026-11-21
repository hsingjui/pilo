/**
 * Pi 的单条消息用量（`Usage`）。
 *
 * assistant 消息总是带用量；工具结果只在内部做了嵌套模型调用时才有。
 * 实时 RPC 事件与会话 JSONL 上报的是同一种形状，所以这里只定义一次。
 */
export type TokenUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost?: number;
};

/** 有可展示的用量时才渲染 token 行；全 0 视为没有数据。 */
export function hasTokenUsage(
	usage: TokenUsage | null | undefined,
): usage is TokenUsage {
	if (!usage) return false;
	return (
		usage.total > 0 ||
		usage.input > 0 ||
		usage.output > 0 ||
		usage.cacheRead > 0 ||
		usage.cacheWrite > 0 ||
		(typeof usage.cost === "number" && usage.cost > 0)
	);
}

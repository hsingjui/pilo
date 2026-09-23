import { type ComponentProps, useState } from "react";
import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

/** 与 Tailwind `--animate-spin` 的时长（1s）保持一致，用于对齐相位。 */
const SPIN_DURATION_MS = 1000;

type SpinnerProps = ComponentProps<typeof LoaderCircle>;

/**
 * 统一的加载图标。
 *
 * CSS 动画在元素挂载时才从 0 开始，因此多个会话同时运行时各自的图标相位不同、
 * 看起来“各转各的”。这里按当前挂钟时间给出负的 `animation-delay`，把所有 Spinner
 * 锚定到同一时间轴，于是旋转进度与速度完全同步。
 */
export function Spinner({ className, style, ...props }: SpinnerProps) {
	const [animationDelay] = useState(
		() => `-${Date.now() % SPIN_DURATION_MS}ms`,
	);
	return (
		<LoaderCircle
			className={cn("animate-spin", className)}
			style={{ ...style, animationDelay }}
			{...props}
		/>
	);
}

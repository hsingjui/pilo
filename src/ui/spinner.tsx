import { type ComponentProps, useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

/** 与 Tailwind `--animate-spin` 的时长（1s）保持一致。 */
const SPIN_DURATION_MS = 1000;

/** 已锚定过 startTime 的动画，避免每帧重复锚定。 */
const anchored = new WeakSet<Animation>();

type SpinnerProps = ComponentProps<typeof LoaderCircle>;

/**
 * 统一的加载图标。
 *
 * 通过 WAAPI 把动画 `startTime` 锚定到挂钟时间，使相位 ≡ 挂钟 mod 时长，
 * 因此所有 Spinner 旋转进度完全同步。
 *
 * 侧边栏按活动时间重排会话时 React 会移动列表 DOM 节点，Chromium 对被移动
 * 元素上的 CSS 动画做重启，并把新动画的 startTime 设为未来时刻（恰好一个
 * 周期），动画于是冻结一拍再跳变——这就是旋转图标“上下晃”的原因。React 的
 * onAnimationStart 捕获不到这类重启，所以用 rAF 每帧巡检：发现 startTime
 * 为 null、指向未来或未锚定过的动画，立即把 startTime 锚回当前挂钟相位。
 */
export function Spinner({ className, style, ...props }: SpinnerProps) {
	const ref = useRef<SVGSVGElement>(null);
	useEffect(() => {
		let raf = 0;
		const tick = () => {
			const element = ref.current;
			if (element) {
				const now = performance.now();
				const phase = (Date.now() - performance.timeOrigin) % SPIN_DURATION_MS;
				for (const animation of element.getAnimations()) {
					if (
						!anchored.has(animation) ||
						animation.startTime === null ||
						Number(animation.startTime) > now
					) {
						animation.startTime = now - phase;
						anchored.add(animation);
					}
				}
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, []);
	return (
		<LoaderCircle
			ref={ref}
			className={cn("animate-spin", className)}
			style={style}
			{...props}
		/>
	);
}

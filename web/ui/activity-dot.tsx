import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type ActivityDotProps = ComponentProps<"span">;

/**
 * 固定几何尺寸的活动状态点。
 *
 * 只通过 opacity 呼吸表达持续活动，不做旋转或缩放，避免在侧栏等密集列表中
 * 因视觉重心或轮廓变化产生抖动感。
 */
export function ActivityDot({ className, ...props }: ActivityDotProps) {
	return (
		<span
			className={cn(
				"inline-block size-1.5 shrink-0 rounded-full bg-current motion-safe:animate-pulse",
				className,
			)}
			{...props}
		/>
	);
}

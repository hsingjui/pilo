import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;

const Tooltip = TooltipPrimitive.Root;

// Radix 在 trigger 聚焦时会零延迟打开 tooltip（绕过 delayDuration）。
// 浏览器切回窗口时会给原聚焦元素补发 focus，鼠标点击留下的焦点同理，
// 导致切回应用时 tooltip 自动弹出。这里只放行键盘焦点（focus-visible），
// 其余 focus 通过 preventDefault 阻止 Radix 内部的打开逻辑。
const TooltipTrigger = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Trigger>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>((props, ref) => (
	<TooltipPrimitive.Trigger
		ref={ref}
		{...props}
		onFocus={(event) => {
			if (!event.currentTarget.matches(":focus-visible")) {
				event.preventDefault();
			}
			props.onFocus?.(event);
		}}
	/>
));
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

const TooltipContent = React.forwardRef<
	React.ElementRef<typeof TooltipPrimitive.Content>,
	React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
	<TooltipPrimitive.Portal>
		<TooltipPrimitive.Content
			ref={ref}
			sideOffset={sideOffset}
			className={cn(
				"z-[var(--z-tooltip)] overflow-hidden rounded-md border border-border shadow-md",
				"bg-popover text-popover-foreground",
				"px-3 py-1.5 text-xs",
				"animate-in fade-in-0 motion-safe:zoom-in-95",
				"data-[state=closed]:animate-out data-[state=closed]:fade-out-0 motion-safe:data-[state=closed]:zoom-out-95",
				"motion-safe:data-[side=bottom]:slide-in-from-top-2 motion-safe:data-[side=left]:slide-in-from-right-2",
				"motion-safe:data-[side=right]:slide-in-from-left-2 motion-safe:data-[side=top]:slide-in-from-bottom-2",
				"origin-(--radix-tooltip-content-transform-origin)",
				className,
			)}
			{...props}
		/>
	</TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

type HintProps = {
	/** 提示文本；为空时不渲染气泡，children 原样保留 */
	label: React.ReactNode;
	side?: React.ComponentPropsWithoutRef<
		typeof TooltipPrimitive.Content
	>["side"];
	align?: React.ComponentPropsWithoutRef<
		typeof TooltipPrimitive.Content
	>["align"];
	sideOffset?: React.ComponentPropsWithoutRef<
		typeof TooltipPrimitive.Content
	>["sideOffset"];
	/** 打开延迟，默认比 Provider 的 700ms 更快，适合截断文本的即读即显 */
	delayDuration?: number;
	className?: string;
	/** 触发元素，必须是单个能接收 ref 的元素 */
	children: React.ReactElement;
};

/**
 * 单行文字提示，替代原生 title 属性：外观复用 TooltipContent，长文本限宽换行。
 * 非交互元素（span/div）保持仅悬浮触发，不会新增键盘焦点。
 */
function Hint({
	label,
	side,
	align,
	sideOffset,
	delayDuration = 300,
	className,
	children,
}: HintProps) {
	const hasLabel = label !== undefined && label !== null && label !== "";
	return (
		<Tooltip delayDuration={delayDuration}>
			<TooltipTrigger asChild>{children}</TooltipTrigger>
			{hasLabel ? (
				<TooltipContent
					side={side}
					align={align}
					sideOffset={sideOffset}
					className={cn("max-w-80 break-words", className)}
				>
					{label}
				</TooltipContent>
			) : null}
		</Tooltip>
	);
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider, Hint };

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

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };

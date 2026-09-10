import * as React from "react";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";

import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.Root>,
	React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root> & {
		/**
		 * Enable horizontal scrollbar. When true, the Radix content wrapper keeps
		 * its default `display: table` so it can expand beyond the viewport width,
		 * enabling horizontal scroll.
		 */
		scrollableX?: boolean;
		/**
		 * When true with `scrollableX`, skip the vertical scrollbar track. Useful
		 * for single-row tab strips that only scroll horizontally.
		 */
		horizontalOnly?: boolean;
		viewportAsChild?: boolean;
		viewportClassName?: string;
		viewportRef?: React.Ref<HTMLDivElement>;
		viewportStyle?: React.CSSProperties;
		scrollbarClassName?: string;
		scrollbarThumbClassName?: string;
		/** Applied only to the horizontal scrollbar (defaults to `scrollbarClassName`). */
		horizontalScrollbarClassName?: string;
		horizontalScrollbarThumbClassName?: string;
	}
>(
	(
		{
			className,
			children,
			scrollableX,
			horizontalOnly,
			viewportAsChild,
			viewportClassName,
			viewportRef,
			viewportStyle,
			scrollbarClassName,
			scrollbarThumbClassName,
			horizontalScrollbarClassName,
			horizontalScrollbarThumbClassName,
			...props
		},
		ref,
	) => (
		<ScrollAreaPrimitive.Root
			ref={ref}
			className={cn("relative overflow-hidden", className)}
			{...props}
		>
			{/* https://github.com/radix-ui/primitives/issues/926 */}
			<ScrollAreaPrimitive.Viewport
				ref={viewportRef}
				asChild={viewportAsChild}
				className={cn(
					"h-full w-full rounded-[inherit]",
					!scrollableX && "[&>div]:block!",
					viewportClassName,
				)}
				style={viewportStyle}
			>
				{children}
			</ScrollAreaPrimitive.Viewport>
			{!horizontalOnly && (
				<ScrollBar
					className={scrollbarClassName}
					thumbClassName={scrollbarThumbClassName}
				/>
			)}
			{scrollableX && (
				<ScrollBar
					orientation="horizontal"
					className={horizontalScrollbarClassName ?? scrollbarClassName}
					thumbClassName={
						horizontalScrollbarThumbClassName ?? scrollbarThumbClassName
					}
				/>
			)}
			<ScrollAreaPrimitive.Corner />
		</ScrollAreaPrimitive.Root>
	),
);
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

const ScrollBar = React.forwardRef<
	React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
	React.ComponentPropsWithoutRef<
		typeof ScrollAreaPrimitive.ScrollAreaScrollbar
	> & {
		thumbClassName?: string;
	}
>(({ className, orientation = "vertical", thumbClassName, ...props }, ref) => (
	<ScrollAreaPrimitive.ScrollAreaScrollbar
		ref={ref}
		orientation={orientation}
		className={cn(
			// Absolute so the track overlays the edge instead of growing the layout
			// (important for compact tab strips where a 10px in-flow bar is too tall).
			"flex touch-none select-none transition-colors",
			orientation === "vertical" &&
				"absolute top-0 right-0 h-full w-2.5 border-l border-l-transparent p-px",
			orientation === "horizontal" &&
				"absolute bottom-0 left-0 h-1.5 w-full flex-col border-t border-t-transparent p-px",
			className,
		)}
		{...props}
	>
		<ScrollAreaPrimitive.ScrollAreaThumb
			className={cn(
				"relative flex-1 rounded-full bg-[hsl(var(--scrollbar-thumb)/0.5)] transition-colors hover:bg-[hsl(var(--scrollbar-thumb-hover)/0.65)] active:bg-[hsl(var(--scrollbar-thumb-active)/0.75)]",
				thumbClassName,
			)}
		/>
	</ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };

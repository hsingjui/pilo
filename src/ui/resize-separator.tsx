import { Separator, type SeparatorProps } from "react-resizable-panels";

import { cn } from "@/lib/utils";

export const RESIZE_TARGET_MINIMUM_SIZE = { fine: 8, coarse: 44 };

export function ResizeSeparator({ className, ...props }: SeparatorProps) {
	return (
		<Separator
			{...props}
			disableDoubleClick
			className={cn(
				"relative w-px bg-transparent focus-visible:outline-hidden after:absolute after:left-1/2 after:top-1/2 after:h-8 after:w-0.5 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full after:bg-transparent hover:after:bg-ring/50 focus-visible:after:bg-ring data-[separator=hover]:after:bg-ring/50 data-[separator=active]:after:bg-ring",
				className,
			)}
		/>
	);
}

import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
	({ className, type, ...props }, ref) => {
		return (
			<input
				type={type}
				className={cn(
					"flex w-full rounded-md border bg-input-field text-base text-input-foreground shadow-(--pilo-field-shadow) transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-input-placeholder focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 md:text-sm outline-hidden",
					"pilo-field pilo-field-shadow pilo-input",
					className,
				)}
				ref={ref}
				{...props}
			/>
		);
	},
);
Input.displayName = "Input";

export { Input };

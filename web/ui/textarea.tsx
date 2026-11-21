import * as React from "react";

import { cn } from "@/lib/utils";

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
	({ className, ...props }, ref) => {
		return (
			<textarea
				className={cn(
					"flex w-full rounded-md border bg-input-field text-sm text-input-foreground ring-offset-background placeholder:text-input-placeholder focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/60 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60",
					"pilo-field pilo-textarea",
					className,
				)}
				ref={ref}
				{...props}
			/>
		);
	},
);
Textarea.displayName = "Textarea";

export { Textarea };

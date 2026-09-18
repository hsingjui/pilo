import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function ConversationColumn({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("mx-auto w-full max-w-[80%] px-3 sm:px-4", className)}>
			{children}
		</div>
	);
}

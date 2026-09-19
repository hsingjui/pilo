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
		// 自身 padding 查询的是外层聊天页容器（@container 祖先），子元素查询本列。
		<div
			className={cn(
				"@container mx-auto w-full max-w-[min(80%,52rem)] px-3 @min-[40rem]:px-4",
				className,
			)}
		>
			{children}
		</div>
	);
}

import { cn } from "@/lib/utils";

import { ConversationColumn } from "@/components/chat/chat-conversation-column";

function Bone({
	className,
	strong = false,
}: {
	className?: string;
	strong?: boolean;
}) {
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pilo-skeleton-bone rounded-md",
				strong ? "pilo-skeleton-strong" : "pilo-skeleton-line",
				className,
			)}
		/>
	);
}

function AssistantSkeleton({
	widths,
}: {
	widths: readonly [string, string, string];
}) {
	return (
		<div className="py-2 @min-[40rem]:py-3">
			<div className="grid gap-2.5">
				<Bone className={cn("h-3", widths[0])} />
				<Bone className={cn("h-3", widths[1])} />
				<Bone className={cn("h-3", widths[2])} />
			</div>
		</div>
	);
}

function UserSkeleton({ className }: { className: string }) {
	return (
		<div className="flex justify-end py-2 @min-[40rem]:py-3">
			<Bone strong className={cn("h-11 rounded-2xl", className)} />
		</div>
	);
}

export function ChatHistorySkeleton() {
	return (
		<output
			aria-live="polite"
			className="flex min-h-full flex-col pb-8 pt-4 @min-[40rem]:pb-10 @min-[40rem]:pt-6"
		>
			<span className="sr-only">正在加载会话</span>
			<ConversationColumn className="flex-1">
				<UserSkeleton className="w-[42%] @min-[40rem]:w-[34%]" />
				<AssistantSkeleton widths={["w-[82%]", "w-[68%]", "w-[48%]"]} />
				<UserSkeleton className="w-[50%] @min-[40rem]:w-[41%]" />
				<AssistantSkeleton widths={["w-[72%]", "w-[88%]", "w-[58%]"]} />
				<UserSkeleton className="w-[35%] @min-[40rem]:w-[29%]" />
				<AssistantSkeleton widths={["w-[90%]", "w-[64%]", "w-[40%]"]} />
			</ConversationColumn>
		</output>
	);
}

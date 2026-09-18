import { cn } from "@/lib/utils";

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
				"pilo-skeleton-breathe rounded-md",
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
		<div className="py-2 sm:py-3">
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
		<div className="flex justify-end py-2 sm:py-3">
			<Bone strong className={cn("h-11 rounded-2xl", className)} />
		</div>
	);
}

export function ChatHistorySkeleton() {
	return (
		<output
			aria-live="polite"
			className="flex min-h-full flex-col pb-8 pt-4 sm:pb-10 sm:pt-6"
		>
			<span className="sr-only">正在加载会话</span>
			<div className="mx-auto w-full max-w-[80%] flex-1 px-3 sm:px-4">
				<AssistantSkeleton widths={["w-[82%]", "w-[68%]", "w-[48%]"]} />
				<UserSkeleton className="w-[46%] sm:w-[38%]" />
				<AssistantSkeleton widths={["w-[72%]", "w-[88%]", "w-[58%]"]} />
				<div className="py-2 sm:py-3">
					<Bone strong className="h-8 w-[42%] rounded-lg" />
				</div>
				<UserSkeleton className="w-[35%] sm:w-[30%]" />
				<AssistantSkeleton widths={["w-[90%]", "w-[64%]", "w-[40%]"]} />
			</div>
		</output>
	);
}

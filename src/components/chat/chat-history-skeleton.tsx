import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/ui";

import { ConversationColumn } from "@/components/chat/chat-conversation-column";

type AssistantShape = {
	/** 折叠的工具/思考活动行（真实回复里通常在正文之前）。 */
	activity?: string;
	lines: readonly string[];
};

type TurnShape = {
	user: string;
	assistant: AssistantShape;
};

// 从旧到新排列，最新一轮紧贴输入框。宽度错落但固定，避免每次渲染跳变。
const TURNS: readonly TurnShape[] = [
	{
		user: "w-[46%] @min-[40rem]:w-[36%]",
		assistant: { lines: ["w-[86%]", "w-[62%]"] },
	},
	{
		user: "w-[38%] @min-[40rem]:w-[30%]",
		assistant: {
			activity: "w-[34%] @min-[40rem]:w-[26%]",
			lines: ["w-[90%]", "w-[74%]", "w-[52%]"],
		},
	},
	{
		user: "w-[56%] @min-[40rem]:w-[44%]",
		assistant: { lines: ["w-[80%]", "w-[92%]", "w-[66%]", "w-[38%]"] },
	},
	{
		user: "w-[42%] @min-[40rem]:w-[34%]",
		assistant: {
			activity: "w-[40%] @min-[40rem]:w-[30%]",
			lines: ["w-[82%]", "w-[68%]", "w-[48%]"],
		},
	},
	{
		user: "w-[50%] @min-[40rem]:w-[41%]",
		assistant: { lines: ["w-[72%]", "w-[88%]", "w-[58%]"] },
	},
	{
		user: "w-[35%] @min-[40rem]:w-[29%]",
		assistant: {
			activity: "w-[30%] @min-[40rem]:w-[24%]",
			lines: ["w-[90%]", "w-[64%]", "w-[40%]"],
		},
	},
];

function AssistantSkeleton({ shape }: { shape: AssistantShape }) {
	return (
		<div className="py-2 @min-[40rem]:py-3">
			{shape.activity ? (
				<div className="mb-1.5 flex h-7 items-center gap-2">
					<Skeleton className="size-3.5 shrink-0 rounded-sm" />
					<Skeleton className={cn("h-2.5", shape.activity)} />
				</div>
			) : null}
			<div className="grid gap-2.5 py-1">
				{shape.lines.map((width) => (
					<Skeleton key={width} className={cn("h-3", width)} />
				))}
			</div>
			{/* 对齐真实回复底部的时间/操作行占位，最新一轮与输入框的间距才一致。 */}
			<div className="mt-0.5 h-7" />
		</div>
	);
}

function UserSkeleton({ className }: { className: string }) {
	return (
		<div className="flex justify-end py-2 @min-[40rem]:py-3">
			<Skeleton strong className={cn("h-11 rounded-bubble", className)} />
		</div>
	);
}

/**
 * 历史读取骨架。默认打开历史会话会贴底显示最新消息，因此骨架同样贴底排列、
 * 超出高度时裁掉顶部，正文就绪后最新一轮落在骨架原来的位置，减少视觉跳动。
 */
export function ChatHistorySkeleton() {
	const { t } = useTranslation();
	return (
		<output
			aria-live="polite"
			className="flex h-full min-h-full flex-col justify-end overflow-hidden pb-8 pt-4 [mask-image:linear-gradient(to_bottom,transparent,black_3rem)] @min-[40rem]:pb-10 @min-[40rem]:pt-6"
		>
			<span className="sr-only">{t("chat.historyLoading")}</span>
			<ConversationColumn className="shrink-0">
				{TURNS.map((turn) => (
					<div key={turn.user}>
						<UserSkeleton className={turn.user} />
						<AssistantSkeleton shape={turn.assistant} />
					</div>
				))}
			</ConversationColumn>
		</output>
	);
}

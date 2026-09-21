import { useState } from "react";
import {
	ChevronDown,
	ChevronUp,
	CircleCheck,
	LoaderCircle,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";

import type { ChatRuntimeRecoveryState } from "@/components/chat/use-chat-runtime";
import { appErrorActionLabel } from "@/lib/app-error";
import { Button, NoticeCard, NoticeIcon } from "@/ui";

export function ChatRuntimeRecoveryNotice({
	state,
	onReconnect,
	onNewTemporaryChat,
}: {
	state: ChatRuntimeRecoveryState;
	onReconnect: () => void;
	onNewTemporaryChat?: () => void;
}) {
	const [detailsOpen, setDetailsOpen] = useState(false);
	if (state.status === "idle") return null;

	const recovering = state.status === "reconnecting";
	const recovered = state.status === "recovered";
	const error = state.status === "failed" ? state.error : undefined;
	const action =
		state.status === "failed" && state.recoverable
			? {
					label: error ? (appErrorActionLabel(error) ?? "重试") : "重新连接",
					onClick: onReconnect,
				}
			: state.status === "failed" && onNewTemporaryChat
				? { label: "新建临时会话", onClick: onNewTemporaryChat }
				: null;
	const detail = error?.detail?.trim();

	return (
		<NoticeCard
			announce={state.status === "failed" ? "alert" : "status"}
			ariaLive="polite"
			className="px-3 py-2"
		>
			<div className="flex min-w-0 items-start gap-2.5">
				{recovering ? (
					<NoticeIcon icon={LoaderCircle} className="animate-spin" />
				) : recovered ? (
					<NoticeIcon icon={CircleCheck} tone="success" />
				) : (
					<NoticeIcon icon={TriangleAlert} tone="warning" />
				)}
				<div className="min-w-0 flex-1">
					<div className="font-medium text-foreground/85">
						{recovering
							? "正在恢复 Pi 会话"
							: recovered
								? "Pi 会话已恢复"
								: state.recoverable
									? "运行环境已中断"
									: "当前会话已中断"}
					</div>
					<div className="mt-0.5 break-words leading-5 text-muted-foreground">
						{state.message}
					</div>
				</div>
				{action ? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 shrink-0 gap-1.5 px-2 text-2xs text-muted-foreground"
						onClick={action.onClick}
					>
						<RefreshCw className="size-3" />
						{action.label}
					</Button>
				) : null}
			</div>
			{detail && detail !== state.message ? (
				<div className="ml-6 mt-1">
					<button
						type="button"
						className="inline-flex items-center gap-1 text-2xs text-muted-foreground transition-[color,scale] duration-150 ease-out hover:text-foreground active:scale-[0.96]"
						onClick={() => setDetailsOpen((open) => !open)}
					>
						{detailsOpen ? (
							<ChevronUp className="size-3" />
						) : (
							<ChevronDown className="size-3" />
						)}
						查看详情
					</button>
					{detailsOpen ? (
						<div className="mt-1.5 max-h-24 overflow-auto rounded-md bg-background/70 px-2 py-1.5 font-mono text-2xs leading-4 text-muted-foreground">
							{detail}
						</div>
					) : null}
				</div>
			) : null}
		</NoticeCard>
	);
}

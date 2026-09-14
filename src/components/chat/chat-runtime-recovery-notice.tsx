import {
	CircleCheck,
	LoaderCircle,
	RefreshCw,
	TriangleAlert,
} from "lucide-react";

import type { ChatRuntimeRecoveryState } from "@/components/chat/use-chat-runtime";
import { Button } from "@/ui";

export function ChatRuntimeRecoveryNotice({
	state,
	onReconnect,
	onNewTemporaryChat,
}: {
	state: ChatRuntimeRecoveryState;
	onReconnect: () => void;
	onNewTemporaryChat?: () => void;
}) {
	if (state.status === "idle") return null;

	const recovering = state.status === "reconnecting";
	const recovered = state.status === "recovered";
	const action =
		state.status === "failed" && state.recoverable
			? { label: "重新连接", onClick: onReconnect }
			: state.status === "failed" && onNewTemporaryChat
				? { label: "新建临时会话", onClick: onNewTemporaryChat }
				: null;

	return (
		<div
			role={state.status === "failed" ? "alert" : "status"}
			aria-live="polite"
			className="mb-1 flex min-w-0 items-start gap-2.5 rounded-xl border border-border/60 bg-muted/30 px-3 py-2 text-xs"
		>
			{recovering ? (
				<LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
			) : recovered ? (
				<CircleCheck className="mt-0.5 size-3.5 shrink-0 text-status-success" />
			) : (
				<TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-warning" />
			)}
			<div className="min-w-0 flex-1">
				<div className="font-medium text-foreground/85">
					{recovering
						? "正在恢复 Pi 会话"
						: recovered
							? "Pi 会话已恢复"
							: state.recoverable
								? "Pi 会话连接已中断"
								: "临时会话已中断"}
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
					className="h-7 shrink-0 gap-1.5 px-2 text-[11px] text-muted-foreground"
					onClick={action.onClick}
				>
					<RefreshCw className="size-3" />
					{action.label}
				</Button>
			) : null}
		</div>
	);
}

import { token, Text, View } from "nsh";

import type { ChatTodoItem, ChatTodoStatus } from "@shared/chat/chat-todos";

import { t } from "../shell/i18n";
import { Icon, type IconName } from "../ui/icon";

const statusIcons: Record<ChatTodoStatus, IconName> = {
	pending: "Circle",
	in_progress: "CircleDot",
	completed: "CircleCheck",
	cancelled: "Ban",
};

const statusColors = {
	pending: "muted-foreground",
	in_progress: "foreground",
	completed: "status-success",
	cancelled: "muted-foreground",
} as const;

const statusLabels = {
	pending: "chat.todoStatusPending",
	in_progress: "chat.todoStatusInProgress",
	completed: "chat.todoStatusCompleted",
	cancelled: "chat.todoStatusCancelled",
} as const;

function isDone(status: ChatTodoStatus) {
	return status === "completed" || status === "cancelled";
}

/** A task list: what a todo tool's row opens to, and the capsule's body. */
export function ChatTodoList(props: {
	items: () => readonly ChatTodoItem[];
	class?: string;
}) {
	return (
		<View class={props.class ? `gap-1.5 ${props.class}` : "gap-1.5"}>
			<Each of={props.items()} key="index">
				{(item) => (
					<View
						accessible
						accessibilityLabel={`${t(statusLabels[item().status])}: ${item().text}`}
						class="flex-row items-start gap-2"
					>
						<View class="mt-0.5">
							<Icon
								name={statusIcons[item().status]}
								size={14}
								color={token(statusColors[item().status])}
							/>
						</View>
						<Text
							class={
								isDone(item().status)
									? "min-w-0 flex-1 font-sans text-xs leading-snug text-muted-foreground line-through"
									: "min-w-0 flex-1 font-sans text-xs leading-snug text-foreground"
							}
						>
							{() => item().text}
						</Text>
						{() =>
							item().priority === "high" && !isDone(item().status) ? (
								<View class="shrink-0 rounded-full bg-status-danger/15 px-1.5">
									<Text class="font-sans text-[11px] font-semibold text-status-danger">
										!
									</Text>
								</View>
							) : null
						}
					</View>
				)}
			</Each>
		</View>
	);
}

import { computed, Scroll, signal, Text, token, View, windowSize } from "nsh";

import {
	buildChatTodoProgress,
	latestTurnChatTodoSource,
	type ChatTodoProgress,
	type ChatTodoTurnSource,
} from "@/lib/chat/chat-todos";

import { t } from "../app/i18n";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { ChatTodoList } from "./chat-todo-list";

type TodoSnapshot = {
	source: ChatTodoTurnSource;
	progress: ChatTodoProgress;
	fingerprint: string;
};

/** The latest turn's tasks above the composer, independent of tool rows. */
export function ChatTodoCapsule(props: {
	sessionKey: string;
	transcript: () => ChatTranscriptState;
	running: () => boolean;
}) {
	const expanded = signal(false);
	const dismissed = signal<string | null>(null);
	const snapshot = computed<TodoSnapshot | null>((previous) => {
		const { sessionKey, status, conversation, historyPrefix } =
			props.transcript();
		if (
			sessionKey !== props.sessionKey ||
			status !== "ready" ||
			!conversation
		) {
			return null;
		}
		const source = latestTurnChatTodoSource([
			historyPrefix,
			conversation.messages,
		]);
		const { turnId, items } = source;
		if (!items?.length) return null;
		// Text streaming does not change the latest successful todo tool's items.
		if (previous?.source.turnId === turnId && previous.source.items === items) {
			return previous;
		}
		return {
			source,
			progress: buildChatTodoProgress(items),
			fingerprint: JSON.stringify([turnId, items]),
		};
	});
	const visible = computed(() => {
		const todo = snapshot();
		if (
			!todo ||
			todo.fingerprint === dismissed() ||
			(todo.progress.complete && !props.running())
		) {
			return null;
		}
		return todo;
	});

	return (
		<If when={visible()}>
			{(todo) => {
				const progress = () => todo().progress;
				const complete = () => progress().complete;
				const statusIcon = computed(() => {
					if (complete())
						return { name: "CircleCheck", color: "status-success" } as const;
					if (progress().counts.inProgress > 0)
						return { name: "CircleDot", color: "foreground" } as const;
					return { name: "ListTodo", color: "muted-foreground" } as const;
				});
				const count = () =>
					`${progress().counts.completed}/${progress().counts.total}`;
				const current = () =>
					complete()
						? t("chat.todoAllCompleted")
						: (progress().current?.text ?? t("chat.todos"));
				return (
					<View
						testID="chat-todo-capsule"
						class={classNames(
							"mb-1 w-full min-w-0 shrink-0 overflow-hidden rounded-xl border bg-muted",
							complete() ? "border-status-success/30" : "border-border/70",
						)}
					>
						<View class="min-w-0 flex-row items-center gap-2 py-1 pl-3 pr-1">
							{/* React's plain toggle: no hover background, unlike a work row. */}
							<View
								role="button"
								class="min-w-0 flex-1 flex-row items-center gap-2 rounded-md py-1"
								accessibilityState={{ expanded: expanded() }}
								focusVisibleStyle={focusRingStyle(
									token("ring"),
									undefined,
									undefined,
									{ width: 2 },
								)}
								accessibilityLabel={t(
									expanded() ? "chat.todoCollapse" : "chat.todoExpand",
								)}
								accessibilityValue={{ text: `${count()} · ${current()}` }}
								onPress={() => expanded.update((value) => !value)}
							>
								<Icon
									name={statusIcon().name}
									color={token(statusIcon().color)}
								/>
								<View
									class={classNames(
										"shrink-0 rounded px-1.5 py-0.5",
										complete() ? "bg-status-success/15" : "bg-background/80",
									)}
								>
									<Text
										class={classNames(
											"font-sans text-[11px] font-medium tabular-nums",
											complete()
												? "text-status-success"
												: "text-muted-foreground",
										)}
									>
										{count}
									</Text>
								</View>
								<Text
									class={classNames(
										"min-w-0 flex-1 truncate font-sans text-xs font-medium",
										complete() ? "text-status-success" : "text-foreground/90",
									)}
								>
									{current}
								</Text>
								<Icon
									name={expanded() ? "ChevronDown" : "ChevronUp"}
									size={14}
									color={token("muted-foreground")}
								/>
							</View>
							<Button
								variant="ghost"
								size="icon"
								class="shrink-0"
								accessibilityLabel={t("chat.todoDismiss")}
								onPress={() => dismissed.set(todo().fingerprint)}
							>
								<Icon name="X" size={14} color={token("muted-foreground")} />
							</Button>
						</View>
						{() =>
							expanded() ? (
								<Scroll
									class="min-h-0 border-t border-border/60"
									contentClass="px-3 py-2"
									style={{ maxHeight: Math.min(240, windowSize().height / 4) }}
									scrollbar={{ vertical: scrollbarLook() }}
								>
									<ChatTodoList items={() => progress().items} />
								</Scroll>
							) : null
						}
					</View>
				);
			}}
		</If>
	);
}

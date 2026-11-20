import { computed, Text, token, View } from "nsh";

import type { ToolCallActivity } from "@/lib/chat/chat-activity-types";
import {
	fileBasename,
	isRecord,
	toolFilePath,
	toolPreview,
} from "@/lib/chat/chat-tool-result";
import {
	countChatTodos,
	isChatTodoTool,
	parseChatTodos,
} from "@/lib/chat/chat-todos";

import { t } from "../app/i18n";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";
import { toolIconName, toolLabel, toolSkillName } from "./chat-activity-labels";
import { ChatDisclosureRow } from "./chat-disclosure-row";
import type { ChatExpansion } from "./chat-expansion";
import { ChatToolDetail } from "./chat-tool-detail";

/**
 * One tool call: its icon, what it is and what it acted on (a file's name,
 * a command, a task count), a spinner while it runs or a mark when it
 * failed. It opens to its details, closed until the user opens it.
 */
export function ChatToolActivity(props: {
	activity: () => ToolCallActivity;
	expansion: ChatExpansion;
	expansionKey: () => string;
}) {
	const { activity } = props;
	const open = computed(() =>
		props.expansion.isOpen(props.expansionKey(), false),
	);
	const running = computed(() => activity().status === "running");
	const failed = computed(() => activity().isError === true);
	const preview = computed(() => toolPreview(activity()));
	const filePath = computed(() => toolFilePath(activity()));
	const skillName = computed(() => toolSkillName(activity(), filePath()));
	// A failed call's list did not take effect: its details show the error.
	const todos = computed(() => {
		const current = activity();
		return !current.isError && isChatTodoTool(current.toolName)
			? parseChatTodos(current.args, current.result)
			: null;
	});
	const writeContent = computed(() => {
		const { toolName, args } = activity();
		return toolName.toLowerCase() === "write" &&
			isRecord(args) &&
			typeof args.content === "string"
			? args.content
			: null;
	});
	const label = computed(() =>
		skillName() ? t("chat.skill") : toolLabel(activity().toolName),
	);
	const previewLabel = computed(() => {
		const list = todos();
		if (list) {
			return t("chat.todoProgress", {
				done: countChatTodos(list).completed,
				total: list.length,
			});
		}
		const path = filePath();
		return skillName() ?? (path ? fileBasename(path) : preview());
	});
	const hasPreview = computed(() => Boolean(previewLabel()));
	const hasDetails = computed(() => {
		const { args, result } = activity();
		return (
			todos() !== null ||
			writeContent() !== null ||
			(args !== undefined && args !== null && preview() === null) ||
			(result !== undefined && result !== null)
		);
	});
	const showDetails = computed(() => hasDetails() && open());
	const status = computed(() =>
		failed() ? "failed" : running() ? "running" : null,
	);
	return (
		<View class="w-full">
			<ChatDisclosureRow
				testID="chat-tool"
				tone={failed() ? "destructive" : "muted"}
				expanded={hasDetails() ? open() : undefined}
				disabled={!hasDetails()}
				class={open() ? "bg-hover" : undefined}
				accessibilityLabel={
					previewLabel() ? `${label()} ${previewLabel()}` : label()
				}
				tooltip={
					preview() ? (
						<Tooltip class="max-w-80" delay={300} margin={16}>
							<Text class="line-clamp-24 font-sans">
								{() => preview() ?? ""}
							</Text>
						</Tooltip>
					) : undefined
				}
				onPress={() => props.expansion.setOpen(props.expansionKey(), !open())}
			>
				{() => (
					<Icon
						name={toolIconName(activity().toolName, skillName() !== null)}
						size={14}
					/>
				)}
				<View class="min-w-0 flex-1 flex-row items-center gap-1.5">
					<Text
						class={
							failed()
								? "max-w-full shrink-0 truncate font-sans text-base font-medium leading-snug text-destructive"
								: "max-w-full shrink-0 truncate font-sans text-base font-medium leading-snug text-muted-foreground"
						}
					>
						{label}
					</Text>
					{() =>
						hasPreview() ? (
							<Text
								class="w-0 min-w-0 flex-1 truncate font-mono text-muted-foreground"
								style={{ fontSize: token("pilo-code-font-size") }}
							>
								{() => previewLabel() ?? ""}
							</Text>
						) : null
					}
				</View>
				{() =>
					status() === "failed" ? (
						<Icon name="CircleAlert" size={14} />
					) : status() === "running" ? (
						<Spinner size={14} />
					) : null
				}
			</ChatDisclosureRow>
			{() =>
				showDetails() ? (
					<ChatToolDetail
						activity={activity}
						writeContent={writeContent}
						todos={todos}
					/>
				) : null
			}
		</View>
	);
}

import type {
	AssistantActivity,
	ToolCallActivity,
} from "@shared/chat/chat-activity-types";
import type { AssistantActivitySummary } from "@shared/chat/chat-activity-state";
import { isChatTodoTool } from "@shared/chat/chat-todos";
import { formatWorkDuration } from "@shared/format-duration";

import { t } from "../app/i18n";
import type { IconName } from "../ui/icon";

/** The labels of the work a reply shows, as the WebUI words them. */

export function toolIconName(toolName: string, isSkill = false): IconName {
	if (isSkill) return "Puzzle";
	if (toolName.startsWith("mcp__")) return "Plug";
	if (isChatTodoTool(toolName)) return "ListTodo";
	switch (toolName.toLowerCase()) {
		case "codemode":
			return "CodeXml";
		case "list_mcp_resources":
		case "read_mcp_resource":
			return "Plug";
		case "bash":
		case "execute":
			return "Terminal";
		case "read":
			return "BookOpen";
		case "write":
			return "FileText";
		case "edit":
			return "PencilLine";
		case "search":
		case "grep":
		case "find":
		case "tool_search":
			return "Search";
		default:
			return "Wrench";
	}
}

export function toolLabel(toolName: string): string {
	const mcpTool = toolName.match(/^mcp__(.+?)__(.+)$/);
	if (mcpTool) return `${mcpTool[1]}/${mcpTool[2]}`;
	if (isChatTodoTool(toolName)) return t("chat.todos");
	switch (toolName.toLowerCase()) {
		case "tool_search":
			return t("chat.findTools");
		case "list_mcp_resources":
			return t("chat.listMcpResources");
		case "read_mcp_resource":
			return t("chat.readMcpResource");
		case "bash":
		case "execute":
			return t("chat.run");
		case "read":
			return t("chat.read");
		case "write":
			return t("chat.write");
		case "edit":
			return t("chat.edit");
		case "search":
		case "grep":
		case "find":
			return t("chat.search");
		default:
			return toolName;
	}
}

/** A skill a `read` of its `SKILL.md` loads, by its directory's name. */
export function toolSkillName(
	activity: ToolCallActivity,
	filePath: string | null,
): string | null {
	if (activity.toolName.toLowerCase() !== "read" || !filePath) return null;
	return (
		filePath.replace(/\\/g, "/").match(/(?:^|\/)([^/]+)\/SKILL\.md$/)?.[1] ??
		null
	);
}

export function workDurationText(durationMs: number): string {
	return formatWorkDuration(durationMs, {
		hour: t("common.hour"),
		minute: t("common.minute"),
		second: t("common.second"),
	});
}

/** What a group still running does now: its last running item. */
export function runningActivityLabel(
	activity: readonly AssistantActivity[],
): string {
	let current: AssistantActivity | undefined;
	for (let index = activity.length - 1; index >= 0; index -= 1) {
		if (activity[index].status === "running") {
			current = activity[index];
			break;
		}
	}
	if (current?.type === "tool") {
		return t("chat.workingTool", { tool: toolLabel(current.toolName) });
	}
	if (current?.type === "thinking") return t("chat.thinking");
	return t("chat.processing");
}

/** What a finished group did, as counts. */
export function activitySummaryLabel(
	summary: AssistantActivitySummary,
): string {
	const parts: string[] = [];
	if (summary.hasThought) parts.push(t("chat.thoughtProcess"));
	if (summary.readFileCount > 0) {
		parts.push(t("chat.readFiles", { count: summary.readFileCount }));
	}
	if (summary.createFileCount > 0) {
		parts.push(t("chat.createdFiles", { count: summary.createFileCount }));
	}
	if (summary.editFileCount > 0) {
		parts.push(t("chat.editedFiles", { count: summary.editFileCount }));
	}
	if (summary.commandCount > 0) {
		parts.push(t("chat.executedCommands", { count: summary.commandCount }));
	}
	return parts.join(" · ") || t("chat.completed");
}

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ParallelAgentStatus =
	| "starting"
	| "waiting"
	| "busy"
	| "stopping"
	| "stopped"
	| "failed";

export type ParallelAgentInfo = {
	id: string;
	workspaceId: string;
	name: string;
	branch: string;
	worktreePath: string;
	status: ParallelAgentStatus;
	createdAtMs: number;
};

export type ParallelAgentEvent = {
	agentId: string;
	event: { type: string; [key: string]: unknown };
};

export function listParallelAgents(
	workspaceId: string,
): Promise<ParallelAgentInfo[]> {
	return invoke("parallel_agent_list", { workspaceId });
}

export function createParallelAgent(
	workspaceId: string,
	name: string,
	prompt?: string,
): Promise<ParallelAgentInfo> {
	return invoke("parallel_agent_create", {
		workspaceId,
		name,
		prompt: prompt?.trim() || null,
	});
}

export function sendParallelAgent(
	agentId: string,
	message: string,
): Promise<void> {
	return invoke("parallel_agent_send", { agentId, message });
}

export function stopParallelAgent(agentId: string): Promise<void> {
	return invoke("parallel_agent_stop", { agentId });
}

export function removeParallelAgent(
	workspaceId: string,
	agentId: string,
): Promise<void> {
	return invoke("parallel_agent_remove", { workspaceId, agentId });
}

export function listenParallelAgentEvents(
	handler: (event: ParallelAgentEvent) => void,
): Promise<UnlistenFn> {
	return listen<ParallelAgentEvent>("pilo://parallel-agent", (event) =>
		handler(event.payload),
	);
}

import { useCallback, useEffect, useMemo, useState } from "react";
import {
	Bot,
	GitBranch,
	LoaderCircle,
	Play,
	Send,
	Square,
	Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
	createParallelAgent,
	listenParallelAgentEvents,
	listParallelAgents,
	removeParallelAgent,
	sendParallelAgent,
	stopParallelAgent,
	type ParallelAgentInfo,
	type ParallelAgentStatus,
} from "@/lib/parallel";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/projects";
import { Button, EmptyState, Input, Textarea } from "@/ui";

function statusLabel(status: ParallelAgentStatus) {
	switch (status) {
		case "starting":
			return "启动中";
		case "busy":
			return "工作中";
		case "waiting":
			return "等待";
		case "stopping":
			return "停止中";
		case "stopped":
			return "已停止";
		case "failed":
			return "失败";
	}
}

function statusDot(status: ParallelAgentStatus) {
	return cn(
		"size-2 rounded-full",
		status === "busy" && "bg-primary",
		status === "waiting" && "bg-foreground/55",
		(status === "starting" || status === "stopping") &&
			"bg-muted-foreground animate-pulse",
		status === "stopped" && "bg-muted-foreground/40",
		status === "failed" && "bg-destructive",
	);
}

export function ParallelAgentsPanel({ project }: { project: Project }) {
	const [agents, setAgents] = useState<ParallelAgentInfo[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [initialPrompt, setInitialPrompt] = useState("");
	const [message, setMessage] = useState("");
	const [creating, setCreating] = useState(false);
	const [acting, setActing] = useState(false);

	const refresh = useCallback(async () => {
		try {
			const next = await listParallelAgents(project.id);
			setAgents(next);
		} catch (error) {
			console.error("Failed to list parallel agents", error);
		}
	}, [project.id]);

	useEffect(() => {
		const timer = window.setTimeout(() => void refresh(), 0);
		let unlisten: (() => void) | undefined;
		void listenParallelAgentEvents((event) => {
			if (
				event.event.type === "process_state" ||
				event.event.type === "assistant_message_start" ||
				event.event.type === "assistant_message_end" ||
				event.event.type === "runtime_error"
			) {
				void refresh();
			}
		})
			.then((value) => {
				unlisten = value;
			})
			.catch((error) =>
				console.error("Failed to listen for parallel agents", error),
			);
		return () => {
			window.clearTimeout(timer);
			unlisten?.();
		};
	}, [refresh]);

	const selected = useMemo(
		() => agents.find((agent) => agent.id === selectedId) ?? agents[0] ?? null,
		[agents, selectedId],
	);

	const create = useCallback(async () => {
		const trimmedName = name.trim() || `Task ${agents.length + 1}`;
		setCreating(true);
		try {
			const agent = await createParallelAgent(
				project.id,
				trimmedName,
				initialPrompt.trim() || undefined,
			);
			setAgents((current) => [...current, agent]);
			setSelectedId(agent.id);
			setName("");
			setInitialPrompt("");
		} catch (error) {
			toast.error("无法创建并行 Agent", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setCreating(false);
		}
	}, [agents.length, initialPrompt, name, project.id]);

	const send = useCallback(async () => {
		if (!selected || !message.trim()) return;
		setActing(true);
		try {
			await sendParallelAgent(selected.id, message.trim());
			setMessage("");
			await refresh();
		} catch (error) {
			toast.error("发送失败", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setActing(false);
		}
	}, [message, refresh, selected]);

	const stop = useCallback(async () => {
		if (!selected) return;
		setActing(true);
		try {
			await stopParallelAgent(selected.id);
			await refresh();
		} catch (error) {
			toast.error("停止 Agent 失败", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setActing(false);
		}
	}, [refresh, selected]);

	const remove = useCallback(async () => {
		if (!selected) return;
		if (
			!window.confirm(
				`清理 ${selected.name} 的 worktree 和分支？未提交修改会被删除。`,
			)
		) {
			return;
		}
		setActing(true);
		try {
			await removeParallelAgent(project.id, selected.id);
			setSelectedId(null);
			await refresh();
		} catch (error) {
			toast.error("清理 Agent 失败", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setActing(false);
		}
	}, [refresh, selected, project.id]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="grid shrink-0 gap-2 border-b border-sidebar-border p-2">
				<Input
					value={name}
					onChange={(event) => setName(event.target.value)}
					placeholder="任务名称"
					className="h-7 text-xs"
				/>
				<Textarea
					value={initialPrompt}
					onChange={(event) => setInitialPrompt(event.target.value)}
					placeholder="初始指令（可选）"
					className="min-h-16 resize-none text-xs"
				/>
				<Button
					size="sm"
					className="h-7 gap-1.5 text-xs"
					disabled={creating}
					onClick={() => void create()}
				>
					{creating ? (
						<LoaderCircle className="size-3.5 animate-spin" />
					) : (
						<Play className="size-3.5" />
					)}
					创建独立 Worktree Agent
				</Button>
			</div>

			<div className="scrollbar-pro min-h-0 flex-1 overflow-y-auto p-1.5">
				{agents.length === 0 ? (
					<EmptyState
						variant="compact"
						title="没有并行任务"
						description="每个 Agent 会使用独立 Git worktree 和 Pi 进程。"
					/>
				) : (
					<ul className="grid gap-1">
						{agents.map((agent) => (
							<li key={agent.id}>
								<button
									type="button"
									className={cn(
										"w-full rounded-md border border-transparent p-2 text-left transition-colors hover:bg-sidebar-accent",
										selected?.id === agent.id &&
											"border-border bg-sidebar-accent",
									)}
									onClick={() => setSelectedId(agent.id)}
								>
									<div className="flex items-center gap-2">
										<Bot className="size-3.5 shrink-0 text-muted-foreground" />
										<span className="min-w-0 flex-1 truncate text-xs font-medium">
											{agent.name}
										</span>
										<span className={statusDot(agent.status)} />
										<span className="text-[10px] text-muted-foreground">
											{statusLabel(agent.status)}
										</span>
									</div>
									<div className="mt-1.5 flex items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
										<GitBranch className="size-3 shrink-0" />
										<span className="truncate">{agent.branch}</span>
									</div>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			{selected ? (
				<div className="grid shrink-0 gap-2 border-t border-sidebar-border p-2">
					<div
						className="truncate font-mono text-[10px] text-muted-foreground"
						title={selected.worktreePath}
					>
						{selected.worktreePath}
					</div>
					<Textarea
						value={message}
						onChange={(event) => setMessage(event.target.value)}
						placeholder="继续给当前 Agent 指令"
						className="min-h-14 resize-none text-xs"
						disabled={
							selected.status === "stopped" || selected.status === "failed"
						}
					/>
					<div className="flex gap-1.5">
						<Button
							size="sm"
							className="h-7 flex-1 gap-1.5 text-xs"
							disabled={
								acting ||
								!message.trim() ||
								selected.status === "stopped" ||
								selected.status === "failed"
							}
							onClick={() => void send()}
						>
							<Send className="size-3.5" />
							发送
						</Button>
						<Button
							variant="outline"
							size="icon"
							className="size-7"
							disabled={acting || selected.status === "stopped"}
							onClick={() => void stop()}
							aria-label="停止 Agent"
						>
							<Square className="size-3.5" />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							className="size-7 text-destructive"
							disabled={acting}
							onClick={() => void remove()}
							aria-label="清理 Worktree"
						>
							<Trash2 className="size-3.5" />
						</Button>
					</div>
				</div>
			) : null}
		</div>
	);
}

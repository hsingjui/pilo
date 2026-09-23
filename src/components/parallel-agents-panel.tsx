import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Bot, GitBranch, Play, Send, Square, Trash2 } from "lucide-react";
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
import { userErrorMessage } from "@/lib/app-error";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/projects";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	EmptyState,
	Input,
	Textarea,
	Hint,
	Spinner,
} from "@/ui";

function statusLabel(t: TFunction, status: ParallelAgentStatus) {
	switch (status) {
		case "starting":
			return t("parallel.starting");
		case "busy":
			return t("parallel.working");
		case "waiting":
			return t("parallel.waiting");
		case "stopping":
			return t("parallel.stopping");
		case "stopped":
			return t("parallel.stopped");
		case "failed":
			return t("parallel.failed");
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
	const { t } = useTranslation();
	const [agents, setAgents] = useState<ParallelAgentInfo[]>([]);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [initialPrompt, setInitialPrompt] = useState("");
	const [message, setMessage] = useState("");
	const [creating, setCreating] = useState(false);
	const [acting, setActing] = useState(false);
	const [confirmingRemove, setConfirmingRemove] = useState(false);

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
			toast.error(t("parallel.createFailed"), {
				description: userErrorMessage(error),
			});
		} finally {
			setCreating(false);
		}
	}, [agents.length, initialPrompt, name, project.id, t]);

	const send = useCallback(async () => {
		if (!selected || !message.trim()) return;
		setActing(true);
		try {
			await sendParallelAgent(selected.id, message.trim());
			setMessage("");
			await refresh();
		} catch (error) {
			toast.error(t("parallel.sendFailed"), {
				description: userErrorMessage(error),
			});
		} finally {
			setActing(false);
		}
	}, [message, refresh, selected, t]);

	const stop = useCallback(async () => {
		if (!selected) return;
		setActing(true);
		try {
			await stopParallelAgent(selected.id);
			await refresh();
		} catch (error) {
			toast.error(t("parallel.stopFailed"), {
				description: userErrorMessage(error),
			});
		} finally {
			setActing(false);
		}
	}, [refresh, selected, t]);

	const remove = useCallback(async () => {
		if (!selected) return;
		setActing(true);
		try {
			await removeParallelAgent(project.id, selected.id);
			setSelectedId(null);
			await refresh();
		} catch (error) {
			toast.error(t("parallel.cleanupFailed"), {
				description: userErrorMessage(error),
			});
		} finally {
			setActing(false);
		}
	}, [refresh, selected, project.id, t]);

	return (
		<>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="grid shrink-0 gap-2 border-b border-sidebar-border p-2">
					<Input
						value={name}
						onChange={(event) => setName(event.target.value)}
						placeholder={t("parallel.taskName")}
						aria-label={t("parallel.taskName")}
						className="h-7 text-xs"
					/>
					<Textarea
						value={initialPrompt}
						onChange={(event) => setInitialPrompt(event.target.value)}
						placeholder={t("parallel.initialPrompt")}
						aria-label={t("parallel.initialPrompt")}
						className="min-h-16 resize-none text-xs"
					/>
					<Button
						size="sm"
						className="h-7 gap-1.5 text-xs"
						disabled={creating}
						onClick={() => void create()}
					>
						{creating ? (
							<Spinner className="size-3.5" />
						) : (
							<Play className="size-3.5" />
						)}
						{t("parallel.create")}
					</Button>
				</div>

				<div className="scrollbar-pro min-h-0 flex-1 overflow-y-auto p-1.5">
					{agents.length === 0 ? (
						<EmptyState
							variant="compact"
							title={t("parallel.empty")}
							description={t("parallel.emptyDescription")}
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
											<span className="text-2xs text-muted-foreground">
												{statusLabel(t, agent.status)}
											</span>
										</div>
										<div className="mt-1.5 flex items-center gap-1 truncate font-mono text-2xs text-muted-foreground">
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
						<Hint label={selected.worktreePath}>
							<div className="truncate font-mono text-2xs text-muted-foreground">
								{selected.worktreePath}
							</div>
						</Hint>
						<Textarea
							value={message}
							onChange={(event) => setMessage(event.target.value)}
							placeholder={t("parallel.continuePrompt")}
							aria-label={t("parallel.continuePrompt")}
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
								{t("parallel.send")}
							</Button>
							<Button
								variant="outline"
								size="icon"
								className="size-7"
								disabled={acting || selected.status === "stopped"}
								onClick={() => void stop()}
								aria-label={t("parallel.stop")}
							>
								<Square className="size-3.5" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								className="size-7 text-destructive"
								disabled={acting}
								onClick={() => setConfirmingRemove(true)}
								aria-label={t("parallel.cleanup")}
							>
								<Trash2 className="size-3.5" />
							</Button>
						</div>
					</div>
				) : null}
			</div>

			<Dialog
				open={confirmingRemove}
				onOpenChange={(open) => {
					if (!acting) setConfirmingRemove(open);
				}}
			>
				<DialogContent className="w-[min(400px,calc(100vw-2rem))] max-w-none gap-0 overflow-hidden p-0 sm:p-0">
					<DialogHeader className="px-5 pb-3 pt-4 text-left">
						<DialogTitle className="text-sm font-semibold">
							{t("parallel.cleanupQuestion")}
						</DialogTitle>
						<DialogDescription className="text-xs leading-relaxed">
							{t("parallel.delete", { name: selected?.name })}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="border-t border-border/60 px-5 py-3 sm:gap-2">
						<Button
							variant="ghost"
							size="sm"
							className="h-8 px-3 text-xs"
							disabled={acting}
							onClick={() => setConfirmingRemove(false)}
						>
							{t("common.cancel")}
						</Button>
						<Button
							variant="destructive"
							size="sm"
							className="h-8 px-3 text-xs"
							disabled={acting}
							onClick={() => {
								setConfirmingRemove(false);
								void remove();
							}}
						>
							{t("parallel.cleanup")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

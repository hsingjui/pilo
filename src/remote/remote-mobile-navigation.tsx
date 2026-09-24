import { useMemo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, RefreshCw, SquarePen, Wifi, WifiOff, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { Project } from "@/lib/projects";
import type { SessionIndexEntry } from "@/lib/sessions";
import { cn } from "@/lib/utils";

function sessionLabel(session: SessionIndexEntry) {
	return (
		session.titleOverride ||
		session.name ||
		session.firstUserMessagePreview ||
		"Untitled session"
	);
}

function sessionTimestamp(session: SessionIndexEntry) {
	const value = session.lastMessageAt || session.updatedAt;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return "";
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(timestamp));
}

export function RemoteMobileNavigation({
	open,
	onOpenChange,
	projects,
	sessions,
	activeProjectId,
	selectedSessionId,
	connected,
	refreshingProjectIds,
	onSelectSession,
	onNewChat,
	onRefreshProjectSessions,
	onReload,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projects: readonly Project[];
	sessions: readonly SessionIndexEntry[];
	activeProjectId: string | null;
	selectedSessionId: string | null;
	connected: boolean;
	refreshingProjectIds: ReadonlySet<string>;
	onSelectSession: (sessionId: string) => void;
	onNewChat: (projectId?: string) => void;
	onRefreshProjectSessions: (projectId: string) => void;
	onReload: () => void;
}) {
	const { t } = useTranslation();
	const [selectedProjectId, setSelectedProjectId] = useState("");
	const viewProjectId =
		selectedProjectId || activeProjectId || projects[0]?.id || "";

	const projectSessions = useMemo(() => {
		const matching = sessions.filter(
			(session) => session.projectId === viewProjectId,
		);
		// Target lib is ES2022, so Array#toSorted is unavailable here.
		// oxlint-disable-next-line unicorn/no-array-sort -- sorting a fresh filtered array is non-mutating relative to props.
		return matching.sort(
			(a, b) =>
				Date.parse(b.lastMessageAt || b.updatedAt) -
				Date.parse(a.lastMessageAt || a.updatedAt),
		);
	}, [sessions, viewProjectId]);
	const activeProject =
		projects.find((project) => project.id === viewProjectId) ?? null;
	const refreshing = activeProject
		? refreshingProjectIds.has(activeProject.id)
		: false;

	return (
		<DialogPrimitive.Root
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) setSelectedProjectId("");
				onOpenChange(nextOpen);
			}}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-dialog-overlay)] bg-black/40 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
				<DialogPrimitive.Content
					className={cn(
						"fixed inset-y-0 left-0 z-[var(--z-dialog)] flex w-[min(88vw,22rem)] flex-col",
						"border-r border-border/80 bg-background shadow-popover outline-none",
						"pb-[max(.5rem,env(safe-area-inset-bottom))] pt-[env(safe-area-inset-top)]",
						"data-[state=open]:animate-in data-[state=open]:slide-in-from-left-4",
						"data-[state=closed]:animate-out data-[state=closed]:slide-out-to-left-4",
					)}
				>
					<div className="flex h-14 shrink-0 items-center gap-3 px-3">
						<DialogPrimitive.Title className="min-w-0 flex-1 truncate text-base font-semibold">
							Pilo
						</DialogPrimitive.Title>
						<DialogPrimitive.Description className="sr-only">
							{t("common.sessions")}
						</DialogPrimitive.Description>
						<DialogPrimitive.Close
							className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-muted"
							aria-label={t("common.close")}
						>
							<X className="size-5" />
						</DialogPrimitive.Close>
					</div>

					<div className="shrink-0 px-3 pb-2">
						<button
							type="button"
							disabled={!activeProject}
							className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm font-medium transition-colors active:bg-muted disabled:opacity-50"
							onClick={() => {
								onNewChat(activeProject?.id);
								setSelectedProjectId("");
								onOpenChange(false);
							}}
						>
							<SquarePen className="size-4.5 shrink-0" />
							<span>{t("sidebar.newSession")}</span>
						</button>
					</div>

					<div className="shrink-0 border-y border-border/60 py-2">
						<div className="px-4 pb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
							{t("sidebar.projects")}
						</div>
						<div className="flex gap-1.5 overflow-x-auto px-3 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
							{projects.map((project) => {
								const selected = project.id === viewProjectId;
								return (
									<button
										key={project.id}
										type="button"
										aria-pressed={selected}
										className={cn(
											"flex min-h-10 max-w-56 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-sm transition-colors",
											selected
												? "border-foreground/10 bg-muted text-foreground"
												: "border-transparent text-muted-foreground active:bg-muted/70",
										)}
										onClick={() => {
											setSelectedProjectId(project.id);
											onRefreshProjectSessions(project.id);
										}}
									>
										<span className="size-2.5 shrink-0 rounded-[4px] bg-muted-foreground/50" />
										<span className="min-w-0 truncate">{project.name}</span>
										{selected ? <Check className="size-3.5 shrink-0" /> : null}
									</button>
								);
							})}
						</div>
					</div>

					<div className="flex min-h-0 flex-1 flex-col">
						<div className="flex h-11 shrink-0 items-center gap-2 px-4">
							<span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
								{activeProject?.name || t("common.sessions")}
							</span>
							<button
								type="button"
								disabled={!activeProject || refreshing}
								className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-muted disabled:opacity-50"
								aria-label={t("sidebar.refreshSessions")}
								onClick={() => {
									if (activeProject) onRefreshProjectSessions(activeProject.id);
								}}
							>
								<RefreshCw
									className={cn("size-4", refreshing && "animate-spin")}
								/>
							</button>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
							{projectSessions.length === 0 ? (
								<div className="px-3 py-10 text-center text-sm text-muted-foreground">
									{t("sidebar.noSessions")}
								</div>
							) : (
								<div className="space-y-0.5">
									{projectSessions.map((session) => {
										const selected = session.piSessionId === selectedSessionId;
										return (
											<button
												key={session.sessionPath}
												type="button"
												className={cn(
													"flex min-h-12 w-full items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors",
													selected
														? "bg-muted text-foreground"
														: "text-foreground/85 active:bg-muted/70",
												)}
												onClick={() => {
													onSelectSession(session.piSessionId);
													onOpenChange(false);
												}}
											>
												<span className="min-w-0 flex-1">
													<span className="block truncate text-sm">
														{sessionLabel(session)}
													</span>
													<span className="mt-0.5 block truncate text-2xs text-muted-foreground">
														{sessionTimestamp(session)}
													</span>
												</span>
												{selected ? (
													<Check className="size-4 shrink-0" />
												) : null}
											</button>
										);
									})}
								</div>
							)}
						</div>
					</div>

					<div className="flex min-h-12 shrink-0 items-center gap-2 border-t border-border/60 px-3">
						{connected ? (
							<Wifi className="size-4 shrink-0 text-muted-foreground" />
						) : (
							<WifiOff className="size-4 shrink-0 text-muted-foreground" />
						)}
						<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
							{connected
								? t("settings.remoteConnected")
								: t("settings.remoteReconnecting")}
						</span>
						<button
							type="button"
							className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors active:bg-muted"
							aria-label={t("app.reload")}
							onClick={onReload}
						>
							<RefreshCw className="size-4" />
						</button>
					</div>
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

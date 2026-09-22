import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronLeft, Folder, FolderOpen, Search } from "lucide-react";
import { toast } from "sonner";

import { userErrorMessage } from "@/lib/app-error";
import type { FsEntry } from "@/lib/files";
import { refreshProjectPiModels } from "@/lib/pi-models";
import type { Connection } from "@/lib/pi-runtime";
import {
	addProject,
	notifyProjectsChanged,
	readConnectionDir,
} from "@/lib/projects";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Input,
} from "@/ui";

function absoluteRemotePath(path: string) {
	const trimmed = path.trim();
	if (!trimmed || trimmed === "/") return "/";
	return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function parentRemotePath(path: string) {
	const normalized = absoluteRemotePath(path);
	if (normalized === "/") return "/";
	const parts = normalized.split("/").filter(Boolean);
	parts.pop();
	return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function AddProjectDialog({
	open,
	onOpenChange,
	connection,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	connection: Connection | null;
}) {
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [browserOpen, setBrowserOpen] = useState(false);
	const [browserPath, setBrowserPath] = useState("/");
	const [entries, setEntries] = useState<FsEntry[]>([]);
	const [filter, setFilter] = useState("");
	const [loadingEntries, setLoadingEntries] = useState(false);
	const { t } = useTranslation();

	const directories = useMemo(() => {
		const query = filter.trim().toLocaleLowerCase();
		return entries.filter(
			(entry) =>
				entry.kind === "directory" &&
				(!query || entry.name.toLocaleLowerCase().includes(query)),
		);
	}, [entries, filter]);

	const add = useCallback(
		async (projectPath: string) => {
			if (!connection || !projectPath.trim()) return;
			setBusy(true);
			try {
				const project = await addProject(connection.id, projectPath.trim());
				void refreshProjectPiModels(project.id).catch((error) => {
					console.warn(
						"Failed to refresh Pi models after adding project",
						error,
					);
				});
				notifyProjectsChanged();
				toast.success(t("project.added", { name: project.name }), {
					description: t("project.addedDescription", {
						connection: project.connection.name,
						path: project.metadata.cwd,
					}),
				});
				onOpenChange(false);
			} catch (error) {
				toast.error(t("project.addFailed"), {
					description: userErrorMessage(error),
				});
			} finally {
				setBusy(false);
			}
		},
		[connection, onOpenChange, t],
	);

	const loadDirectory = async (nextPath: string) => {
		if (!connection || connection.kind.type === "local") return;
		const normalized = absoluteRemotePath(nextPath);
		setLoadingEntries(true);
		try {
			setEntries(await readConnectionDir(connection.id, normalized));
			setBrowserPath(normalized);
			setFilter("");
		} catch (error) {
			toast.error(t("project.readDirectoryFailed"), {
				description: userErrorMessage(error),
			});
		} finally {
			setLoadingEntries(false);
		}
	};

	const openBrowser = () => {
		if (browserOpen) {
			setBrowserOpen(false);
			return;
		}
		setBrowserOpen(true);
		void loadDirectory("/");
	};

	if (!connection || connection.kind.type === "local") return null;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-xl gap-5">
				<DialogHeader>
					<DialogTitle>{t("project.addTitle")}</DialogTitle>
					<DialogDescription>
						{t("project.remoteDirectory", { connection: connection.name })}
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-3">
					<div className="grid gap-1.5">
						<label
							htmlFor="project-path"
							className="text-xs font-medium text-muted-foreground"
						>
							{t("project.projectDirectory")}
						</label>
						<div className="flex gap-2">
							<Input
								id="project-path"
								value={path}
								onChange={(event) => setPath(event.target.value)}
								placeholder="/root/code/project"
								onKeyDown={(event) => {
									if (event.key === "Enter" && path.trim() && !busy) {
										void add(path);
									}
								}}
							/>
							<Button
								variant="outline"
								size="icon"
								aria-label={t("project.browseRemote")}
								onClick={openBrowser}
							>
								<FolderOpen className="h-4 w-4" />
							</Button>
							<Button
								disabled={busy || !path.trim()}
								onClick={() => void add(path)}
							>
								{busy ? t("common.adding") : t("common.add")}
							</Button>
						</div>
					</div>

					{browserOpen ? (
						<div className="overflow-hidden rounded-lg border bg-muted/10">
							<div className="flex items-center gap-2 border-b p-2">
								<Button
									variant="ghost"
									size="icon"
									disabled={browserPath === "/" || loadingEntries}
									onClick={() =>
										void loadDirectory(parentRemotePath(browserPath))
									}
								>
									<ChevronLeft className="h-4 w-4" />
								</Button>
								<div className="min-w-0 flex-1 truncate font-mono text-xs">
									{browserPath}
								</div>
								<Button
									size="sm"
									variant="secondary"
									onClick={() => {
										setPath(browserPath);
										setBrowserOpen(false);
									}}
								>
									{t("project.selectCurrentDirectory")}
								</Button>
							</div>
							<div className="border-b p-2">
								<div className="relative">
									<Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
									<Input
										value={filter}
										onChange={(event) => setFilter(event.target.value)}
										placeholder={t("project.filterFolders")}
										className="h-8 pl-7"
									/>
								</div>
							</div>
							<div className="max-h-72 overflow-y-auto p-1">
								{loadingEntries ? (
									<div className="px-3 py-6 text-center text-xs text-muted-foreground">
										{t("common.loading")}
									</div>
								) : directories.length === 0 ? (
									<div className="px-3 py-6 text-center text-xs text-muted-foreground">
										{filter.trim()
											? t("project.noMatchingFolders", {
													query: filter.trim(),
												})
											: t("project.noFolders")}
									</div>
								) : (
									directories.map((entry) => {
										const entryPath = absoluteRemotePath(entry.path);
										return (
											<button
												type="button"
												key={entry.path}
												className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted/50"
												onClick={() => void loadDirectory(entryPath)}
											>
												<Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
												<span className="min-w-0 flex-1 truncate">
													{entry.name}
												</span>
											</button>
										);
									})
								)}
							</div>
						</div>
					) : null}
				</div>
			</DialogContent>
		</Dialog>
	);
}

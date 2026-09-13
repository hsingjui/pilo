import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";

import { listWslConnections, type WslConnectionInfo } from "@/lib/connections";
import { refreshProjectPiModels } from "@/lib/pi-models";
import type { Connection } from "@/lib/pi-runtime";
import {
	addProject,
	discoverProjects,
	localConnection,
	notifyProjectsChanged,
	wslConnection,
	type DiscoveredProject,
} from "@/lib/projects";
import {
	listSshConnections,
	type SshConnectionInfo,
} from "@/lib/ssh-connections";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	Input,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/ui";

type ConnectionMode = "local" | "wsl" | "ssh";

function initialConnectionState(connectionId?: string | null) {
	if (connectionId?.startsWith("wsl:")) {
		return {
			mode: "wsl" as const,
			distro: connectionId.slice(4),
			sshConnectionId: "",
		};
	}
	if (connectionId?.startsWith("ssh:")) {
		return {
			mode: "ssh" as const,
			distro: "Debian",
			sshConnectionId: connectionId,
		};
	}
	return { mode: "local" as const, distro: "Debian", sshConnectionId: "" };
}

function connectionFor(
	mode: ConnectionMode,
	distro: string,
	sshConnectionId: string,
	sshConnections: SshConnectionInfo[],
): Connection | null {
	switch (mode) {
		case "local":
			return localConnection();
		case "wsl":
			return distro.trim() ? wslConnection(distro.trim()) : null;
		case "ssh":
			return (
				sshConnections.find((item) => item.connection.id === sshConnectionId)
					?.connection ?? null
			);
	}
}

export function AddProjectDialog({
	open,
	onOpenChange,
	initialConnectionId,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initialConnectionId?: string | null;
}) {
	const [initial] = useState(() => initialConnectionState(initialConnectionId));
	const [mode, setMode] = useState<ConnectionMode>(initial.mode);
	const [distro, setDistro] = useState(initial.distro);
	const [sshConnectionId, setSshConnectionId] = useState(
		initial.sshConnectionId,
	);
	const [sshConnections, setSshConnections] = useState<SshConnectionInfo[]>([]);
	const [wslConnections, setWslConnections] = useState<WslConnectionInfo[]>([]);
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [discovered, setDiscovered] = useState<DiscoveredProject[]>([]);

	const connection = connectionFor(
		mode,
		distro,
		sshConnectionId,
		sshConnections,
	);

	useEffect(() => {
		if (!open) return;
		void Promise.allSettled([listSshConnections(), listWslConnections()]).then(
			([sshResult, wslResult]) => {
				if (sshResult.status === "fulfilled") {
					setSshConnections(sshResult.value);
					setSshConnectionId(
						(current) => current || sshResult.value[0]?.connection.id || "",
					);
				}
				if (wslResult.status === "fulfilled") {
					setWslConnections(wslResult.value);
					setDistro((current) => {
						if (
							wslResult.value.some(
								(item) =>
									item.connection.kind.type === "wsl" &&
									item.connection.kind.distro === current,
							)
						) {
							return current;
						}
						const first = wslResult.value[0]?.connection;
						return first?.kind.type === "wsl" ? first.kind.distro : current;
					});
				}
			},
		);
	}, [open]);

	const add = async (projectPath: string) => {
		if (!connection || !projectPath.trim()) return;
		setBusy(true);
		try {
			const project = await addProject(connection, projectPath.trim());
			void refreshProjectPiModels(project.id).catch((error) => {
				console.warn("Failed to refresh Pi models after adding project", error);
			});
			notifyProjectsChanged();
			toast.success(`已添加 ${project.name}`, {
				description: `${project.connection.name} · ${project.metadata.cwd}`,
			});
			onOpenChange(false);
		} catch (error) {
			toast.error("添加项目失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const discover = async () => {
		if (!connection) return;
		setBusy(true);
		try {
			setDiscovered(await discoverProjects(connection));
		} catch (error) {
			setDiscovered([]);
			toast.error("发现项目失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-xl gap-5">
				<DialogHeader>
					<DialogTitle>添加项目</DialogTitle>
					<DialogDescription>
						选择 Pi 运行环境和项目目录。添加时会探测 cwd、Git branch 与 Pi
						version。
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4">
					<div className="grid gap-1.5">
						<label
							htmlFor="project-connection"
							className="text-xs font-medium text-muted-foreground"
						>
							Connection
						</label>
						<Select
							value={mode}
							onValueChange={(value) => {
								setMode(value as ConnectionMode);
								setDiscovered([]);
							}}
						>
							<SelectTrigger id="project-connection">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="local">Local</SelectItem>
								<SelectItem value="wsl">WSL</SelectItem>
								<SelectItem value="ssh">SSH</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{mode === "wsl" ? (
						<div className="grid gap-1.5">
							<label
								htmlFor="project-wsl-distro"
								className="text-xs font-medium text-muted-foreground"
							>
								WSL 发行版
							</label>
							<Select value={distro} onValueChange={setDistro}>
								<SelectTrigger id="project-wsl-distro">
									<SelectValue placeholder="选择 WSL 发行版" />
								</SelectTrigger>
								<SelectContent>
									{wslConnections.map((item) => {
										if (item.connection.kind.type !== "wsl") return null;
										return (
											<SelectItem
												key={item.connection.id}
												value={item.connection.kind.distro}
											>
												{item.connection.kind.distro}
											</SelectItem>
										);
									})}
								</SelectContent>
							</Select>
						</div>
					) : null}

					{mode === "ssh" ? (
						<div className="grid gap-1.5">
							<label
								htmlFor="project-ssh-connection"
								className="text-xs font-medium text-muted-foreground"
							>
								SSH 连接
							</label>
							{sshConnections.length > 0 ? (
								<Select
									value={sshConnectionId}
									onValueChange={(value) => {
										setSshConnectionId(value);
										setDiscovered([]);
									}}
								>
									<SelectTrigger id="project-ssh-connection">
										<SelectValue placeholder="选择 SSH 连接" />
									</SelectTrigger>
									<SelectContent>
										{sshConnections.map((item) => (
											<SelectItem
												key={item.connection.id}
												value={item.connection.id}
											>
												{item.connection.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
									请先在“设置 → 连接”中添加 SSH 连接。
								</p>
							)}
						</div>
					) : null}

					<div className="grid gap-1.5">
						<label
							htmlFor="project-path"
							className="text-xs font-medium text-muted-foreground"
						>
							项目目录
						</label>
						<div className="flex gap-2">
							<Input
								id="project-path"
								value={path}
								onChange={(event) => setPath(event.target.value)}
								placeholder={
									mode === "local" ? "C:\\Code\\project" : "/root/code/project"
								}
								onKeyDown={(event) => {
									if (
										event.key === "Enter" &&
										path.trim() &&
										connection &&
										!busy
									) {
										void add(path);
									}
								}}
							/>
							<Button
								disabled={busy || !connection || !path.trim()}
								onClick={() => void add(path)}
							>
								添加
							</Button>
						</div>
					</div>

					<div className="border-t pt-4">
						<div className="mb-2 flex items-center justify-between gap-3">
							<div>
								<div className="text-sm font-medium">发现已有 Pi 项目</div>
								<div className="text-xs text-muted-foreground">
									从 Session header 读取真实 cwd。
								</div>
							</div>
							<Button
								variant="outline"
								size="sm"
								disabled={busy || !connection}
								onClick={() => void discover()}
							>
								<Search className="h-3.5 w-3.5" />
								{busy ? "扫描中…" : "扫描"}
							</Button>
						</div>

						{discovered.length > 0 ? (
							<div className="max-h-52 space-y-1 overflow-y-auto rounded-md border p-1">
								{discovered.map((project) => (
									<div
										key={project.path}
										className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40"
									>
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm font-medium">
												{project.name}
											</div>
											<div className="truncate font-mono text-[11px] text-muted-foreground">
												{project.path}
											</div>
										</div>
										<Button
											size="sm"
											variant="outline"
											disabled={busy || project.alreadyAdded}
											onClick={() => void add(project.path)}
										>
											{project.alreadyAdded ? "已添加" : "添加"}
										</Button>
									</div>
								))}
							</div>
						) : null}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

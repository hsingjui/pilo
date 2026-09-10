import { useState } from "react";
import { Search } from "lucide-react";
import { toast } from "sonner";

import type { Connection } from "@/lib/pi-runtime";
import {
	addWorkspace,
	discoverWorkspaces,
	localConnection,
	notifyWorkspacesChanged,
	sshConfigConnection,
	wslConnection,
	type DiscoveredWorkspace,
} from "@/lib/workspaces";
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
		return { mode: "wsl" as const, distro: connectionId.slice(4), host: "" };
	}
	if (connectionId?.startsWith("ssh:config:")) {
		return {
			mode: "ssh" as const,
			distro: "Debian",
			host: connectionId.slice(11),
		};
	}
	return { mode: "local" as const, distro: "Debian", host: "" };
}

function connectionFor(
	mode: ConnectionMode,
	distro: string,
	host: string,
): Connection | null {
	switch (mode) {
		case "local":
			return localConnection();
		case "wsl":
			return distro.trim() ? wslConnection(distro.trim()) : null;
		case "ssh":
			return host.trim() ? sshConfigConnection(host.trim()) : null;
	}
}

export function AddWorkspaceDialog({
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
	const [host, setHost] = useState(initial.host);
	const [path, setPath] = useState("");
	const [busy, setBusy] = useState(false);
	const [discovered, setDiscovered] = useState<DiscoveredWorkspace[]>([]);

	const connection = connectionFor(mode, distro, host);

	const add = async (workspacePath: string) => {
		if (!connection || !workspacePath.trim()) return;
		setBusy(true);
		try {
			const workspace = await addWorkspace(connection, workspacePath.trim());
			notifyWorkspacesChanged();
			toast.success(`已添加 ${workspace.name}`, {
				description: `${workspace.connection.name} · ${workspace.metadata.cwd}`,
			});
			onOpenChange(false);
		} catch (error) {
			toast.error("添加工作区失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const discover = async () => {
		if (!connection) return;
		setBusy(true);
		try {
			setDiscovered(await discoverWorkspaces(connection));
		} catch (error) {
			setDiscovered([]);
			toast.error("发现工作区失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-xl gap-5">
				<DialogHeader>
					<DialogTitle>添加工作区</DialogTitle>
					<DialogDescription>
						选择 Pi 运行环境和项目目录。添加时会探测 cwd、Git branch 与 Pi
						version。
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4">
					<div className="grid gap-1.5">
						<label
							htmlFor="workspace-connection"
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
							<SelectTrigger id="workspace-connection">
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
								htmlFor="workspace-wsl-distro"
								className="text-xs font-medium text-muted-foreground"
							>
								WSL 发行版
							</label>
							<Input
								id="workspace-wsl-distro"
								value={distro}
								onChange={(event) => setDistro(event.target.value)}
								placeholder="Debian"
							/>
						</div>
					) : null}

					{mode === "ssh" ? (
						<div className="grid gap-1.5">
							<label
								htmlFor="workspace-ssh-host"
								className="text-xs font-medium text-muted-foreground"
							>
								SSH Host
							</label>
							<Input
								id="workspace-ssh-host"
								value={host}
								onChange={(event) => setHost(event.target.value)}
								placeholder="~/.ssh/config 中的 Host alias"
							/>
						</div>
					) : null}

					<div className="grid gap-1.5">
						<label
							htmlFor="workspace-path"
							className="text-xs font-medium text-muted-foreground"
						>
							项目目录
						</label>
						<div className="flex gap-2">
							<Input
								id="workspace-path"
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
								<div className="text-sm font-medium">发现已有 Pi 工作区</div>
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
								{discovered.map((workspace) => (
									<div
										key={workspace.path}
										className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-muted/40"
									>
										<div className="min-w-0 flex-1">
											<div className="truncate text-sm font-medium">
												{workspace.name}
											</div>
											<div className="truncate font-mono text-[11px] text-muted-foreground">
												{workspace.path}
											</div>
										</div>
										<Button
											size="sm"
											variant="outline"
											disabled={busy || workspace.alreadyAdded}
											onClick={() => void add(workspace.path)}
										>
											{workspace.alreadyAdded ? "已添加" : "添加"}
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

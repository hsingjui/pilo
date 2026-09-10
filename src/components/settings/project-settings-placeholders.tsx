import { useState } from "react";
import { toast } from "sonner";

import type { Connection } from "@/lib/pi-runtime";
import { cn } from "@/lib/utils";
import {
	addWorkspace,
	discoverWorkspaces,
	localConnection,
	notifyWorkspacesChanged,
	sshConfigConnection,
	wslConnection,
	type DiscoveredWorkspace,
} from "@/lib/workspaces";
import { Button, Input } from "@/ui";
import { SettingsRow, SettingsSection } from "./compact-layout";

export function SettingsStatus({
	children,
	muted = false,
}: {
	children: string;
	muted?: boolean;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-6 items-center rounded-md border px-2 text-[11px] font-medium",
				muted
					? "border-border/60 bg-muted/35 text-muted-foreground"
					: "border-border/70 bg-background text-foreground/80",
			)}
		>
			{children}
		</span>
	);
}

export function ConnectionsSettings() {
	return (
		<div className="space-y-3">
			<SettingsSection
				title="连接环境"
				description="Connection 只描述 Pi 的运行位置；Workspace 与 Session 保持独立。"
			>
				<SettingsRow
					label="Local"
					helper="管理本机 Pi 可执行文件、版本检测与本地运行环境。"
				>
					<SettingsStatus>已接入 · 管理页待补</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="WSL"
					helper="管理发行版、Pi / Node / Git 环境信息与重连行为。"
				>
					<SettingsStatus>已接入 · 管理页待补</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="SSH"
					helper="使用系统 OpenSSH，兼容 ~/.ssh/config、SSH Agent、IdentityFile 与 ProxyJump。"
				>
					<SettingsStatus>已接入 · 管理页待补</SettingsStatus>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title="默认行为">
				<SettingsRow
					label="按 Workspace 选择 Connection"
					helper="Pi 始终在代码所在环境运行，不在 Local / WSL / SSH 之间跨环境复用进程。"
				>
					<SettingsStatus>固定策略</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

async function addWorkspaceFromSettings(connection: Connection, path: string) {
	if (!path.trim()) return;
	try {
		const workspace = await addWorkspace(connection, path.trim());
		notifyWorkspacesChanged();
		toast.success(`已添加 ${workspace.name}`, {
			description: `${workspace.connection.name} · ${workspace.metadata.cwd}`,
		});
	} catch (error) {
		toast.error("添加工作区失败", { description: String(error) });
	}
}

export function WorkspaceSettings() {
	const [localPath, setLocalPath] = useState("");
	const [wslDistro, setWslDistro] = useState("Debian");
	const [wslPath, setWslPath] = useState("");
	const [sshHost, setSshHost] = useState("");
	const [sshPath, setSshPath] = useState("");
	const [discovering, setDiscovering] = useState(false);
	const [discovered, setDiscovered] = useState<DiscoveredWorkspace[]>([]);
	const [discoveryConnection, setDiscoveryConnection] =
		useState<Connection | null>(null);

	const discover = async (connection: Connection) => {
		setDiscovering(true);
		setDiscoveryConnection(connection);
		try {
			setDiscovered(await discoverWorkspaces(connection));
		} catch (error) {
			setDiscovered([]);
			toast.error("发现工作区失败", { description: String(error) });
		} finally {
			setDiscovering(false);
		}
	};

	return (
		<div className="space-y-3">
			<SettingsSection
				title="添加工作区"
				description="Workspace 表示开发目录，并固定绑定一个 Connection。添加时会真实探测 cwd、Git branch 和 Pi version。"
			>
				<SettingsRow label="Local Folder" helper="填写 Windows 本机目录。">
					<div className="flex w-[360px] gap-2">
						<Input
							value={localPath}
							onChange={(event) => setLocalPath(event.target.value)}
							placeholder="C:\\Code\\project"
						/>
						<Button
							size="sm"
							onClick={() =>
								void addWorkspaceFromSettings(localConnection(), localPath)
							}
						>
							添加
						</Button>
					</div>
				</SettingsRow>
				<SettingsRow label="WSL" helper="发行版和 Linux 工作区路径。">
					<div className="flex w-[420px] gap-2">
						<Input
							className="w-28"
							value={wslDistro}
							onChange={(event) => setWslDistro(event.target.value)}
							placeholder="Debian"
						/>
						<Input
							value={wslPath}
							onChange={(event) => setWslPath(event.target.value)}
							placeholder="/root/code/project"
						/>
						<Button
							size="sm"
							onClick={() =>
								void addWorkspaceFromSettings(
									wslConnection(wslDistro.trim()),
									wslPath,
								)
							}
						>
							添加
						</Button>
					</div>
				</SettingsRow>
				<SettingsRow label="SSH" helper="使用 ~/.ssh/config 中的 Host alias。">
					<div className="flex w-[420px] gap-2">
						<Input
							className="w-28"
							value={sshHost}
							onChange={(event) => setSshHost(event.target.value)}
							placeholder="devbox"
						/>
						<Input
							value={sshPath}
							onChange={(event) => setSshPath(event.target.value)}
							placeholder="/srv/project"
						/>
						<Button
							size="sm"
							disabled={!sshHost.trim()}
							onClick={() =>
								void addWorkspaceFromSettings(
									sshConfigConnection(sshHost.trim()),
									sshPath,
								)
							}
						>
							添加
						</Button>
					</div>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection
				title="发现已有 Pi 工作区"
				description="从 Pi Session JSONL 的 session header 读取真实 cwd；不会复制项目内容。"
			>
				<SettingsRow label="Local" helper="扫描本机 ~/.pi/agent/sessions。">
					<Button
						size="sm"
						variant="outline"
						disabled={discovering}
						onClick={() => void discover(localConnection())}
					>
						扫描
					</Button>
				</SettingsRow>
				<SettingsRow label="WSL" helper="使用上方发行版扫描远端 Pi 历史。">
					<Button
						size="sm"
						variant="outline"
						disabled={discovering || !wslDistro.trim()}
						onClick={() => void discover(wslConnection(wslDistro.trim()))}
					>
						扫描
					</Button>
				</SettingsRow>
				<SettingsRow
					label="SSH"
					helper="使用上方 SSH Host alias 扫描远端 Pi 历史。"
				>
					<Button
						size="sm"
						variant="outline"
						disabled={discovering || !sshHost.trim()}
						onClick={() => void discover(sshConfigConnection(sshHost.trim()))}
					>
						{discovering ? "扫描中…" : "扫描"}
					</Button>
				</SettingsRow>
				{discovered.slice(0, 12).map((workspace) => (
					<SettingsRow
						key={`${discoveryConnection?.id ?? "unknown"}:${workspace.path}`}
						label={workspace.name}
						helper={workspace.path}
					>
						<Button
							size="sm"
							variant="outline"
							disabled={workspace.alreadyAdded || !discoveryConnection}
							onClick={() => {
								if (!discoveryConnection) return;
								void addWorkspaceFromSettings(
									discoveryConnection,
									workspace.path,
								);
							}}
						>
							{workspace.alreadyAdded ? "已添加" : "导入"}
						</Button>
					</SettingsRow>
				))}
			</SettingsSection>

			<SettingsSection title="缓存策略">
				<SettingsRow
					label="Recent Workspaces"
					helper="按 lastOpenedAt 排序并本地缓存 cwd、Git branch、Pi version；Session SQLite 索引留到下一阶段。"
				>
					<SettingsStatus>已启用</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

export function SessionSettings() {
	return (
		<div className="space-y-3">
			<SettingsSection
				title="会话索引"
				description="Pi JSONL 保持唯一事实来源，Pilo 只保存可重建的索引和桌面状态。"
			>
				<SettingsRow
					label="Session Index"
					helper="使用 SQLite 缓存 session metadata，加快工作区打开和历史列表加载。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="自动刷新"
					helper="Workspace focus、重连或文件变化时后台 reconcile Pi Session JSONL。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="Pin / Archive / Search"
					helper="这些状态属于 Pilo 的呈现与索引层，不修改 Pi conversation truth。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

export function PiSettings() {
	return (
		<div className="space-y-3">
			<SettingsSection
				title="Pi Runtime"
				description="Pilo 负责进程生命周期与桌面交互，不重新实现 Pi 的 Agent 能力。"
			>
				<SettingsRow
					label="Pi 可执行文件"
					helper="按 Connection 检测 Pi 路径和版本；后续支持自定义路径与诊断。"
				>
					<SettingsStatus>自动检测</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="默认模型与思考级别"
					helper="作为新 Session 的默认值；单个 Session 仍可在 Composer 中覆盖。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="Extension UI Bridge"
					helper="支持 select、confirm、input、editor、notify、status、widget 与 title。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title="运行时行为">
				<SettingsRow
					label="进程生命周期"
					helper="spawn / stop / restart / abort 由 Pilo Runtime 统一管理，并忽略旧 generation 的 stale events。"
				>
					<SettingsStatus>已接入</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

export function DiagnosticsSettings() {
	return (
		<div className="space-y-3">
			<SettingsSection
				title="诊断"
				description="集中处理运行环境、Pi RPC 和桌面端问题排查。"
			>
				<SettingsRow
					label="Pi Diagnostics"
					helper="检查 Pi、Node、Git、cwd、Connection 和 RPC 基础可用性。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="Runtime Logs"
					helper="查看 Pi stderr、Pilo Runtime 日志与最近一次进程退出信息。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
				<SettingsRow
					label="Crash Recovery"
					helper="保存必要桌面状态，并在异常退出后安全恢复 Workspace 与 Session。"
				>
					<SettingsStatus muted>规划中</SettingsStatus>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

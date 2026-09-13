import { Laptop, Pencil, Plus, Server, Trash2, Wifi } from "lucide-react";

import type { WslConnectionInfo } from "@/lib/connections";
import type { SshConnectionInfo } from "@/lib/ssh-connections";
import { Button } from "@/ui";

import { AUTH_LABELS, sshTargetLabel } from "./connection-form";
import { SettingsSection } from "./compact-layout";

type LocalWslConnectionsSectionProps = {
	items: WslConnectionInfo[];
	loading: boolean;
	busy: boolean;
	onTestLocal: () => void;
	onTestWsl: (distro: string) => void;
};

export function LocalWslConnectionsSection({
	items,
	loading,
	busy,
	onTestLocal,
	onTestWsl,
}: LocalWslConnectionsSectionProps) {
	return (
		<SettingsSection
			title="本机与 WSL"
			description="WSL 发行版由 Windows 管理；测试会实际部署并启动对应平台的 pilo-server。"
		>
			<div className="flex items-center gap-3 px-3 py-2.5">
				<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/35">
					<Laptop className="size-4 text-muted-foreground" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="text-sm font-medium">Local</div>
					<div className="text-[11px] text-muted-foreground">当前系统环境</div>
				</div>
				<Button variant="ghost" size="sm" disabled={busy} onClick={onTestLocal}>
					<Wifi />
					测试
				</Button>
			</div>
			{items.length === 0 ? (
				<div className="px-3 py-4 text-xs text-muted-foreground">
					{loading ? "正在读取 WSL 发行版…" : "未检测到 WSL 发行版。"}
				</div>
			) : (
				items.map((info) => {
					if (info.connection.kind.type !== "wsl") return null;
					const distro = info.connection.kind.distro;
					return (
						<div
							key={info.connection.id}
							className="flex items-center gap-3 px-3 py-2.5"
						>
							<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/35">
								<Server className="size-4 text-muted-foreground" />
							</div>
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm font-medium">
									{info.connection.name}
								</div>
								<div className="text-[11px] text-muted-foreground">
									{info.projectCount > 0
										? `${info.projectCount} 个项目`
										: "未关联项目"}
								</div>
							</div>
							<Button
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={() => onTestWsl(distro)}
							>
								<Wifi />
								测试
							</Button>
						</div>
					);
				})
			)}
		</SettingsSection>
	);
}

type SshConnectionsSectionProps = {
	items: SshConnectionInfo[];
	loading: boolean;
	busy: boolean;
	onAdd: () => void;
	onEdit: (info: SshConnectionInfo) => void;
	onRemove: (info: SshConnectionInfo) => void;
	onTest: (id: string) => void;
};

export function SshConnectionsSection({
	items,
	loading,
	busy,
	onAdd,
	onEdit,
	onRemove,
	onTest,
}: SshConnectionsSectionProps) {
	return (
		<SettingsSection
			title="SSH 连接"
			description="连接配置保存在 Pilo；密码保存在系统凭据库。代理使用 OpenSSH ProxyJump。"
			actions={
				<Button size="icon" variant="outline" onClick={onAdd}>
					<Plus />
					<span className="sr-only">添加 SSH 连接</span>
				</Button>
			}
			contentClassName="divide-y divide-border/60"
		>
			{loading ? (
				<div className="px-3 py-5 text-xs text-muted-foreground">
					正在读取连接…
				</div>
			) : items.length === 0 ? (
				<div className="px-3 py-5 text-xs text-muted-foreground">
					尚未添加 SSH 连接。
				</div>
			) : (
				items.map((info) => {
					if (info.connection.kind.type !== "ssh") return null;
					const target = info.connection.kind.target;
					return (
						<div
							key={info.connection.id}
							className="flex items-center gap-3 px-3 py-2.5"
						>
							<div className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/35">
								<Server className="size-4 text-muted-foreground" />
							</div>
							<div className="min-w-0 flex-1">
								<div className="truncate text-sm font-medium">
									{info.connection.name}
								</div>
								<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
									<span className="truncate font-mono">
										{sshTargetLabel(target)}
									</span>
									<span>{AUTH_LABELS[target.authMethod]}</span>
									{target.type === "direct" && target.proxyJump ? (
										<span>经 {target.proxyJump}</span>
									) : null}
									{info.projectCount > 0 ? (
										<span>{info.projectCount} 个项目</span>
									) : null}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<Button
									variant="ghost"
									size="sm"
									disabled={busy}
									onClick={() => onTest(info.connection.id)}
								>
									<Wifi />
									测试
								</Button>
								<Button
									variant="ghost"
									size="icon"
									onClick={() => onEdit(info)}
								>
									<Pencil />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									disabled={busy || info.projectCount > 0}
									onClick={() => onRemove(info)}
								>
									<Trash2 />
								</Button>
							</div>
						</div>
					);
				})
			)}
		</SettingsSection>
	);
}

export function ConnectionsHelpSection() {
	return (
		<SettingsSection title="说明">
			<div className="px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
				SSH Agent 适合系统已加载密钥的环境；指定私钥会传给 OpenSSH 的{" "}
				<span className="font-mono">-i</span>；密码认证通过 askpass
				从系统凭据库读取。代理目前使用{" "}
				<span className="font-mono">ProxyJump (-J)</span>，可填写{" "}
				<span className="font-mono">user@host:port</span>。
			</div>
		</SettingsSection>
	);
}

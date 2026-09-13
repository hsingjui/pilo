import { useCallback, useEffect, useState } from "react";
import {
	KeyRound,
	Laptop,
	Pencil,
	Plus,
	Server,
	Trash2,
	Wifi,
} from "lucide-react";
import { toast } from "sonner";

import type { Connection, SshAuthMethod, SshTarget } from "@/lib/pi-runtime";
import {
	listWslConnections,
	testLocalConnection,
	testWslConnection,
	type WslConnectionInfo,
} from "@/lib/connections";
import {
	listSshConnections,
	removeSshConnection,
	saveSshConnection,
	testSshConnection,
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
import { SettingsSection } from "./compact-layout";

const AUTH_LABELS: Record<SshAuthMethod, string> = {
	agent: "SSH Agent / 默认密钥",
	password: "密码",
	key: "指定私钥",
};

type FormState = {
	id: string;
	name: string;
	mode: "direct" | "config";
	hostname: string;
	port: string;
	user: string;
	authMethod: SshAuthMethod;
	identityFile: string;
	password: string;
	proxyJump: string;
	hasPassword: boolean;
};

function emptyForm(): FormState {
	return {
		id: `ssh:${crypto.randomUUID()}`,
		name: "",
		mode: "direct",
		hostname: "",
		port: "22",
		user: "",
		authMethod: "agent",
		identityFile: "",
		password: "",
		proxyJump: "",
		hasPassword: false,
	};
}

function formFromInfo(info: SshConnectionInfo): FormState {
	const target =
		info.connection.kind.type === "ssh" ? info.connection.kind.target : null;
	if (!target) return emptyForm();
	if (target.type === "config_host") {
		return {
			...emptyForm(),
			id: info.connection.id,
			name: info.connection.name,
			mode: "config",
			hostname: target.host,
			authMethod: target.authMethod,
			hasPassword: info.hasPassword,
		};
	}
	return {
		...emptyForm(),
		id: info.connection.id,
		name: info.connection.name,
		mode: "direct",
		hostname: target.hostname,
		port: target.port ? String(target.port) : "22",
		user: target.user ?? "",
		authMethod: target.authMethod,
		identityFile: target.identityFile ?? "",
		proxyJump: target.proxyJump ?? "",
		hasPassword: info.hasPassword,
	};
}

function connectionFromForm(form: FormState): Connection {
	let target: SshTarget;
	if (form.mode === "config") {
		target = {
			type: "config_host",
			host: form.hostname.trim(),
			authMethod: form.authMethod,
		};
	} else {
		target = {
			type: "direct",
			hostname: form.hostname.trim(),
			port: form.port.trim() ? Number(form.port) : null,
			user: form.user.trim() || null,
			identityFile:
				form.authMethod === "key" ? form.identityFile.trim() || null : null,
			authMethod: form.authMethod,
			proxyJump: form.proxyJump.trim() || null,
		};
	}
	return {
		id: form.id,
		name: form.name.trim(),
		kind: { type: "ssh", target },
	};
}

function targetLabel(target: SshTarget) {
	if (target.type === "config_host") return target.host;
	const host =
		target.port && target.port !== 22
			? `${target.hostname}:${target.port}`
			: target.hostname;
	return target.user ? `${target.user}@${host}` : host;
}

export function ConnectionsSettings() {
	const [items, setItems] = useState<SshConnectionInfo[]>([]);
	const [wslItems, setWslItems] = useState<WslConnectionInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [editing, setEditing] = useState<FormState | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setItems(await listSshConnections());
		} catch (error) {
			toast.error("读取 SSH 连接失败", { description: String(error) });
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		void Promise.allSettled([listSshConnections(), listWslConnections()]).then(
			([sshResult, wslResult]) => {
				if (cancelled) return;
				if (sshResult.status === "fulfilled") {
					setItems(sshResult.value);
				} else {
					toast.error("读取 SSH 连接失败", {
						description: String(sshResult.reason),
					});
				}
				if (wslResult.status === "fulfilled") {
					setWslItems(wslResult.value);
				}
				setLoading(false);
			},
		);
		return () => {
			cancelled = true;
		};
	}, []);

	const save = async () => {
		if (!editing?.name.trim() || !editing.hostname.trim()) return;
		if (
			editing.mode === "direct" &&
			editing.authMethod === "key" &&
			!editing.identityFile.trim()
		) {
			toast.error("请选择或填写私钥路径");
			return;
		}
		if (
			editing.authMethod === "password" &&
			!editing.password &&
			!editing.hasPassword
		) {
			toast.error("请输入 SSH 密码");
			return;
		}
		setBusy(true);
		try {
			await saveSshConnection(
				connectionFromForm(editing),
				editing.password || undefined,
			);
			setEditing(null);
			await refresh();
			toast.success("SSH 连接已保存");
		} catch (error) {
			toast.error("保存 SSH 连接失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const test = async (id: string) => {
		setBusy(true);
		try {
			const result = await testSshConnection(id);
			toast.success("SSH 连接可用", {
				description: `pilo-server ${result.serverVersion} · protocol ${result.protocolVersion}`,
			});
		} catch (error) {
			toast.error("SSH 连接失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const testWsl = async (distro: string) => {
		setBusy(true);
		try {
			const result = await testWslConnection(distro);
			toast.success(`${distro} 可用`, {
				description: `pilo-server ${result.serverVersion} · protocol ${result.protocolVersion}`,
			});
		} catch (error) {
			toast.error(`${distro} 连接失败`, { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const testLocal = async () => {
		setBusy(true);
		try {
			const result = await testLocalConnection();
			toast.success("Local 可用", {
				description: `pilo-server ${result.serverVersion} · protocol ${result.protocolVersion}`,
			});
		} catch (error) {
			toast.error("Local 连接失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const remove = async (info: SshConnectionInfo) => {
		if (!window.confirm(`删除 SSH 连接“${info.connection.name}”？`)) return;
		setBusy(true);
		try {
			await removeSshConnection(info.connection.id);
			await refresh();
			toast.success("SSH 连接已删除");
		} catch (error) {
			toast.error("删除 SSH 连接失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="space-y-3">
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
						<div className="text-[11px] text-muted-foreground">
							当前系统环境
						</div>
					</div>
					<Button
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => void testLocal()}
					>
						<Wifi />
						测试
					</Button>
				</div>
				{wslItems.length === 0 ? (
					<div className="px-3 py-4 text-xs text-muted-foreground">
						{loading ? "正在读取 WSL 发行版…" : "未检测到 WSL 发行版。"}
					</div>
				) : (
					wslItems.map((info) => {
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
										{info.workspaceCount > 0
											? `${info.workspaceCount} 个工作区`
											: "未关联工作区"}
									</div>
								</div>
								<Button
									variant="ghost"
									size="sm"
									disabled={busy}
									onClick={() => void testWsl(distro)}
								>
									<Wifi />
									测试
								</Button>
							</div>
						);
					})
				)}
			</SettingsSection>
			<SettingsSection
				title="SSH 连接"
				description="连接配置保存在 Pilo；密码保存在系统凭据库。代理使用 OpenSSH ProxyJump。"
				actions={
					<Button
						size="icon"
						variant="outline"
						onClick={() => setEditing(emptyForm())}
					>
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
											{targetLabel(target)}
										</span>
										<span>{AUTH_LABELS[target.authMethod]}</span>
										{target.type === "direct" && target.proxyJump ? (
											<span>经 {target.proxyJump}</span>
										) : null}
										{info.workspaceCount > 0 ? (
											<span>{info.workspaceCount} 个工作区</span>
										) : null}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-1">
									<Button
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() => void test(info.connection.id)}
									>
										<Wifi />
										测试
									</Button>
									<Button
										variant="ghost"
										size="icon"
										onClick={() => setEditing(formFromInfo(info))}
									>
										<Pencil />
									</Button>
									<Button
										variant="ghost"
										size="icon"
										disabled={busy || info.workspaceCount > 0}
										onClick={() => void remove(info)}
									>
										<Trash2 />
									</Button>
								</div>
							</div>
						);
					})
				)}
			</SettingsSection>

			<SettingsSection title="说明">
				<div className="px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
					SSH Agent 适合系统已加载密钥的环境；指定私钥会传给 OpenSSH 的{" "}
					<span className="font-mono">-i</span>；密码认证通过 askpass
					从系统凭据库读取。代理目前使用{" "}
					<span className="font-mono">ProxyJump (-J)</span>，可填写{" "}
					<span className="font-mono">user@host:port</span>。
				</div>
			</SettingsSection>

			<Dialog
				open={editing !== null}
				onOpenChange={(open) => !open && setEditing(null)}
			>
				<DialogContent className="max-w-lg gap-4">
					<DialogHeader>
						<DialogTitle>
							{editing?.name ? "编辑 SSH 连接" : "添加 SSH 连接"}
						</DialogTitle>
						<DialogDescription>
							使用系统 OpenSSH 建立连接，Pilo 不复制远程工作区到本地。
						</DialogDescription>
					</DialogHeader>
					{editing ? (
						<div className="grid gap-3">
							<div className="grid grid-cols-2 gap-3">
								<label htmlFor="ssh-name" className="grid gap-1 text-xs">
									名称
									<Input
										id="ssh-name"
										value={editing.name}
										onChange={(e) =>
											setEditing({ ...editing, name: e.target.value })
										}
										placeholder="生产服务器"
									/>
								</label>
								<div className="grid gap-1 text-xs">
									连接方式
									<Select
										value={editing.mode}
										onValueChange={(value) =>
											setEditing({
												...editing,
												mode: value as FormState["mode"],
											})
										}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="direct">直接连接</SelectItem>
											<SelectItem value="config">~/.ssh/config Host</SelectItem>
										</SelectContent>
									</Select>
								</div>
							</div>
							<label htmlFor="ssh-host" className="grid gap-1 text-xs">
								{editing.mode === "config" ? "Host alias" : "主机"}
								<Input
									id="ssh-host"
									value={editing.hostname}
									onChange={(e) =>
										setEditing({ ...editing, hostname: e.target.value })
									}
									placeholder={
										editing.mode === "config" ? "devbox" : "example.com"
									}
								/>
							</label>
							{editing.mode === "direct" ? (
								<div className="grid grid-cols-2 gap-3">
									<label htmlFor="ssh-user" className="grid gap-1 text-xs">
										用户名
										<Input
											id="ssh-user"
											value={editing.user}
											onChange={(e) =>
												setEditing({ ...editing, user: e.target.value })
											}
											placeholder="root"
										/>
									</label>
									<label htmlFor="ssh-port" className="grid gap-1 text-xs">
										端口
										<Input
											id="ssh-port"
											type="number"
											min={1}
											max={65535}
											value={editing.port}
											onChange={(e) =>
												setEditing({ ...editing, port: e.target.value })
											}
										/>
									</label>
								</div>
							) : null}
							<div className="grid gap-1 text-xs">
								认证方式
								<Select
									value={editing.authMethod}
									onValueChange={(value) =>
										setEditing({
											...editing,
											authMethod: value as SshAuthMethod,
										})
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="agent">SSH Agent / 默认密钥</SelectItem>
										<SelectItem value="password">密码</SelectItem>
										{editing.mode === "direct" ? (
											<SelectItem value="key">指定私钥</SelectItem>
										) : null}
									</SelectContent>
								</Select>
							</div>
							{editing.authMethod === "password" ? (
								<label htmlFor="ssh-password" className="grid gap-1 text-xs">
									密码
									<Input
										id="ssh-password"
										type="password"
										value={editing.password}
										onChange={(e) =>
											setEditing({ ...editing, password: e.target.value })
										}
										placeholder={
											editing.hasPassword ? "已保存；留空保持不变" : "SSH 密码"
										}
									/>
								</label>
							) : null}
							{editing.mode === "direct" && editing.authMethod === "key" ? (
								<label htmlFor="ssh-key" className="grid gap-1 text-xs">
									<span className="flex items-center gap-1">
										<KeyRound className="size-3.5" />
										私钥路径
									</span>
									<Input
										id="ssh-key"
										value={editing.identityFile}
										onChange={(e) =>
											setEditing({ ...editing, identityFile: e.target.value })
										}
										placeholder="~/.ssh/id_ed25519"
									/>
								</label>
							) : null}
							{editing.mode === "direct" ? (
								<label htmlFor="ssh-proxy" className="grid gap-1 text-xs">
									代理 / 跳板机（可选）
									<Input
										id="ssh-proxy"
										value={editing.proxyJump}
										onChange={(e) =>
											setEditing({ ...editing, proxyJump: e.target.value })
										}
										placeholder="user@jump.example.com:22"
									/>
									<span className="text-[11px] text-muted-foreground">
										使用 OpenSSH ProxyJump；多级跳板可用逗号分隔。
									</span>
								</label>
							) : null}
							<div className="mt-1 flex justify-end gap-2">
								<Button variant="outline" onClick={() => setEditing(null)}>
									取消
								</Button>
								<Button
									disabled={
										busy || !editing.name.trim() || !editing.hostname.trim()
									}
									onClick={() => void save()}
								>
									{busy ? "保存中…" : "保存"}
								</Button>
							</div>
						</div>
					) : null}
				</DialogContent>
			</Dialog>
		</div>
	);
}

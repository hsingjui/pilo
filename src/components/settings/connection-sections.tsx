import { useEffect, useState, type ReactNode } from "react";
import {
	Laptop,
	Monitor,
	Pencil,
	Plus,
	Search,
	Server,
	Settings2,
	Trash2,
	Wifi,
} from "lucide-react";
import { toast } from "sonner";

import { listWslDistributions, type WslDistribution } from "@/lib/connections";
import type { Connection } from "@/lib/pi-runtime";
import { connectionLabel } from "@/lib/projects";
import { IS_WINDOWS } from "@/components/title-bar";
import { cn } from "@/lib/utils";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DropdownMenu,
	Input,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Switch,
} from "@/ui";

import { AUTH_LABELS, sshTargetLabel } from "./connection-form";
import {
	SETTINGS_CONTROL_CLASS,
	SETTINGS_ICON_BUTTON_CLASS,
	SETTINGS_NESTED_DIALOG_OVERLAY_CLASS,
	SettingsSection,
} from "./compact-layout";

function ConnectionIcon({ kind }: { kind: Connection["kind"] }) {
	if (kind.type === "local")
		return <Laptop className="size-3.5" aria-hidden="true" />;
	if (kind.type === "wsl")
		return <Monitor className="size-3.5" aria-hidden="true" />;
	return <Server className="size-3.5" aria-hidden="true" />;
}

type ConnectionRowProps = {
	connection: Connection;
	description: ReactNode;
	projectCount: number;
	shownInHome: boolean;
	busy: boolean;
	onToggleShown: (shown: boolean) => void;
	onTest: () => void;
	onProbePi: () => void;
	onConfigure: () => void;
	onEdit?: () => void;
	onRemove?: () => void;
};

export function ConnectionRow({
	connection,
	description,
	projectCount,
	shownInHome,
	busy,
	onToggleShown,
	onTest,
	onProbePi,
	onConfigure,
	onEdit,
	onRemove,
}: ConnectionRowProps) {
	return (
		<div className="flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-hover/30">
			<div className="flex size-6 shrink-0 items-center justify-center text-foreground/70">
				<ConnectionIcon kind={connection.kind} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-medium">
					{connectionLabel(connection)}
				</div>
				<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
					{description}
					<span>
						{projectCount > 0 ? `${projectCount} 个项目` : "未关联项目"}
					</span>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<span className="mr-1 flex items-center gap-2 text-[11px] text-muted-foreground">
					首页
					<Switch
						aria-label="显示在首页"
						checked={shownInHome}
						disabled={busy}
						onCheckedChange={onToggleShown}
					/>
				</span>
				<Button
					variant="ghost"
					size="icon"
					className={SETTINGS_ICON_BUTTON_CLASS}
					disabled={busy}
					onClick={onTest}
					aria-label="测试连接"
					title="测试连接"
				>
					<Wifi />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className={SETTINGS_ICON_BUTTON_CLASS}
					disabled={busy}
					onClick={onProbePi}
					aria-label="检测 PI"
					title="检测 PI"
				>
					<Search />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className={SETTINGS_ICON_BUTTON_CLASS}
					disabled={busy}
					onClick={onConfigure}
					title="连接设置"
				>
					<Pencil />
					<span className="sr-only">连接设置</span>
				</Button>
				{onEdit ? (
					<Button
						variant="ghost"
						size="icon"
						className={SETTINGS_ICON_BUTTON_CLASS}
						onClick={onEdit}
						title="编辑 SSH 参数"
					>
						<Settings2 />
						<span className="sr-only">编辑 SSH 参数</span>
					</Button>
				) : null}
				{onRemove ? (
					<Button
						variant="ghost"
						size="icon"
						className={cn(
							SETTINGS_ICON_BUTTON_CLASS,
							"hover:bg-destructive/10 hover:text-destructive",
						)}
						disabled={busy}
						onClick={onRemove}
						title="删除连接"
					>
						<Trash2 />
						<span className="sr-only">删除连接</span>
					</Button>
				) : null}
			</div>
		</div>
	);
}

export function ConnectionsSection({
	children,
	onAddSsh,
	onAddWsl,
}: {
	children: ReactNode;
	onAddSsh: () => void;
	onAddWsl: () => void;
}) {
	return (
		<SettingsSection
			title="连接"
			description="连接配置保存在 Pilo；SSH 密码保存在系统凭据库。"
			actions={
				<AddConnectionMenu
					canAddWsl={IS_WINDOWS}
					onAddSsh={onAddSsh}
					onAddWsl={onAddWsl}
				/>
			}
		>
			{children}
		</SettingsSection>
	);
}

export type ConnectionSettingsDraft = {
	connection: Connection;
	name: string;
	piExecutable: string;
};

export function ConnectionSettingsDialog({
	draft,
	busy,
	probing,
	onChange,
	onClose,
	onProbe,
	onSave,
}: {
	draft: ConnectionSettingsDraft | null;
	busy: boolean;
	probing: boolean;
	onChange: (draft: ConnectionSettingsDraft) => void;
	onClose: () => void;
	onProbe: () => void;
	onSave: () => void;
}) {
	return (
		<Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				overlayClassName={SETTINGS_NESTED_DIALOG_OVERLAY_CLASS}
				className="max-w-md gap-4"
			>
				<DialogHeader>
					<DialogTitle>连接设置</DialogTitle>
					<DialogDescription>
						修改显示名称，并为这个连接指定 PI 可执行文件。留空时自动从目标环境
						PATH 检测。
					</DialogDescription>
				</DialogHeader>
				{draft ? (
					<div className="grid gap-3">
						<label htmlFor="connection-name" className="grid gap-1 text-xs">
							名称
							<Input
								id="connection-name"
								className={SETTINGS_CONTROL_CLASS}
								value={draft.name}
								onChange={(event) =>
									onChange({ ...draft, name: event.target.value })
								}
							/>
						</label>
						<label htmlFor="connection-pi-path" className="grid gap-1 text-xs">
							PI 路径
							<div className="flex gap-2">
								<Input
									id="connection-pi-path"
									className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
									value={draft.piExecutable}
									onChange={(event) =>
										onChange({ ...draft, piExecutable: event.target.value })
									}
									placeholder="自动检测"
								/>
								<Button
									variant="outline"
									size="sm"
									disabled={busy || probing}
									onClick={onProbe}
								>
									{probing ? "检测中…" : "检测"}
								</Button>
							</div>
							<span className="text-[11px] text-muted-foreground">
								可填写绝对路径，也可填写目标环境 PATH 中可解析的命令名。
							</span>
						</label>
						<div className="mt-1 flex justify-end gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={onClose}
							>
								取消
							</Button>
							<Button
								size="sm"
								disabled={busy || !draft.name.trim()}
								onClick={onSave}
							>
								{busy ? "保存中…" : "保存"}
							</Button>
						</div>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function AddConnectionMenu({
	canAddWsl,
	onAddSsh,
	onAddWsl,
	className,
}: {
	canAddWsl: boolean;
	onAddSsh: () => void;
	onAddWsl: () => void;
	className?: string;
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button size="icon" variant="outline" className={cn(className)}>
					<Plus />
					<span className="sr-only">添加连接</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{canAddWsl ? (
					<DropdownMenuItem onSelect={onAddWsl}>
						<Monitor />
						添加 WSL 发行版
					</DropdownMenuItem>
				) : null}
				<DropdownMenuItem onSelect={onAddSsh}>
					<Server />
					添加 SSH 远程
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function WslDistributionDialog({
	open,
	busy,
	addedDistros,
	onOpenChange,
	onAdd,
}: {
	open: boolean;
	busy: boolean;
	addedDistros: Set<string>;
	onOpenChange: (open: boolean) => void;
	onAdd: (distro: string) => void;
}) {
	const [distributions, setDistributions] = useState<WslDistribution[] | null>(
		null,
	);

	useEffect(() => {
		if (!open || !IS_WINDOWS) return;
		let cancelled = false;
		void listWslDistributions()
			.then((items) => {
				if (!cancelled) setDistributions(items);
			})
			.catch((error) => {
				if (cancelled) return;
				setDistributions([]);
				toast.error("读取 WSL 发行版失败", { description: String(error) });
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				overlayClassName={SETTINGS_NESTED_DIALOG_OVERLAY_CLASS}
				className="max-w-md gap-4"
			>
				<DialogHeader>
					<DialogTitle>添加 WSL 发行版</DialogTitle>
					<DialogDescription>
						选择一个 WSL
						发行版加入连接列表；添加后可单独测试并选择是否显示在首页。
					</DialogDescription>
				</DialogHeader>
				<div className="max-h-72 divide-y divide-border/60 overflow-auto rounded-md border">
					{distributions === null ? (
						<div className="px-3 py-4 text-xs text-muted-foreground">
							正在读取 WSL 发行版…
						</div>
					) : distributions.length === 0 ? (
						<div className="px-3 py-4 text-xs text-muted-foreground">
							未检测到 WSL 发行版。
						</div>
					) : (
						distributions.map((distribution) => {
							const added = addedDistros.has(distribution.name);
							return (
								<div
									key={distribution.name}
									className="flex items-center gap-3 px-3 py-2"
								>
									<Monitor className="size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate text-sm">
										{distribution.name}
									</span>
									<Button
										variant="outline"
										size="sm"
										disabled={busy || added}
										onClick={() => onAdd(distribution.name)}
									>
										{added ? "已添加" : "添加"}
									</Button>
								</div>
							);
						})
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

export function ConnectionsHelpSection() {
	return (
		<SettingsSection title="说明">
			<div className="px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
				测试会实际部署并启动对应环境上的 pilo-server。SSH Agent
				适合系统已加载密钥的环境；指定私钥会传给 OpenSSH 的{" "}
				<span className="font-mono">-i</span>；密码认证通过 askpass
				从系统凭据库读取。代理目前使用{" "}
				<span className="font-mono">ProxyJump (-J)</span>，可填写{" "}
				<span className="font-mono">user@host:port</span>。
			</div>
		</SettingsSection>
	);
}

/** SSH 行副标题：目标 + 认证方式 + 代理。 */
export function sshConnectionDescription(connection: Connection): ReactNode {
	if (connection.kind.type !== "ssh") return null;
	const target = connection.kind.target;
	return (
		<>
			<span className="truncate font-mono">{sshTargetLabel(target)}</span>
			<span>{AUTH_LABELS[target.authMethod]}</span>
			{target.type === "direct" && target.proxyJump ? (
				<span>经 {target.proxyJump}</span>
			) : null}
		</>
	);
}

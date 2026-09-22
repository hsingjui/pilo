import { useState } from "react";
import { Eye, EyeOff, KeyRound } from "lucide-react";

import type { SshAuthMethod } from "@/lib/pi-runtime";
import { cn } from "@/lib/utils";
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

import type { SshConnectionFormState } from "./connection-form";
import {
	SETTINGS_CONTROL_CLASS,
	SETTINGS_ICON_BUTTON_CLASS,
	SETTINGS_NESTED_DIALOG_OVERLAY_CLASS,
} from "./compact-layout";

type SshFieldError = {
	field: "identityFile" | "password";
	message: string;
};

type SshConnectionEditorProps = {
	open: boolean;
	editing: SshConnectionFormState | null;
	busy: boolean;
	testing?: boolean;
	fieldError?: SshFieldError | null;
	onChange: (editing: SshConnectionFormState) => void;
	onClose: () => void;
	onTest?: () => void;
	onSave: () => void;
};

export function SshConnectionEditor({
	open,
	editing,
	busy,
	testing,
	fieldError,
	onChange,
	onClose,
	onTest,
	onSave,
}: SshConnectionEditorProps) {
	const [revealedId, setRevealedId] = useState<string | null>(null);
	const revealPassword = editing !== null && revealedId === editing.id;

	const resetReveal = () => setRevealedId(null);

	const togglePassword = () => {
		if (!editing) return;
		setRevealedId(revealedId === editing.id ? null : editing.id);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen) {
					resetReveal();
					onClose();
				}
			}}
		>
			<DialogContent
				overlayClassName={SETTINGS_NESTED_DIALOG_OVERLAY_CLASS}
				className="max-w-lg gap-4"
			>
				<DialogHeader>
					<DialogTitle>
						{editing?.name ? "编辑 SSH 连接" : "添加 SSH 连接"}
					</DialogTitle>
					<DialogDescription className="sr-only">
						配置 SSH 连接
					</DialogDescription>
				</DialogHeader>
				{editing ? (
					<div className="grid gap-3">
						<div className="grid grid-cols-2 gap-3">
							<label htmlFor="ssh-name" className="grid gap-1 text-xs">
								名称
								<Input
									id="ssh-name"
									className={SETTINGS_CONTROL_CLASS}
									value={editing.name}
									onChange={(event) =>
										onChange({ ...editing, name: event.target.value })
									}
									placeholder="生产服务器"
								/>
							</label>
							<div className="grid gap-1 text-xs">
								连接方式
								<Select
									value={editing.mode}
									onValueChange={(value) =>
										onChange({
											...editing,
											mode: value as SshConnectionFormState["mode"],
										})
									}
								>
									<SelectTrigger className={SETTINGS_CONTROL_CLASS}>
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
							{editing.mode === "config" ? "Host 别名" : "主机"}
							<Input
								id="ssh-host"
								className={SETTINGS_CONTROL_CLASS}
								value={editing.hostname}
								onChange={(event) =>
									onChange({ ...editing, hostname: event.target.value })
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
										className={SETTINGS_CONTROL_CLASS}
										value={editing.user}
										onChange={(event) =>
											onChange({ ...editing, user: event.target.value })
										}
										placeholder="root"
									/>
								</label>
								<label htmlFor="ssh-port" className="grid gap-1 text-xs">
									端口
									<Input
										id="ssh-port"
										className={SETTINGS_CONTROL_CLASS}
										type="number"
										min={1}
										max={65535}
										value={editing.port}
										onChange={(event) =>
											onChange({ ...editing, port: event.target.value })
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
									onChange({
										...editing,
										authMethod: value as SshAuthMethod,
									})
								}
							>
								<SelectTrigger className={SETTINGS_CONTROL_CLASS}>
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
						<div className="grid gap-1 text-xs">
							Pi 运行位置
							<Select
								value={editing.piRuntime}
								onValueChange={(value) =>
									onChange({
										...editing,
										piRuntime: value as SshConnectionFormState["piRuntime"],
									})
								}
							>
								<SelectTrigger className={SETTINGS_CONTROL_CLASS}>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="workspace">远程 Pi（SSH 主机）</SelectItem>
									<SelectItem value="local">本地 Pi（工具走 SSH）</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{editing.authMethod === "password" ? (
							<label htmlFor="ssh-password" className="grid gap-1 text-xs">
								密码
								<div className="relative">
									<Input
										id="ssh-password"
										className={cn(SETTINGS_CONTROL_CLASS, "pr-9")}
										type={revealPassword ? "text" : "password"}
										value={editing.password}
										onChange={(event) =>
											onChange({ ...editing, password: event.target.value })
										}
										placeholder="SSH 密码"
										aria-invalid={fieldError?.field === "password" || undefined}
										aria-describedby={
											fieldError?.field === "password"
												? "ssh-password-error"
												: undefined
										}
									/>
									<button
										type="button"
										className={cn(
											SETTINGS_ICON_BUTTON_CLASS,
											"absolute inset-y-0 right-0 my-auto",
										)}
										disabled={!editing.password}
										onClick={togglePassword}
										aria-label={revealPassword ? "隐藏密码" : "查看密码"}
									>
										{revealPassword ? <EyeOff /> : <Eye />}
									</button>
								</div>
								{fieldError?.field === "password" ? (
									<span
										id="ssh-password-error"
										className="text-2xs text-destructive"
									>
										{fieldError.message}
									</span>
								) : null}
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
									className={SETTINGS_CONTROL_CLASS}
									value={editing.identityFile}
									onChange={(event) =>
										onChange({ ...editing, identityFile: event.target.value })
									}
									placeholder="~/.ssh/id_ed25519"
									aria-invalid={
										fieldError?.field === "identityFile" || undefined
									}
									aria-describedby={
										fieldError?.field === "identityFile"
											? "ssh-key-error"
											: undefined
									}
								/>
								{fieldError?.field === "identityFile" ? (
									<span
										id="ssh-key-error"
										className="text-2xs text-destructive"
									>
										{fieldError.message}
									</span>
								) : null}
							</label>
						) : null}
						{editing.mode === "direct" ? (
							<label htmlFor="ssh-proxy" className="grid gap-1 text-xs">
								跳板机（可选）
								<Input
									id="ssh-proxy"
									className={SETTINGS_CONTROL_CLASS}
									value={editing.proxyJump}
									onChange={(event) =>
										onChange({ ...editing, proxyJump: event.target.value })
									}
									placeholder="user@jump.example.com:22"
								/>
							</label>
						) : null}
						<div className="mt-1 flex items-center justify-between gap-2">
							{onTest ? (
								<Button
									variant="outline"
									size="sm"
									disabled={busy || testing}
									onClick={onTest}
								>
									{testing ? "测试中…" : "测试连接"}
								</Button>
							) : (
								<span />
							)}
							<div className="flex gap-2">
								<Button
									size="sm"
									variant="outline"
									onClick={() => {
										resetReveal();
										onClose();
									}}
								>
									取消
								</Button>
								<Button
									size="sm"
									disabled={
										busy || !editing.name.trim() || !editing.hostname.trim()
									}
									onClick={() => {
										resetReveal();
										onSave();
									}}
								>
									{busy ? "保存中…" : "保存"}
								</Button>
							</div>
						</div>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

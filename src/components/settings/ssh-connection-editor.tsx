import { KeyRound } from "lucide-react";

import type { SshAuthMethod } from "@/lib/pi-runtime";
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
	SETTINGS_NESTED_DIALOG_OVERLAY_CLASS,
} from "./compact-layout";

type SshFieldError = {
	field: "identityFile" | "password";
	message: string;
};

type SshConnectionEditorProps = {
	editing: SshConnectionFormState | null;
	busy: boolean;
	fieldError?: SshFieldError | null;
	onChange: (editing: SshConnectionFormState) => void;
	onClose: () => void;
	onSave: () => void;
};

export function SshConnectionEditor({
	editing,
	busy,
	fieldError,
	onChange,
	onClose,
	onSave,
}: SshConnectionEditorProps) {
	return (
		<Dialog open={editing !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				overlayClassName={SETTINGS_NESTED_DIALOG_OVERLAY_CLASS}
				className="max-w-lg gap-4"
			>
				<DialogHeader>
					<DialogTitle>
						{editing?.name ? "编辑 SSH 连接" : "添加 SSH 连接"}
					</DialogTitle>
					<DialogDescription>
						使用系统 OpenSSH 建立连接，Pilo 不复制远程项目到本地。
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
							{editing.mode === "config" ? "Host alias" : "主机"}
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
						{editing.authMethod === "password" ? (
							<label htmlFor="ssh-password" className="grid gap-1 text-xs">
								密码
								<Input
									id="ssh-password"
									className={SETTINGS_CONTROL_CLASS}
									type="password"
									value={editing.password}
									onChange={(event) =>
										onChange({ ...editing, password: event.target.value })
									}
									placeholder={
										editing.hasPassword ? "已保存；留空保持不变" : "SSH 密码"
									}
									aria-invalid={fieldError?.field === "password" || undefined}
									aria-describedby={
										fieldError?.field === "password"
											? "ssh-password-error"
											: undefined
									}
								/>
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
								代理 / 跳板机（可选）
								<Input
									id="ssh-proxy"
									className={SETTINGS_CONTROL_CLASS}
									value={editing.proxyJump}
									onChange={(event) =>
										onChange({ ...editing, proxyJump: event.target.value })
									}
									placeholder="user@jump.example.com:22"
								/>
								<span className="text-2xs text-muted-foreground">
									使用 OpenSSH ProxyJump；多级跳板可用逗号分隔。
								</span>
							</label>
						) : null}
						<div className="mt-1 flex justify-end gap-2">
							<Button size="sm" variant="outline" onClick={onClose}>
								取消
							</Button>
							<Button
								size="sm"
								disabled={
									busy || !editing.name.trim() || !editing.hostname.trim()
								}
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

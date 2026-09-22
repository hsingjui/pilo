import { useState } from "react";
import { useTranslation } from "react-i18next";
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
	const { t } = useTranslation();
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
						{editing?.name
							? t("settings.editSshConnection")
							: t("settings.addSshConnection")}
					</DialogTitle>
					<DialogDescription className="sr-only">
						{t("settings.configureSshConnection")}
					</DialogDescription>
				</DialogHeader>
				{editing ? (
					<div className="grid gap-3">
						<div className="grid grid-cols-2 gap-3">
							<label htmlFor="ssh-name" className="grid gap-1 text-xs">
								{t("settings.connectionName")}
								<Input
									id="ssh-name"
									className={SETTINGS_CONTROL_CLASS}
									value={editing.name}
									onChange={(event) =>
										onChange({ ...editing, name: event.target.value })
									}
									placeholder={t("settings.productionServer")}
								/>
							</label>
							<div className="grid gap-1 text-xs">
								{t("settings.connectionMethod")}
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
										<SelectItem value="direct">
											{t("settings.directConnection")}
										</SelectItem>
										<SelectItem value="config">
											{t("settings.sshConfigHost")}
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
						<label htmlFor="ssh-host" className="grid gap-1 text-xs">
							{editing.mode === "config"
								? t("connection.hostAlias")
								: t("connection.host")}
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
									{t("connection.username")}
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
									{t("connection.port")}
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
							{t("connection.authentication")}
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
									<SelectItem value="agent">
										{t("connection.sshAgent")}
									</SelectItem>
									<SelectItem value="password">
										{t("connection.password")}
									</SelectItem>
									{editing.mode === "direct" ? (
										<SelectItem value="key">
											{t("connection.privateKey")}
										</SelectItem>
									) : null}
								</SelectContent>
							</Select>
						</div>
						<div className="grid gap-1 text-xs">
							{t("connection.runtimeLocation")}
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
									<SelectItem value="workspace">
										{t("connection.piWorkspace")}
									</SelectItem>
									<SelectItem value="local">
										{t("connection.piLocal")}
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{editing.authMethod === "password" ? (
							<label htmlFor="ssh-password" className="grid gap-1 text-xs">
								{t("connection.password")}
								<div className="relative">
									<Input
										id="ssh-password"
										className={cn(SETTINGS_CONTROL_CLASS, "pr-9")}
										type={revealPassword ? "text" : "password"}
										value={editing.password}
										onChange={(event) =>
											onChange({ ...editing, password: event.target.value })
										}
										placeholder={t("connection.sshPassword")}
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
										aria-label={
											revealPassword
												? t("settings.hidePassword")
												: t("settings.showPassword")
										}
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
									{t("connection.privateKeyPath")}
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
								{t("connection.proxyJump")}
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
									{testing
										? t("connection.testingConnection")
										: t("connection.testConnection")}
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
									{t("common.cancel")}
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
									{busy ? t("common.saving") : t("common.save")}
								</Button>
							</div>
						</div>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

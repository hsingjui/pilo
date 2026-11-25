import { signal, Text, View } from "nsh";

import type {
	SshAgentIdentity,
	SshConnectionInfo,
} from "@shared/api/connections-types";
import type { PiRuntime, SshAuthMethod } from "@shared/api/pi-runtime-types";
import { userErrorMessage } from "@shared/app-error";
import { AppToasts, AppToastStack } from "../shell/app-toasts";
import { t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogClose } from "../ui/dialog-close";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { useMountedDialog } from "../ui/motion";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { field, fieldError } from "./connection-form";
import { showConnectionTestToast } from "./connection-settings";
import { SettingsIconButton } from "./layout";
import {
	connectionFromDraft,
	draftFromInfo,
	emptyDraft,
	type SshDraft,
	type SshFieldError,
} from "./ssh-connection-draft";
import type { ConnectionsClient } from "./connections-pane";

/**
 * The SSH add/edit dialog's controller: draft, dirty revisions, async calls.
 * The draft stays a plain object — a signal holding it would re-render the
 * whole dialog on every keystroke and drop input focus; the `structRev` /
 * `formRev` revs let fine-grained `{() =>}` watchers re-read it instead.
 */
export function createSshEditor(deps: {
	client: ConnectionsClient;
	refresh: () => Promise<void>;
	toasts: AppToasts;
}) {
	const client = deps.client;
	let sshDraft: SshDraft | null = null;
	const open = signal(false);
	/** Bumps when a field changes which sections the form shows. */
	const structRev = signal(0);
	/** Bumps on every draft edit; watchers re-read the draft then. */
	const formRev = signal(0);
	const busy = signal(false);
	const testing = signal(false);
	const fieldErrorState = signal<SshFieldError | null>(null);
	const passwordRevealed = signal(false);
	/** `undefined` while loading, `null` when the agent could not be read. */
	const agentIdentities = signal<SshAgentIdentity[] | null | undefined>(
		undefined,
	);

	const loadAgentIdentities = () => {
		agentIdentities.set(undefined);
		client
			.listSshAgentIdentities()
			.then((identities) => agentIdentities.set(identities))
			.catch(() => agentIdentities.set(null));
	};

	const openEdit = async (info: SshConnectionInfo) => {
		fieldErrorState.set(null);
		passwordRevealed.set(false);
		const form = draftFromInfo(info);
		/* 编辑时直接回填已保存的密码，无需在输入框里提示“已保存”。 */
		if (form.authMethod === "password" && form.hasPassword && !form.password) {
			try {
				form.password = (await client.getSshConnectionPassword(form.id)) ?? "";
			} catch {
				/* 读取失败时保持为空，保存时沿用已存密码 */
			}
		}
		sshDraft = form;
		open.set(true);
		if (form.authMethod === "agent") loadAgentIdentities();
	};

	const openNew = () => {
		fieldErrorState.set(null);
		passwordRevealed.set(false);
		sshDraft = emptyDraft();
		open.set(true);
		loadAgentIdentities();
	};

	const close = () => {
		sshDraft = null;
		open.set(false);
		fieldErrorState.set(null);
		passwordRevealed.set(false);
	};

	const patchDraft = (patch: Partial<SshDraft>) => {
		const draft = sshDraft;
		if (!draft) return;
		Object.assign(draft, patch);
		if ("authMethod" in patch || "mode" in patch || "piRuntime" in patch)
			structRev.update((n) => n + 1);
		formRev.update((n) => n + 1);
		if (fieldErrorState()) fieldErrorState.set(null);
		if (patch.authMethod === "agent" && agentIdentities() === undefined)
			loadAgentIdentities();
	};

	/** The effective agent key: explicit pick, else the only detected key. */
	const agentPublicKey = (): string =>
		sshDraft?.agentPublicKey ??
		(agentIdentities()?.length === 1
			? (agentIdentities()?.[0].publicKey ?? "")
			: "");

	const waitingForAgent = () =>
		sshDraft?.authMethod === "agent" && agentIdentities() === undefined;

	const agentStatus = () => {
		const identities = agentIdentities();
		if (identities === undefined) return t("connection.sshAgentChecking");
		if (identities === null) return t("connection.sshAgentUnavailable");
		const key = agentPublicKey();
		if (key && !identities.some((identity) => identity.publicKey === key))
			return t("connection.sshAgentKeyMissing");
		return identities.length > 0
			? t("connection.sshAgentDetected")
			: t("connection.sshAgentEmpty");
	};

	const save = async (toasts: AppToasts) => {
		const base = sshDraft;
		if (!base || !base.name.trim() || !base.hostname.trim()) return;
		if (
			base.mode === "direct" &&
			base.authMethod === "key" &&
			!base.identityFile.trim()
		) {
			fieldErrorState.set({
				field: "identityFile",
				message: t("connection.privateKeyRequired"),
			});
			return;
		}
		if (base.authMethod === "password" && !base.password && !base.hasPassword) {
			fieldErrorState.set({
				field: "password",
				message: t("connection.passwordRequired"),
			});
			return;
		}
		const draft = { ...base, agentPublicKey: agentPublicKey() };
		busy.set(true);
		try {
			await client.saveSshConnection(
				connectionFromDraft(draft),
				draft.password || undefined,
				draft.localPiResources === draft.initialLocalPiResources
					? undefined
					: draft.localPiResources,
			);
			close();
			await deps.refresh();
			deps.toasts.show({ variant: "success", title: t("connection.sshSaved") });
		} catch (caught) {
			(sshDraft === base ? toasts : deps.toasts).show({
				variant: "error",
				title: t("connection.sshSaveFailed"),
				description: String(caught).includes("SSH_LOCAL_PI_RESOURCES_BUSY")
					? t("connection.localPiResourcesBusy")
					: userErrorMessage(caught),
			});
		} finally {
			busy.set(false);
		}
	};

	const test = async (toasts: AppToasts) => {
		const base = sshDraft;
		if (!base) return;
		const draft = { ...base, agentPublicKey: agentPublicKey() };
		const label = draft.name.trim() || draft.hostname.trim();
		testing.set(true);
		try {
			const result = await client.testSshConnectionDraft(
				connectionFromDraft(draft),
				draft.password || undefined,
			);
			showConnectionTestToast(toasts, label, { ok: true, result });
		} catch (caught) {
			showConnectionTestToast(toasts, label, { ok: false, error: caught });
		} finally {
			testing.set(false);
		}
	};

	return {
		draft: () => sshDraft,
		open,
		structRev,
		formRev,
		busy,
		testing,
		fieldErrorState,
		passwordRevealed,
		agentIdentities,
		loadAgentIdentities,
		openEdit,
		openNew,
		close,
		patchDraft,
		agentPublicKey,
		waitingForAgent,
		agentStatus,
		save,
		test,
	};
}

export type SshEditor = ReturnType<typeof createSshEditor>;

/** The SSH add/edit dialog, as `ssh-connection-editor` in the WebUI. */
export function SshConnectionEditorDialog(props: { editor: SshEditor }) {
	const editor = props.editor;
	const mounted = useMountedDialog(editor.open);
	return (
		<Dialog
			testID="settings-ssh-editor"
			open={editor.open()}
			accessibilityLabel={
				editor.draft()?.name
					? t("settings.editSshConnection")
					: t("settings.addSshConnection")
			}
			class="max-w-lg"
			onOpenChange={({ open }) => {
				if (!open) editor.close();
			}}
			onClose={mounted.onClose}
		>
			{() => {
				const draft = mounted.mounted() ? editor.draft() : null;
				if (!draft) return null;
				const toasts = new AppToasts();
				const err = () => editor.fieldErrorState();
				return (
					<>
						<DialogHeader>
							<DialogTitle>
								{() => {
									void editor.formRev();
									return draft.name
										? t("settings.editSshConnection")
										: t("settings.addSshConnection");
								}}
							</DialogTitle>
						</DialogHeader>
						<View class="flex-row gap-3">
							{field(
								t("settings.connectionName"),
								<Input
									size="sm"
									testID="settings-ssh-name"
									value={draft.name}
									placeholder={String(t("settings.productionServer"))}
									onChange={(event) => editor.patchDraft({ name: event.value })}
								/>,
								{ class: "flex-1" },
							)}
							{field(
								t("settings.connectionMethod"),
								<Select
									size="sm"
									testID="settings-ssh-mode"
									items={[
										{
											value: "direct",
											title: String(t("settings.directConnection")),
										},
										{
											value: "config",
											title: String(t("settings.sshConfigHost")),
										},
									]}
									value={draft.mode}
									onChange={(event) =>
										editor.patchDraft({
											mode: event.value as SshDraft["mode"],
										})
									}
								/>,
								{ class: "flex-1" },
							)}
						</View>
						{() => {
							void editor.structRev();
							return field(
								draft.mode === "config"
									? t("connection.hostAlias")
									: t("connection.host"),
								<Input
									size="sm"
									testID="settings-ssh-host"
									value={draft.hostname}
									placeholder={
										draft.mode === "config" ? "devbox" : "example.com"
									}
									onChange={(event) =>
										editor.patchDraft({ hostname: event.value })
									}
								/>,
							);
						}}
						{() => {
							void editor.structRev();
							return draft.mode === "direct" ? (
								<View class="flex-row gap-3">
									{field(
										t("connection.username"),
										<Input
											size="sm"
											testID="settings-ssh-user"
											value={draft.user}
											placeholder="root"
											onChange={(event) =>
												editor.patchDraft({ user: event.value })
											}
										/>,
										{ class: "flex-1" },
									)}
									{field(
										t("connection.port"),
										<Input
											size="sm"
											testID="settings-ssh-port"
											value={draft.port}
											onChange={(event) =>
												editor.patchDraft({ port: event.value })
											}
										/>,
										{ class: "w-24" },
									)}
								</View>
							) : null;
						}}
						{() => {
							void editor.structRev();
							return field(
								t("connection.authentication"),
								<Select
									size="sm"
									testID="settings-ssh-auth"
									items={[
										{ value: "agent", title: String(t("connection.sshAgent")) },
										{
											value: "password",
											title: String(t("connection.password")),
										},
										...(draft.mode === "direct"
											? [
													{
														value: "key",
														title: String(t("connection.privateKey")),
													},
												]
											: []),
									]}
									value={draft.authMethod}
									onChange={(event) =>
										editor.patchDraft({
											authMethod: event.value as SshAuthMethod,
										})
									}
								/>,
							);
						}}
						{() => {
							void editor.structRev();
							void editor.formRev();
							if (draft.authMethod !== "agent") return null;
							const identities = editor.agentIdentities();
							const key = editor.agentPublicKey();
							const savedKeyMissing =
								Boolean(key) &&
								identities != null &&
								!identities.some((identity) => identity.publicKey === key);
							return field(
								t("connection.sshAgentKey"),
								<View class="flex-row gap-2">
									<View class="min-w-0 flex-1">
										<Select
											size="sm"
											testID="settings-ssh-agent-key"
											items={[
												{
													value: "auto",
													title: String(t("connection.sshAgentAuto")),
												},
												...(savedKeyMissing
													? [
															{
																value: key,
																title: String(t("connection.sshAgentSavedKey")),
															},
														]
													: []),
												...(identities ?? []).map((identity) => ({
													value: identity.publicKey,
													title: identity.comment
														? `${identity.comment} · ${identity.fingerprint}`
														: identity.fingerprint,
												})),
											]}
											value={key || "auto"}
											onChange={(event) =>
												editor.patchDraft({
													agentPublicKey:
														event.value === "auto" ? "" : event.value,
												})
											}
										/>
									</View>
									<Button
										testID="settings-ssh-agent-refresh"
										variant="outline"
										size="sm"
										disabled={
											editor.waitingForAgent() ||
											editor.busy() ||
											editor.testing()
										}
										onPress={() => editor.loadAgentIdentities()}
									>
										<Text class="font-sans">{t("common.refresh")}</Text>
									</Button>
								</View>,
								{
									class: "min-w-0",
									footer: (
										<>
											<Text
												testID="settings-ssh-agent-status"
												class="font-sans text-xs text-muted-foreground"
											>
												{editor.agentStatus()}
											</Text>
											{identities === null ? (
												<Text class="font-sans text-xs text-muted-foreground">
													{t("connection.sshAgentTroubleshooting")}
												</Text>
											) : null}
										</>
									),
								},
							);
						}}
						{field(
							t("connection.runtimeLocation"),
							<Select
								size="sm"
								testID="settings-ssh-runtime"
								items={[
									{
										value: "workspace",
										title: String(t("connection.piWorkspace")),
									},
									{
										value: "local",
										title: String(t("connection.piLocal")),
									},
								]}
								value={draft.piRuntime}
								onChange={(event) =>
									editor.patchDraft({ piRuntime: event.value as PiRuntime })
								}
							/>,
						)}
						{() => {
							void editor.structRev();
							return draft.piRuntime === "local" ? (
								<View class="flex-row items-start gap-3">
									<View class="min-w-0 flex-1 gap-1 py-2">
										<Text class="font-sans text-xs">
											{t("connection.localPiResources")}
										</Text>
										<Text class="font-sans text-xs text-muted-foreground">
											{t("connection.localPiResourcesDescription")}
										</Text>
										<Text class="font-sans text-xs text-muted-foreground">
											{t("connection.localPiResourcesWarning")}
										</Text>
									</View>
									<Switch
										testID="settings-ssh-local-resources"
										checked={draft.localPiResources}
										disabled={editor.busy()}
										onChange={({ checked }) =>
											editor.patchDraft({ localPiResources: checked })
										}
									/>
								</View>
							) : null;
						}}
						{() => {
							void editor.structRev();
							const revealed = editor.passwordRevealed();
							return draft.authMethod === "password"
								? field(
										t("connection.password"),
										<View class="flex-row items-center gap-1">
											<Input
												size="sm"
												testID="settings-ssh-password"
												class="flex-1"
												masked={!revealed}
												value={draft.password}
												placeholder={String(t("connection.sshPassword"))}
												onChange={(event) =>
													editor.patchDraft({ password: event.value })
												}
											/>
											{() => {
												void editor.formRev();
												const shown = editor.passwordRevealed();
												const label = shown
													? t("settings.hidePassword")
													: t("settings.showPassword");
												return (
													<SettingsIconButton
														testID="settings-ssh-password-reveal"
														disabled={!draft.password}
														accessibilityLabel={label}
														tooltip={label}
														onPress={() =>
															editor.passwordRevealed.set(
																!editor.passwordRevealed(),
															)
														}
													>
														<Icon name={shown ? "EyeOff" : "Eye"} size={16} />
													</SettingsIconButton>
												);
											}}
										</View>,
										{ footer: fieldError(err, "password") },
									)
								: null;
						}}
						{() => {
							void editor.structRev();
							return draft.mode === "direct" && draft.authMethod === "key"
								? field(
										t("connection.privateKeyPath"),
										<Input
											size="sm"
											testID="settings-ssh-identity"
											value={draft.identityFile}
											placeholder="~/.ssh/id_ed25519"
											onChange={(event) =>
												editor.patchDraft({ identityFile: event.value })
											}
										/>,
										{
											labelIcon: "KeyRound",
											footer: fieldError(err, "identityFile"),
										},
									)
								: null;
						}}
						{() => {
							void editor.structRev();
							return draft.mode === "direct"
								? field(
										t("connection.proxyJump"),
										<Input
											size="sm"
											testID="settings-ssh-proxy"
											value={draft.proxyJump}
											placeholder="user@jump.example.com:22"
											onChange={(event) =>
												editor.patchDraft({ proxyJump: event.value })
											}
										/>,
									)
								: null;
						}}
						{() => {
							void editor.formRev();
							const busyNow = editor.busy();
							const testingNow = editor.testing();
							const waiting = editor.waitingForAgent();
							return (
								<DialogFooter class="mt-1 items-center justify-between">
									<Button
										testID="settings-ssh-test"
										variant="outline"
										size="sm"
										disabled={busyNow || testingNow || waiting}
										onPress={() => void editor.test(toasts)}
									>
										<Text class="font-sans">
											{testingNow
												? t("connection.testingConnection")
												: t("connection.testConnection")}
										</Text>
									</Button>
									<View class="flex-row gap-2">
										<Button
											testID="settings-ssh-cancel"
											variant="outline"
											size="sm"
											onPress={() => editor.close()}
										>
											<Text class="font-sans">{t("common.cancel")}</Text>
										</Button>
										<Button
											testID="settings-ssh-save"
											size="sm"
											disabled={
												busyNow ||
												waiting ||
												!draft.name.trim() ||
												!draft.hostname.trim()
											}
											onPress={() => void editor.save(toasts)}
										>
											<Text class="font-sans">
												{busyNow ? t("common.saving") : t("common.save")}
											</Text>
										</Button>
									</View>
								</DialogFooter>
							);
						}}
						<DialogClose
							accessibilityLabel={t("common.close")}
							onPress={() => editor.close()}
						/>
						<AppToastStack toasts={toasts} />
					</>
				);
			}}
		</Dialog>
	);
}

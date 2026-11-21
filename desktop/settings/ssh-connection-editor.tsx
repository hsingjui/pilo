import { signal, Text, View } from "nsh";

import type {
	SshAgentIdentity,
	SshConnectionInfo,
} from "@/lib/api/connections-types";
import type { PiRuntime, SshAuthMethod } from "@/lib/api/pi-runtime-types";
import { userErrorMessage } from "@/lib/app-error";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { field, fieldError, hint } from "./connection-form";
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
	setResult: (id: string, text: string) => void;
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
	const status = signal<string | null>(null);
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
		status.set(null);
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
		status.set(null);
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

	const save = async () => {
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
		status.set(null);
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
			deps.setResult(draft.id, t("connection.sshSaved"));
		} catch (caught) {
			status.set(
				`${t("connection.sshSaveFailed")} · ${
					String(caught).includes("SSH_LOCAL_PI_RESOURCES_BUSY")
						? t("connection.localPiResourcesBusy")
						: userErrorMessage(caught)
				}`,
			);
		} finally {
			busy.set(false);
		}
	};

	const test = async () => {
		const base = sshDraft;
		if (!base) return;
		const draft = { ...base, agentPublicKey: agentPublicKey() };
		const label = draft.name.trim() || draft.hostname.trim();
		testing.set(true);
		status.set(null);
		try {
			const result = await client.testSshConnectionDraft(
				connectionFromDraft(draft),
				draft.password || undefined,
			);
			status.set(
				`${t("connection.available", { name: label })} · pilo-server ${
					result.serverVersion
				} · protocol ${result.protocolVersion}`,
			);
		} catch (caught) {
			status.set(
				`${t("connection.connectionFailed", { name: label })} · ${userErrorMessage(caught)}`,
			);
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
		status,
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

/** The SSH add/edit dialog, as `ssh-connection-editor` in the Tauri app. */
export function SshConnectionEditorDialog(props: { editor: SshEditor }) {
	const editor = props.editor;
	const draft = editor.draft();
	if (!draft) return null;
	const err = () => editor.fieldErrorState();
	return (
		<Dialog
			testID="settings-ssh-editor"
			open={true}
			accessibilityLabel={
				draft.name
					? t("settings.editSshConnection")
					: t("settings.addSshConnection")
			}
			class="max-w-lg"
			onOpenChange={({ open }) => {
				if (!open) editor.close();
			}}
		>
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
				<View class="flex-1 gap-1">
					<Text class="font-sans text-xs">{t("settings.connectionName")}</Text>
					<Input
						testID="settings-ssh-name"
						value={draft.name}
						placeholder={String(t("settings.productionServer"))}
						onChange={(event) => editor.patchDraft({ name: event.value })}
					/>
				</View>
				<View class="flex-1 gap-1">
					<Text class="font-sans text-xs">
						{t("settings.connectionMethod")}
					</Text>
					<Select
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
					/>
				</View>
			</View>
			{() => {
				void editor.structRev();
				return field(
					draft.mode === "config"
						? t("connection.hostAlias")
						: t("connection.host"),
					<Input
						testID="settings-ssh-host"
						value={draft.hostname}
						placeholder={draft.mode === "config" ? "devbox" : "example.com"}
						onChange={(event) => editor.patchDraft({ hostname: event.value })}
					/>,
				);
			}}
			{() => {
				void editor.structRev();
				return draft.mode === "direct" ? (
					<View class="flex-row gap-3">
						<View class="flex-1 gap-1">
							<Text class="font-sans text-xs">{t("connection.username")}</Text>
							<Input
								testID="settings-ssh-user"
								value={draft.user}
								placeholder="root"
								onChange={(event) => editor.patchDraft({ user: event.value })}
							/>
						</View>
						<View class="w-24 gap-1">
							<Text class="font-sans text-xs">{t("connection.port")}</Text>
							<Input
								testID="settings-ssh-port"
								value={draft.port}
								onChange={(event) => editor.patchDraft({ port: event.value })}
							/>
						</View>
					</View>
				) : null;
			}}
			{() => {
				void editor.structRev();
				return field(
					t("connection.authentication"),
					<Select
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
				return (
					<View class="min-w-0 gap-1">
						<Text class="font-sans text-xs">{t("connection.sshAgentKey")}</Text>
						<View class="flex-row gap-2">
							<View class="min-w-0 flex-1">
								<Select
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
											agentPublicKey: event.value === "auto" ? "" : event.value,
										})
									}
								/>
							</View>
							<Button
								testID="settings-ssh-agent-refresh"
								variant="outline"
								size="sm"
								disabled={
									editor.waitingForAgent() || editor.busy() || editor.testing()
								}
								onPress={() => editor.loadAgentIdentities()}
							>
								<Text class="font-sans">{t("common.refresh")}</Text>
							</Button>
						</View>
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
					</View>
				);
			}}
			{field(
				t("connection.runtimeLocation"),
				<Select
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
				return draft.authMethod === "password" ? (
					<View class="gap-1">
						<Text class="font-sans text-xs">{t("connection.password")}</Text>
						<View class="flex-row items-center gap-1">
							<Input
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
								return (
									<Button
										testID="settings-ssh-password-reveal"
										variant="ghost"
										size="icon"
										class="h-8 w-8 text-muted-foreground hover:text-foreground"
										disabled={!draft.password}
										accessibilityLabel={
											shown
												? t("settings.hidePassword")
												: t("settings.showPassword")
										}
										tooltip={hint(
											shown
												? t("settings.hidePassword")
												: t("settings.showPassword"),
										)}
										onPress={() =>
											editor.passwordRevealed.set(!editor.passwordRevealed())
										}
									>
										<Icon name={shown ? "EyeOff" : "Eye"} size={16} />
									</Button>
								);
							}}
						</View>
						{fieldError(err, "password")}
					</View>
				) : null;
			}}
			{() => {
				void editor.structRev();
				return draft.mode === "direct" && draft.authMethod === "key" ? (
					<View class="gap-1">
						<View class="flex-row items-center gap-1">
							<Icon name="KeyRound" size={14} />
							<Text class="font-sans text-xs">
								{t("connection.privateKeyPath")}
							</Text>
						</View>
						<Input
							testID="settings-ssh-identity"
							value={draft.identityFile}
							placeholder="~/.ssh/id_ed25519"
							onChange={(event) =>
								editor.patchDraft({ identityFile: event.value })
							}
						/>
						{fieldError(err, "identityFile")}
					</View>
				) : null;
			}}
			{() => {
				void editor.structRev();
				return draft.mode === "direct"
					? field(
							t("connection.proxyJump"),
							<Input
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
			{() =>
				editor.status() ? (
					<Text
						testID="settings-ssh-error"
						class="font-sans text-xs text-muted-foreground"
					>
						{editor.status()}
					</Text>
				) : null
			}
			{() => {
				void editor.formRev();
				const busyNow = editor.busy();
				const testingNow = editor.testing();
				const waiting = editor.waitingForAgent();
				return (
					<View class="mt-1 flex-row flex-wrap items-center justify-between gap-2">
						<Button
							testID="settings-ssh-test"
							variant="outline"
							size="sm"
							disabled={busyNow || testingNow || waiting}
							onPress={() => void editor.test()}
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
								onPress={() => void editor.save()}
							>
								<Text class="font-sans">
									{busyNow ? t("common.saving") : t("common.save")}
								</Text>
							</Button>
						</View>
					</View>
				);
			}}
			<View
				accessibilityLabel={t("common.close")}
				class="absolute right-3 top-3 size-6 items-center justify-center rounded-xs opacity-70 hover:opacity-100"
				onPress={() => editor.close()}
			>
				<Icon name="X" size={16} />
			</View>
		</Dialog>
	);
}

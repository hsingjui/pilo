import { Scroll, signal, Text, View, windowSize } from "nsh";
import { Collapsible } from "nsh/base";

import type {
	SshAgentIdentity,
	SshConfigHost,
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
import {
	chevronRotateStyle,
	collapsibleRevealProps,
	useMountedDialog,
} from "../ui/motion";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { scrollbarLook, scrollbarTheme } from "../ui/scrollbar";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { field, fieldError } from "./connection-form";
import { showConnectionTestToast } from "./connection-settings";
import { SettingsIconButton } from "./layout";
import {
	connectionFromDraft,
	draftFromInfo,
	emptyDraft,
	parseSshPort,
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
	const probingPi = signal(false);
	const advancedOpen = signal(false);
	const fieldErrorState = signal<SshFieldError | null>(null);
	const passwordRevealed = signal(false);
	/** `undefined` while loading, `null` when the agent could not be read. */
	const agentIdentities = signal<SshAgentIdentity[] | null | undefined>(
		undefined,
	);
	const configHosts = signal<SshConfigHost[]>([]);
	const localKeys = signal<string[]>([]);
	let openSeq = 0;

	const actionBusy = () => busy() || testing() || probingPi();

	const loadAgentIdentities = (seq = openSeq) => {
		agentIdentities.set(undefined);
		client
			.listSshAgentIdentities()
			.then((identities) => {
				if (seq === openSeq) agentIdentities.set(identities);
			})
			.catch(() => {
				if (seq === openSeq) agentIdentities.set(null);
			});
	};

	const loadDiscoveryLists = (seq = openSeq) => {
		if (client.listSshConfigHosts) {
			client
				.listSshConfigHosts()
				.then((hosts) => {
					if (seq === openSeq) configHosts.set(hosts);
				})
				.catch(() => {
					if (seq === openSeq) configHosts.set([]);
				});
		}
		if (client.listSshLocalKeys) {
			client
				.listSshLocalKeys()
				.then((keys) => {
					if (seq === openSeq) localKeys.set(keys);
				})
				.catch(() => {
					if (seq === openSeq) localKeys.set([]);
				});
		}
	};

	const openEdit = async (info: SshConnectionInfo) => {
		const seq = ++openSeq;
		fieldErrorState.set(null);
		passwordRevealed.set(false);
		const form = draftFromInfo(info);
		/* 编辑时直接回填已保存的密码，无需在输入框里提示“已保存”。 */
		if (form.authMethod === "password" && form.hasPassword && !form.password) {
			try {
				const loaded = (await client.getSshConnectionPassword(form.id)) ?? "";
				if (seq !== openSeq) return;
				form.password = loaded;
			} catch {
				if (seq !== openSeq) return;
				/* 读取失败时保持为空，保存时沿用已存密码 */
			}
		}
		if (seq !== openSeq) return;
		sshDraft = form;
		advancedOpen.set(
			Boolean(
				form.proxyJump ||
				form.piExecutable ||
				form.piRuntime === "local" ||
				form.localPiResources,
			),
		);
		open.set(true);
		if (form.authMethod === "agent") loadAgentIdentities(seq);
		loadDiscoveryLists(seq);
	};

	const openNew = () => {
		const seq = ++openSeq;
		fieldErrorState.set(null);
		passwordRevealed.set(false);
		sshDraft = emptyDraft();
		advancedOpen.set(false);
		open.set(true);
		loadAgentIdentities(seq);
		loadDiscoveryLists(seq);
	};

	const close = () => {
		openSeq += 1;
		sshDraft = null;
		open.set(false);
		advancedOpen.set(false);
		fieldErrorState.set(null);
		passwordRevealed.set(false);
	};

	const patchDraft = (patch: Partial<SshDraft>) => {
		const draft = sshDraft;
		if (!draft) return;
		const nextPatch = { ...patch };
		// 切到 ~/.ssh/config 模式时，指定私钥模式不可用，自动回退到 SSH Agent 避免静默失效。
		if (nextPatch.mode === "config" && draft.authMethod === "key") {
			nextPatch.authMethod = "agent";
		}
		Object.assign(draft, nextPatch);
		if (
			"authMethod" in nextPatch ||
			"mode" in nextPatch ||
			"piRuntime" in nextPatch
		)
			structRev.update((n) => n + 1);
		formRev.update((n) => n + 1);
		if (fieldErrorState()) fieldErrorState.set(null);
		if (nextPatch.authMethod === "agent" && agentIdentities() === undefined)
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

	const validateDraft = (
		base: SshDraft,
		{ requireName }: { requireName: boolean },
	): boolean => {
		if (requireName && !base.name.trim()) return false;
		if (!base.hostname.trim()) return false;
		if (base.mode === "direct") {
			const parsedPort = parseSshPort(base.port);
			if (parsedPort !== null && !Number.isFinite(parsedPort)) {
				fieldErrorState.set({
					field: "port",
					message: t("connection.portInvalid"),
				});
				return false;
			}
		}
		if (
			base.mode === "direct" &&
			base.authMethod === "key" &&
			!base.identityFile.trim()
		) {
			fieldErrorState.set({
				field: "identityFile",
				message: t("connection.privateKeyRequired"),
			});
			return false;
		}
		if (base.authMethod === "password" && !base.password && !base.hasPassword) {
			fieldErrorState.set({
				field: "password",
				message: t("connection.passwordRequired"),
			});
			return false;
		}
		return true;
	};

	const save = async (toasts: AppToasts) => {
		const base = sshDraft;
		if (!base || actionBusy() || !validateDraft(base, { requireName: true }))
			return;
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
				description: userErrorMessage(caught),
			});
		} finally {
			busy.set(false);
		}
	};

	const probePi = async (toasts: AppToasts) => {
		const draft = sshDraft;
		if (!draft || draft.isNew || actionBusy()) return;
		probingPi.set(true);
		try {
			const info = await client.probeConnectionPi(
				draft.id,
				draft.piExecutable.trim() || null,
			);
			if (sshDraft === draft) {
				sshDraft.piExecutable = info.executable;
				formRev.update((n) => n + 1);
			}
			(sshDraft === draft ? toasts : deps.toasts).show({
				variant: "success",
				title: t("connection.piAvailable", {
					name: draft.name.trim() || draft.hostname.trim(),
				}),
				description: [info.executable, info.version]
					.filter(Boolean)
					.join(" · "),
			});
		} catch (caught) {
			(sshDraft === draft ? toasts : deps.toasts).show({
				variant: "error",
				title: t("connection.piUnavailable", {
					name: draft.name.trim() || draft.hostname.trim(),
				}),
				description: userErrorMessage(caught),
			});
		} finally {
			probingPi.set(false);
		}
	};

	const test = async (toasts: AppToasts) => {
		const base = sshDraft;
		if (!base || actionBusy() || !validateDraft(base, { requireName: false }))
			return;
		const draft = { ...base, agentPublicKey: agentPublicKey() };
		const label = draft.name.trim() || draft.hostname.trim();
		testing.set(true);
		try {
			const result = await client.testSshConnectionDraft(
				connectionFromDraft(draft),
				draft.password || undefined,
			);
			showConnectionTestToast(sshDraft === base ? toasts : deps.toasts, label, {
				ok: true,
				result,
			});
		} catch (caught) {
			showConnectionTestToast(sshDraft === base ? toasts : deps.toasts, label, {
				ok: false,
				error: caught,
			});
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
		probingPi,
		advancedOpen,
		fieldErrorState,
		passwordRevealed,
		agentIdentities,
		configHosts,
		localKeys,
		loadAgentIdentities,
		openEdit,
		openNew,
		close,
		patchDraft,
		agentPublicKey,
		waitingForAgent,
		agentStatus,
		probePi,
		save,
		test,
	};
}

export type SshEditor = ReturnType<typeof createSshEditor>;

/** The SSH add/edit dialog, as `ssh-connection-editor` in the WebUI. */
export function SshConnectionEditorDialog(props: { editor: SshEditor }) {
	const editor = props.editor;
	const mounted = useMountedDialog(editor.open);
	const maxBodyHeight = () => Math.max(320, windowSize().height - 220);
	return (
		<Dialog
			testID="settings-ssh-editor"
			open={editor.open()}
			accessibilityLabel={
				editor.open() && editor.draft()?.isNew === false
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
				const draftMode = () => {
					editor.structRev();
					return draft.mode;
				};
				const draftPiRuntime = () => {
					editor.structRev();
					return draft.piRuntime;
				};
				const draftLocalPiResources = () => {
					editor.formRev();
					return draft.localPiResources;
				};
				return (
					<>
						<DialogHeader>
							<DialogTitle>
								{() =>
									draft.isNew
										? t("settings.addSshConnection")
										: t("settings.editSshConnection")
								}
							</DialogTitle>
						</DialogHeader>
						<Scroll
							testID="settings-ssh-scroll"
							class="-mx-(--pilo-dialog-padding) min-h-0"
							contentClass="px-(--pilo-dialog-padding) py-0.5"
							style={{ maxHeight: maxBodyHeight() }}
							bounces={false}
							scrollbar={scrollbarTheme({ vertical: scrollbarLook() })}
						>
							<View class="gap-3">
								<View class="flex-row gap-3">
									{field(
										t("settings.connectionName"),
										<Input
											size="sm"
											testID="settings-ssh-name"
											value={(() => {
												editor.formRev();
												return draft.name;
											})()}
											placeholder={String(t("settings.productionServer"))}
											onChange={(event) =>
												editor.patchDraft({ name: event.value })
											}
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
											value={draftMode()}
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
									const hosts = editor.configHosts();
									return (
										<View class="gap-2">
											{draft.mode === "config" && hosts.length > 0
												? field(
														t("connection.selectSshConfigHost"),
														<Select
															size="sm"
															testID="settings-ssh-config-host-picker"
															placeholder={String(
																t("connection.selectSshConfigHost"),
															)}
															items={hosts.map((item) => {
																const detail = [
																	item.user && item.hostname
																		? `${item.user}@${item.hostname}`
																		: item.hostname,
																	item.port && item.port !== 22
																		? `:${item.port}`
																		: "",
																]
																	.filter(Boolean)
																	.join("");
																return {
																	value: item.host,
																	title: detail
																		? `${item.host} (${detail})`
																		: item.host,
																};
															})}
															value={(() => {
																editor.formRev();
																return hosts.some(
																	(h) => h.host === draft.hostname,
																)
																	? draft.hostname
																	: undefined;
															})()}
															onChange={(event) => {
																if (!event.value) return;
																editor.patchDraft({
																	hostname: event.value,
																	...(draft.name.trim()
																		? {}
																		: { name: event.value }),
																});
															}}
														/>,
													)
												: null}
											{field(
												draft.mode === "config"
													? t("connection.hostAlias")
													: t("connection.host"),
												<Input
													size="sm"
													testID="settings-ssh-host"
													value={(() => {
														editor.formRev();
														return draft.hostname;
													})()}
													placeholder={
														draft.mode === "config" ? "devbox" : "example.com"
													}
													onChange={(event) =>
														editor.patchDraft({ hostname: event.value })
													}
												/>,
											)}
										</View>
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
												{ class: "w-24", footer: fieldError(err, "port") },
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
												{
													value: "agent",
													title: String(t("connection.sshAgent")),
												},
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
									if (draft.authMethod !== "agent") return null;
									const identities = editor.agentIdentities();
									const selectedAgentKey = () => {
										editor.formRev();
										return editor.agentPublicKey();
									};
									const savedKeyMissing = () => {
										const key = selectedAgentKey();
										return (
											Boolean(key) &&
											identities != null &&
											!identities.some((identity) => identity.publicKey === key)
										);
									};
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
														...(savedKeyMissing()
															? [
																	{
																		value: selectedAgentKey(),
																		title: String(
																			t("connection.sshAgentSavedKey"),
																		),
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
													value={selectedAgentKey() || "auto"}
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
													editor.testing() ||
													editor.probingPi()
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
														{() => {
															editor.formRev();
															return editor.agentStatus();
														}}
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
																<Icon
																	name={shown ? "EyeOff" : "Eye"}
																	size={16}
																/>
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
									const keys = editor.localKeys();
									return draft.mode === "direct" && draft.authMethod === "key"
										? field(
												t("connection.privateKeyPath"),
												<View class="gap-1.5">
													<Input
														size="sm"
														testID="settings-ssh-identity"
														value={(() => {
															editor.formRev();
															return draft.identityFile;
														})()}
														placeholder="~/.ssh/id_ed25519"
														onChange={(event) =>
															editor.patchDraft({ identityFile: event.value })
														}
													/>
													{keys.length > 0 ? (
														<Select
															size="sm"
															testID="settings-ssh-local-keys"
															placeholder={String(
																t("connection.selectLocalKey"),
															)}
															items={keys.map((keyPath) => ({
																value: keyPath,
																title: keyPath,
															}))}
															value={(() => {
																editor.formRev();
																return keys.includes(draft.identityFile)
																	? draft.identityFile
																	: undefined;
															})()}
															onChange={(event) => {
																if (!event.value) return;
																editor.patchDraft({
																	identityFile: event.value,
																});
															}}
														/>
													) : null}
												</View>,
												{
													labelIcon: "KeyRound",
													footer: fieldError(err, "identityFile"),
												},
											)
										: null;
								}}

								{/* 高级选项：运行位置、本地 Pi 资源、跳板机与 Pi 路径统一收敛 */}
								<View class="border-t border-border/60 pt-2">
									<Button
										testID="settings-ssh-advanced-toggle"
										variant="ghost"
										size="sm"
										class="h-7 w-full justify-between px-1"
										onPress={() => editor.advancedOpen.update((open) => !open)}
									>
										<Text class="font-sans text-xs font-medium text-muted-foreground">
											{t("connection.advancedOptions")}
										</Text>
										<View
											style={chevronRotateStyle(editor.advancedOpen(), -90, 0)}
										>
											<Icon name="ChevronDown" size={14} />
										</View>
									</Button>
									<Collapsible
										open={editor.advancedOpen()}
										{...collapsibleRevealProps()}
										content={
											<View class="gap-3 pt-2">
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
														value={draftPiRuntime()}
														onChange={(event) =>
															editor.patchDraft({
																piRuntime: event.value as PiRuntime,
															})
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
																checked={draftLocalPiResources()}
																disabled={editor.busy()}
																onChange={({ checked }) =>
																	editor.patchDraft({
																		localPiResources: checked,
																	})
																}
															/>
														</View>
													) : (
														field(
															t("connection.piPath"),
															<View class="flex-row gap-2">
																<Input
																	size="sm"
																	testID="settings-ssh-pi"
																	class="flex-1 font-mono"
																	value={(() => {
																		editor.formRev();
																		return draft.piExecutable;
																	})()}
																	placeholder={String(
																		t("connection.autoDetect"),
																	)}
																	onChange={(event) =>
																		editor.patchDraft({
																			piExecutable: event.value,
																		})
																	}
																/>
																{!draft.isNew ? (
																	<Button
																		testID="settings-ssh-probe"
																		variant="outline"
																		size="sm"
																		class="shrink-0"
																		disabled={
																			editor.busy() ||
																			editor.testing() ||
																			editor.probingPi()
																		}
																		onPress={() => void editor.probePi(toasts)}
																	>
																		{() =>
																			editor.probingPi() ? (
																				<Spinner size={14} />
																			) : (
																				<Text class="font-sans">
																					{t("connection.detectPi")}
																				</Text>
																			)
																		}
																	</Button>
																) : null}
															</View>,
														)
													);
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
																		editor.patchDraft({
																			proxyJump: event.value,
																		})
																	}
																/>,
															)
														: null;
												}}
											</View>
										}
									/>
								</View>
							</View>
						</Scroll>
						{() => {
							void editor.formRev();
							const busyNow = editor.busy();
							const testingNow = editor.testing();
							const probingNow = editor.probingPi();
							const waiting = editor.waitingForAgent();
							return (
								<DialogFooter class="mt-1 items-center justify-between">
									<Button
										testID="settings-ssh-test"
										variant="outline"
										size="sm"
										disabled={
											busyNow ||
											testingNow ||
											probingNow ||
											waiting ||
											!draft.hostname.trim()
										}
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
												testingNow ||
												probingNow ||
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

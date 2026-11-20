import { type Accessor, type JSX, signal, Text, View } from "nsh";

import type {
	SshAgentIdentity,
	SshConnectionInfo,
	WslConnectionInfo,
} from "@/lib/api/connections-types";
import type {
	Connection,
	PiRuntime,
	SshTarget,
	WslDistribution,
} from "@/lib/api/pi-runtime-types";
import type { AppState } from "../state/app-state";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection, SettingsStatus } from "./layout";

/** The native calls the pane makes; tests pass a scripted stand-in. */
export type ConnectionsClient = Pick<
	NshPiloClient,
	| "getLocalConnection"
	| "updateConnectionSettings"
	| "setConnectionShownInHome"
	| "getConnectionHealth"
	| "probeConnectionPi"
	| "testLocalConnection"
	| "listSshConnections"
	| "listSshAgentIdentities"
	| "saveSshConnection"
	| "getSshConnectionPassword"
	| "removeSshConnection"
	| "testSshConnection"
	| "testSshConnectionDraft"
	| "listWslDistributions"
	| "listWslConnections"
	| "saveWslConnection"
	| "removeWslConnection"
	| "testWslConnection"
>;

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function sshTargetLabel(target: SshTarget): string {
	if (target.type === "config_host") return target.host;
	const host =
		target.port && target.port !== 22
			? `${target.hostname}:${target.port}`
			: target.hostname;
	return target.user ? `${target.user}@${host}` : host;
}

type SshDraft = {
	id: string;
	name: string;
	mode: "direct" | "config";
	hostname: string;
	port: string;
	user: string;
	authMethod: "agent" | "password" | "key";
	agentPublicKey: string | null;
	identityFile: string;
	password: string;
	proxyJump: string;
	hasPassword: boolean;
	piExecutable: string;
	piRuntime: PiRuntime;
	localPiResources: boolean;
};

function newConnectionId() {
	return `ssh:${Date.now().toString(36)}${Math.random()
		.toString(36)
		.slice(2, 8)}`;
}

function emptyDraft(): SshDraft {
	return {
		id: newConnectionId(),
		name: "",
		mode: "direct",
		hostname: "",
		port: "22",
		user: "",
		authMethod: "agent",
		agentPublicKey: null,
		identityFile: "",
		password: "",
		proxyJump: "",
		hasPassword: false,
		piExecutable: "",
		piRuntime: "workspace",
		localPiResources: false,
	};
}

function draftFromInfo(info: SshConnectionInfo): SshDraft {
	const target =
		info.connection.kind.type === "ssh" ? info.connection.kind.target : null;
	if (!target) return emptyDraft();
	const auth = target.authMethod;
	const authMethod =
		typeof auth === "string" ? (auth as SshDraft["authMethod"]) : "agent";
	const agentPublicKey = typeof auth === "string" ? null : auth.agent_key;
	const base = {
		...emptyDraft(),
		id: info.connection.id,
		name: info.connection.name,
		authMethod,
		agentPublicKey,
		hasPassword: info.hasPassword,
		piExecutable: info.connection.piExecutable ?? "",
		piRuntime: info.connection.piRuntime ?? "workspace",
		localPiResources: info.localPiResources ?? false,
	};
	if (target.type === "config_host") {
		return { ...base, mode: "config", hostname: target.host };
	}
	return {
		...base,
		mode: "direct",
		hostname: target.hostname,
		port: target.port ? String(target.port) : "22",
		user: target.user ?? "",
		identityFile: target.identityFile ?? "",
		proxyJump: target.proxyJump ?? "",
	};
}

function connectionFromDraft(draft: SshDraft): Connection {
	const authMethod =
		draft.authMethod === "agent" && draft.agentPublicKey
			? { agent_key: draft.agentPublicKey }
			: draft.authMethod;
	const target: SshTarget =
		draft.mode === "config"
			? { type: "config_host", host: draft.hostname.trim(), authMethod }
			: {
					type: "direct",
					hostname: draft.hostname.trim(),
					port: draft.port.trim() ? Number(draft.port) : null,
					user: draft.user.trim() || null,
					identityFile:
						draft.authMethod === "key"
							? draft.identityFile.trim() || null
							: null,
					authMethod,
					proxyJump: draft.proxyJump.trim() || null,
				};
	return {
		id: draft.id,
		name: draft.name.trim(),
		piExecutable: draft.piExecutable.trim() || null,
		piRuntime: draft.piRuntime,
		kind: { type: "ssh", target },
	};
}

/** The "name + Pi path" editor shared by local and WSL connections. */
type ConfigureDraft = { id: string; name: string; piExecutable: string };

export function ConnectionsPane(props: {
	state: Accessor<AppState>;
	client: ConnectionsClient;
}) {
	const client = props.client;
	const local = signal<Connection | null>(null);
	const wslItems = signal<WslConnectionInfo[]>([]);
	const sshItems = signal<SshConnectionInfo[]>([]);
	const distros = signal<WslDistribution[] | null>(null);
	const agentKeys = signal<SshAgentIdentity[] | null>(null);
	const loading = signal(true);
	const testing = signal<Set<string>>(new Set());
	/** Per-connection diagnostics line after a test runs. */
	const results = signal<Record<string, string>>({});
	const configure = signal<ConfigureDraft | null>(null);
	const sshEditor = signal<SshDraft | null>(null);
	const removing = signal<Connection | null>(null);
	const sshBusy = signal(false);
	const sshError = signal<string | null>(null);

	const setTesting = (id: string, value: boolean) => {
		const next = new Set(testing());
		if (value) next.add(id);
		else next.delete(id);
		testing.set(next);
	};

	const setResult = (id: string, text: string) =>
		results.set({ ...results(), [id]: text });

	const refresh = async () => {
		const [localResult, sshResult, wslResult] = await Promise.allSettled([
			client.getLocalConnection(),
			client.listSshConnections(),
			client.listWslConnections(),
		]);
		if (localResult.status === "fulfilled") local.set(localResult.value);
		if (sshResult.status === "fulfilled") sshItems.set(sshResult.value);
		if (wslResult.status === "fulfilled") wslItems.set(wslResult.value);
		loading.set(false);
		ensureDistros();
	};
	refresh();

	const ensureDistros = () => {
		if (distros() !== null) return;
		client
			.listWslDistributions()
			.then(distros.set)
			.catch(() => distros.set([]));
	};

	const ensureAgentKeys = () => {
		if (agentKeys() !== null) return;
		client
			.listSshAgentIdentities()
			.then(agentKeys.set)
			.catch(() => agentKeys.set([]));
	};

	const diagnose = async (id: string) => {
		setTesting(id, true);
		setResult(id, "");
		try {
			const health = await client.getConnectionHealth(id);
			if (!health.reachable) {
				setResult(
					id,
					`${t("connection.connectionFailed", {
						name: connectionLabel(id),
					})} · ${health.error ?? ""}`,
				);
				return;
			}
			const pi = health.pi
				? `${health.pi.executable} ${health.pi.version}`
				: (health.piError ??
					t("connection.piUnavailable", {
						name: connectionLabel(id),
					}));
			setResult(
				id,
				`${t("connection.available", { name: connectionLabel(id) })} · ${
					health.latencyMs
				}ms · ${pi}`,
			);
		} catch (caught) {
			setResult(
				id,
				`${t("connection.connectionFailed")}: ${errorMessage(caught)}`,
			);
		} finally {
			setTesting(id, false);
		}
	};

	const connectionLabel = (id: string): string => {
		if (id === "local") return t("common.local");
		return (
			sshItems().find((item) => item.connection.id === id)?.connection.name ??
			wslItems().find((item) => item.connection.id === id)?.connection.name ??
			id
		);
	};

	const saveConfigure = async () => {
		const draft = configure();
		if (!draft) return;
		setTesting(draft.id, true);
		try {
			const saved = await client.updateConnectionSettings(
				draft.id,
				draft.name.trim(),
				draft.piExecutable.trim() || null,
			);
			if (draft.id === "local") local.set(saved);
			configure.set(null);
			await refresh();
		} catch (caught) {
			setResult(draft.id, errorMessage(caught));
		} finally {
			setTesting(draft.id, false);
		}
	};

	const probePi = async (id: string, executable: string) => {
		setTesting(`${id}:pi`, true);
		try {
			const info = await client.probeConnectionPi(
				id,
				executable.trim() || null,
			);
			setResult(id, `${info.executable} ${info.version}`);
		} catch (caught) {
			setResult(id, errorMessage(caught));
		} finally {
			setTesting(`${id}:pi`, false);
		}
	};

	const toggleHome = async (connection: Connection, shown: boolean) => {
		try {
			await client.setConnectionShownInHome(connection.id, shown);
			await refresh();
		} catch (caught) {
			setResult(connection.id, errorMessage(caught));
		}
	};

	const addWsl = async (distro: string) => {
		const connection: Connection = {
			id: `wsl:${distro}`,
			name: `WSL · ${distro}`,
			kind: { type: "wsl", distro },
			piRuntime: "workspace",
		};
		setTesting(`wsl:${distro}`, true);
		try {
			await client.saveWslConnection(connection);
			await refresh();
		} catch (caught) {
			setResult("wsl-add", errorMessage(caught));
		} finally {
			setTesting(`wsl:${distro}`, false);
		}
	};

	const removeConnection = async () => {
		const connection = removing();
		if (!connection) return;
		try {
			if (connection.kind.type === "ssh") {
				await client.removeSshConnection(connection.id);
			} else {
				await client.removeWslConnection(connection.id);
			}
			removing.set(null);
			await refresh();
		} catch (caught) {
			setResult(connection.id, errorMessage(caught));
		}
	};

	const saveSsh = async () => {
		const draft = sshEditor();
		if (!draft || sshBusy()) return;
		sshBusy.set(true);
		sshError.set(null);
		try {
			await client.saveSshConnection(
				connectionFromDraft(draft),
				draft.authMethod === "password" ? draft.password || null : null,
				draft.localPiResources,
			);
			sshEditor.set(null);
			await refresh();
		} catch (caught) {
			sshError.set(errorMessage(caught));
		} finally {
			sshBusy.set(false);
		}
	};

	const testSshDraft = async () => {
		const draft = sshEditor();
		if (!draft || sshBusy()) return;
		sshBusy.set(true);
		sshError.set(null);
		try {
			const result = await client.testSshConnectionDraft(
				connectionFromDraft(draft),
				draft.authMethod === "password" ? draft.password || null : null,
			);
			sshError.set(
				`${t("connection.available", { name: draft.name || draft.hostname })} · ${
					result.serverVersion
				}`,
			);
		} catch (caught) {
			sshError.set(errorMessage(caught));
		} finally {
			sshBusy.set(false);
		}
	};

	const sshValid = () => {
		const draft = sshEditor();
		if (!draft) return false;
		if (!draft.name.trim() || !draft.hostname.trim()) return false;
		if (draft.authMethod === "key" && !draft.identityFile.trim()) return false;
		if (
			draft.authMethod === "password" &&
			!draft.hasPassword &&
			!draft.password
		)
			return false;
		return true;
	};

	const patchDraft = (patch: Partial<SshDraft>) =>
		sshEditor.set({ ...sshEditor()!, ...patch });

	const actions = (connection: Connection, editor: "ssh" | "configure") => (
		<View class="flex-row items-center gap-1.5">
			<Button
				testID={`settings-conn-test-${connection.id}`}
				variant="outline"
				disabled={testing().has(connection.id)}
				onPress={() => void diagnose(connection.id)}
			>
				{() =>
					testing().has(connection.id) ? (
						<Spinner size={12} />
					) : (
						<Text>{t("connection.test")}</Text>
					)
				}
			</Button>
			<Button
				testID={`settings-conn-edit-${connection.id}`}
				variant="outline"
				onPress={() => {
					if (editor === "ssh") {
						const info = sshItems().find(
							(item) => item.connection.id === connection.id,
						);
						sshEditor.set(info ? draftFromInfo(info) : emptyDraft());
						sshError.set(null);
						ensureAgentKeys();
					} else {
						configure.set({
							id: connection.id,
							name: connection.name,
							piExecutable: connection.piExecutable ?? "",
						});
					}
				}}
			>
				<Text>{t("connection.configure")}</Text>
			</Button>
			{connection.kind.type !== "local" ? (
				<Button
					testID={`settings-conn-remove-${connection.id}`}
					variant="outline"
					onPress={() => removing.set(connection)}
				>
					<Icon name="Trash2" size={13} />
				</Button>
			) : null}
		</View>
	);

	const connectionRow = (
		title: string,
		detail: string,
		connection: Connection,
		editor: "ssh" | "configure",
		projectCount: number,
	) => (
		<View class="border-border/60 border-b px-3 py-2.5 last:border-b-0">
			<View class="flex-row items-center gap-3">
				<View class="min-w-0 flex-1">
					<Text class="truncate text-sm font-medium">{title}</Text>
					<Text class="truncate text-xs text-muted-foreground">
						{() =>
							`${detail} · ${
								projectCount
									? t("connection.projectCount", { count: projectCount })
									: t("connection.unlinkedProjects")
							}`
						}
					</Text>
				</View>
				{actions(connection, editor)}
			</View>
			<View class="mt-2 flex-row items-center gap-2">
				<Text class="text-xs text-muted-foreground">
					{() => t("connection.shownInHome")}
				</Text>
				<Switch
					testID={`settings-conn-home-${connection.id}`}
					checked={connection.shownInHome ?? false}
					onChange={({ checked }) => void toggleHome(connection, checked)}
				/>
			</View>
			{() =>
				results()[connection.id] ? (
					<Text
						testID={`settings-conn-result-${connection.id}`}
						class="mt-1.5 text-xs text-muted-foreground"
					>
						{results()[connection.id]}
					</Text>
				) : null
			}
		</View>
	);

	const localRow = () => {
		const connection = local();
		if (!connection) return null;
		return (
			<View class="px-3 py-2.5">
				<View class="flex-row items-center gap-3">
					<View class="min-w-0 flex-1">
						<Text class="truncate text-sm font-medium">{connection.name}</Text>
						<Text class="truncate text-xs text-muted-foreground">
							{() =>
								connection.piExecutable ?? String(t("connection.autoDetect"))
							}
						</Text>
					</View>
					{actions(connection, "configure")}
				</View>
				<View class="mt-2 flex-row items-center gap-2">
					<Text class="text-xs text-muted-foreground">
						{() => t("connection.shownInHome")}
					</Text>
					<Switch
						testID="settings-conn-home-local"
						checked={connection.shownInHome ?? true}
						onChange={({ checked }) => void toggleHome(connection, checked)}
					/>
				</View>
				{() =>
					results()["local"] ? (
						<Text
							testID="settings-conn-result-local"
							class="mt-1.5 text-xs text-muted-foreground"
						>
							{results()["local"]}
						</Text>
					) : null
				}
			</View>
		);
	};

	const sshRow = (info: SshConnectionInfo) => {
		const connection = info.connection;
		const target =
			connection.kind.type === "ssh"
				? sshTargetLabel(connection.kind.target)
				: "";
		return connectionRow(
			connection.name,
			`${t("connection.sshLabel")} · ${target}${
				info.localPiResources ? ` · ${t("connection.localPiResources")}` : ""
			}`,
			connection,
			"ssh",
			info.projectCount,
		);
	};

	const wslRow = (info: WslConnectionInfo) => {
		const connection = info.connection;
		return connectionRow(
			connection.name,
			t("connection.wslLabel"),
			connection,
			"configure",
			info.projectCount,
		);
	};

	const missingDistros = () => {
		const saved = new Set(
			wslItems().map((info) =>
				info.connection.kind.type === "wsl" ? info.connection.kind.distro : "",
			),
		);
		return (distros() ?? []).filter((distro) => !saved.has(distro.name));
	};

	const field = (label: string, child: JSX.Element) => (
		<View class="gap-1.5">
			<Text class="text-xs font-medium text-muted-foreground">{label}</Text>
			{child}
		</View>
	);

	const sshEditorDialog = () => {
		const draft = sshEditor();
		if (!draft) return null;
		const isPassword = draft.authMethod === "password";
		return (
			<Dialog
				testID="settings-ssh-editor"
				open={true}
				accessibilityLabel={t("settings.editSshConnection")}
				onOpenChange={({ open }) => {
					if (!open) sshEditor.set(null);
				}}
			>
				<DialogHeader>
					<DialogTitle>
						{() =>
							sshItems().some((item) => item.connection.id === draft.id)
								? t("settings.editSshConnection")
								: t("settings.addSshConnection")
						}
					</DialogTitle>
				</DialogHeader>
				{field(
					t("connection.nameLabel"),
					<Input
						testID="settings-ssh-name"
						value={draft.name}
						onChange={(event) => patchDraft({ name: event.value })}
					/>,
				)}
				{field(
					t("settings.connectionMethod"),
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
							patchDraft({ mode: event.value as SshDraft["mode"] })
						}
					/>,
				)}
				{field(
					draft.mode === "config"
						? t("settings.hostAlias")
						: t("settings.host"),
					<Input
						testID="settings-ssh-host"
						value={draft.hostname}
						onChange={(event) => patchDraft({ hostname: event.value })}
					/>,
				)}
				{draft.mode === "direct" ? (
					<View class="flex-row gap-2">
						<View class="flex-1 gap-1.5">
							<Text class="text-xs font-medium text-muted-foreground">
								{t("settings.username")}
							</Text>
							<Input
								testID="settings-ssh-user"
								value={draft.user}
								onChange={(event) => patchDraft({ user: event.value })}
							/>
						</View>
						<View class="w-24 gap-1.5">
							<Text class="text-xs font-medium text-muted-foreground">
								{t("settings.port")}
							</Text>
							<Input
								testID="settings-ssh-port"
								value={draft.port}
								onChange={(event) => patchDraft({ port: event.value })}
							/>
						</View>
					</View>
				) : null}
				{field(
					t("settings.authentication"),
					<Select
						testID="settings-ssh-auth"
						items={[
							{ value: "agent", title: String(t("connection.sshAgent")) },
							{
								value: "password",
								title: String(t("connection.password")),
							},
							{
								value: "key",
								title: String(t("connection.privateKey")),
							},
						]}
						value={draft.authMethod}
						onChange={(event) =>
							patchDraft({
								authMethod: event.value as SshDraft["authMethod"],
							})
						}
					/>,
				)}
				{draft.authMethod === "agent" && (agentKeys()?.length ?? 0) > 0
					? field(
							t("connection.sshAgentKey"),
							<Select
								testID="settings-ssh-agent-key"
								items={[
									{
										value: "default",
										title: String(t("connection.sshAgentAuto")),
									},
									...(agentKeys() ?? []).map((key) => ({
										value: key.publicKey,
										title: `${key.comment || key.fingerprint}`,
									})),
								]}
								value={draft.agentPublicKey ?? "default"}
								onChange={(event) =>
									patchDraft({
										agentPublicKey:
											event.value === "default" ? null : event.value,
									})
								}
							/>,
						)
					: null}
				{draft.authMethod === "key"
					? field(
							t("connection.privateKeyPath"),
							<Input
								testID="settings-ssh-identity"
								value={draft.identityFile}
								placeholder="~/.ssh/id_ed25519"
								onChange={(event) => patchDraft({ identityFile: event.value })}
							/>,
						)
					: null}
				{isPassword
					? field(
							t("connection.sshPassword"),
							<Input
								testID="settings-ssh-password"
								value={draft.password}
								placeholder={
									draft.hasPassword
										? "••••••••"
										: String(t("connection.password"))
								}
								onChange={(event) => patchDraft({ password: event.value })}
							/>,
						)
					: null}
				{draft.mode === "direct"
					? field(
							t("connection.proxyJump"),
							<Input
								testID="settings-ssh-proxy"
								value={draft.proxyJump}
								onChange={(event) => patchDraft({ proxyJump: event.value })}
							/>,
						)
					: null}
				{field(
					t("connection.piPathLabel"),
					<Input
						testID="settings-ssh-pi"
						value={draft.piExecutable}
						placeholder={String(t("connection.autoDetectPlaceholder"))}
						onChange={(event) => patchDraft({ piExecutable: event.value })}
					/>,
				)}
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
							patchDraft({ piRuntime: event.value as PiRuntime })
						}
					/>,
				)}
				{draft.piRuntime === "local" ? (
					<View class="flex-row items-center justify-between">
						<Text class="text-xs font-medium text-muted-foreground">
							{t("connection.localPiResources")}
						</Text>
						<Switch
							testID="settings-ssh-local-resources"
							checked={draft.localPiResources}
							onChange={({ checked }) =>
								patchDraft({ localPiResources: checked })
							}
						/>
					</View>
				) : null}
				{sshError() ? (
					<Text
						testID="settings-ssh-error"
						class="text-xs text-muted-foreground"
					>
						{sshError()}
					</Text>
				) : null}
				<DialogFooter>
					<Button
						testID="settings-ssh-test"
						variant="outline"
						disabled={sshBusy() || !draft.hostname.trim()}
						onPress={() => void testSshDraft()}
					>
						<Text>{t("connection.testConnection")}</Text>
					</Button>
					<Button
						testID="settings-ssh-save"
						disabled={sshBusy() || !sshValid()}
						onPress={() => void saveSsh()}
					>
						<Text>{t("common.save")}</Text>
					</Button>
				</DialogFooter>
			</Dialog>
		);
	};

	const configureDialog = () => {
		const draft = configure();
		if (!draft) return null;
		return (
			<Dialog
				testID="settings-conn-configure"
				open={true}
				accessibilityLabel={t("connection.configureTitle")}
				onOpenChange={({ open }) => {
					if (!open) configure.set(null);
				}}
			>
				<DialogHeader>
					<DialogTitle>{t("connection.configureTitle")}</DialogTitle>
					<DialogDescription>
						{t("connection.connectionSettingsDescription")}
					</DialogDescription>
				</DialogHeader>
				{field(
					t("connection.nameLabel"),
					<Input
						testID="settings-conn-name"
						value={draft.name}
						onChange={(event) => configure.set({ ...draft, name: event.value })}
					/>,
				)}
				{field(
					t("connection.piPathLabel"),
					<View class="flex-row gap-2">
						<Input
							testID="settings-conn-pi"
							class="flex-1"
							value={draft.piExecutable}
							placeholder={String(t("connection.autoDetectPlaceholder"))}
							onChange={(event) =>
								configure.set({ ...draft, piExecutable: event.value })
							}
						/>
						<Button
							testID="settings-conn-probe"
							variant="outline"
							disabled={testing().has(`${draft.id}:pi`)}
							onPress={() => void probePi(draft.id, draft.piExecutable)}
						>
							{() =>
								testing().has(`${draft.id}:pi`) ? (
									<Spinner size={12} />
								) : (
									<Text>{t("connection.detectPi")}</Text>
								)
							}
						</Button>
					</View>,
				)}
				<DialogFooter>
					<Button
						testID="settings-conn-save"
						disabled={!draft.name.trim() || testing().has(draft.id)}
						onPress={() => void saveConfigure()}
					>
						<Text>{t("common.save")}</Text>
					</Button>
				</DialogFooter>
			</Dialog>
		);
	};

	const removeDialog = () => {
		const connection = removing();
		if (!connection) return null;
		return (
			<Dialog
				testID="settings-conn-remove-dialog"
				open={true}
				accessibilityLabel={t("connection.removeQuestion")}
				onOpenChange={({ open }) => {
					if (!open) removing.set(null);
				}}
			>
				<DialogHeader>
					<DialogTitle>{t("connection.removeQuestion")}</DialogTitle>
					<DialogDescription>
						{() =>
							String(
								t("connection.removeDescription", {
									name: connection.name,
								}),
							)
						}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button
						testID="settings-conn-remove-confirm"
						variant="destructive"
						onPress={() => void removeConnection()}
					>
						<Text>{t("connection.confirmRemove")}</Text>
					</Button>
				</DialogFooter>
			</Dialog>
		);
	};

	return (
		<View class="gap-3">
			<SettingsSection title={t("connection.localMachine")}>
				{() => (loading() ? null : localRow())}
			</SettingsSection>
			<SettingsSection
				title={t("connection.wslLabel")}
				actions={
					<Select
						testID="settings-wsl-add"
						items={[
							{
								value: "add",
								title: String(t("connection.addWsl")),
							},
							...missingDistros().map((distro) => ({
								value: distro.name,
								title: distro.name,
							})),
						]}
						value="add"
						onChange={(event) => {
							if (event.value && event.value !== "add")
								void addWsl(event.value);
						}}
					/>
				}
			>
				{() =>
					wslItems().length === 0 ? (
						<View class="px-3 py-4">
							<Text class="text-sm text-muted-foreground">
								{t("connection.noWsl")}
							</Text>
						</View>
					) : (
						wslItems().map(wslRow)
					)
				}
			</SettingsSection>
			<SettingsSection
				title={t("connection.sshLabel")}
				actions={
					<Button
						testID="settings-ssh-add"
						variant="outline"
						onPress={() => {
							sshEditor.set(emptyDraft());
							sshError.set(null);
							ensureAgentKeys();
						}}
					>
						<Icon name="Plus" size={13} />
						<Text>{t("connection.addSsh")}</Text>
					</Button>
				}
			>
				{() =>
					sshItems().length === 0 ? (
						<View class="px-3 py-4">
							<Text class="text-sm text-muted-foreground">
								{t("settings.noConnections")}
							</Text>
						</View>
					) : (
						sshItems().map(sshRow)
					)
				}
			</SettingsSection>
			{() => sshEditorDialog()}
			{() => configureDialog()}
			{() => removeDialog()}
		</View>
	);
}

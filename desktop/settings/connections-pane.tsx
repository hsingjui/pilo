import {
	type Accessor,
	type JSX,
	effect,
	platform,
	Scroll,
	signal,
	Text,
	token,
	View,
} from "nsh";

import type {
	SshAgentIdentity,
	SshConnectionInfo,
	WslConnectionInfo,
} from "@/lib/api/connections-types";
import type {
	Connection,
	PiRuntime,
	SshAuthMethod,
	SshTarget,
	WslDistribution,
} from "@/lib/api/pi-runtime-types";
import { userErrorMessage } from "@/lib/app-error";
import type { AppState } from "../state/app-state";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { SettingsSection } from "./layout";
import { SettingsConfirmDialog } from "./settings-confirm-dialog";

/** The native calls the pane makes; tests pass a scripted stand-in. */
export type ConnectionsClient = Pick<
	NshPiloClient,
	| "getLocalConnection"
	| "updateConnectionSettings"
	| "setConnectionShownInHome"
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

const IS_WINDOWS = platform.os === "windows";

const AUTH_LABEL_KEYS: Record<
	SshAuthMethod,
	"connection.sshAgent" | "connection.password" | "connection.privateKey"
> = {
	agent: "connection.sshAgent",
	password: "connection.password",
	key: "connection.privateKey",
};

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
	authMethod: SshAuthMethod;
	agentPublicKey: string | null;
	identityFile: string;
	password: string;
	proxyJump: string;
	hasPassword: boolean;
	piExecutable: string;
	piRuntime: PiRuntime;
	localPiResources: boolean;
	initialLocalPiResources: boolean;
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
		initialLocalPiResources: false,
	};
}

function draftFromInfo(info: SshConnectionInfo): SshDraft {
	const target =
		info.connection.kind.type === "ssh" ? info.connection.kind.target : null;
	if (!target) return emptyDraft();
	const auth = target.authMethod;
	const authMethod: SshAuthMethod = typeof auth === "string" ? auth : "agent";
	const agentPublicKey = typeof auth === "string" ? "" : auth.agent_key;
	const localPiResources = info.localPiResources ?? false;
	const base: SshDraft = {
		...emptyDraft(),
		id: info.connection.id,
		name: info.connection.name,
		authMethod,
		agentPublicKey,
		hasPassword: info.hasPassword,
		piExecutable: info.connection.piExecutable ?? "",
		piRuntime: info.connection.piRuntime ?? "workspace",
		localPiResources,
		initialLocalPiResources: localPiResources,
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

/** The "name + Pi path" editor shared by local, WSL and SSH connections. */
type ConfigureDraft = {
	connection: Connection;
	name: string;
	piExecutable: string;
};

type SshFieldError = {
	field: "identityFile" | "password";
	message: string;
};

export function ConnectionsPane(props: {
	state: Accessor<AppState>;
	client: ConnectionsClient;
}) {
	const client = props.client;
	const local = signal<Connection | null>(null);
	const wslItems = signal<WslConnectionInfo[]>([]);
	const sshItems = signal<SshConnectionInfo[]>([]);
	/** `undefined` while loading, `null` when the agent could not be read. */
	const agentIdentities = signal<SshAgentIdentity[] | null | undefined>(
		undefined,
	);
	const distros = signal<WslDistribution[] | null>(null);
	const loading = signal(true);
	const testing = signal<Set<string>>(new Set());
	/** Per-connection diagnostics line, in place of React's toasts. */
	const results = signal<Record<string, string>>({});
	/* Drafts are plain objects, not signals: a signal holding the draft
	 * would re-render the whole dialog on every keystroke and drop input
	 * focus. Fine-grained `{() =>}` watchers around the controls that
	 * depend on the draft keep them live while text fields stay mounted. */
	let configureDraft: ConfigureDraft | null = null;
	const configureOpen = signal(false);
	/** Re-read the draft for the footer state. */
	const configureFormRev = signal(0);
	/** Re-read the draft for the probed Pi path. */
	const configurePiRev = signal(0);
	const probing = signal(false);
	const configureError = signal<string | null>(null);
	let sshDraft: SshDraft | null = null;
	const sshEditorOpen = signal(false);
	/** Bumps when a field changes which sections the form shows. */
	const sshStructRev = signal(0);
	/** Bumps on every draft edit; watchers re-read the draft then. */
	const sshFormRev = signal(0);
	const sshBusy = signal(false);
	const sshTesting = signal(false);
	const sshStatus = signal<string | null>(null);
	const sshFieldError = signal<SshFieldError | null>(null);
	const passwordRevealed = signal(false);
	const wslPickerOpen = signal(false);
	const removing = signal<Connection | null>(null);
	const busy = signal(false);

	const setTesting = (id: string, value: boolean) => {
		const next = new Set(testing());
		if (value) next.add(id);
		else next.delete(id);
		testing.set(next);
	};

	const setResult = (id: string, text: string) =>
		results.set({ ...results(), [id]: text });

	const connectionLabel = (connection: Connection): string =>
		connection.kind.type === "local" ? t("common.local") : connection.name;

	const projectCount = (id: string, fallback: number) => {
		const count = props
			.state()
			.projects.filter((project) => project.connection.id === id).length;
		return count > 0 ? count : fallback;
	};

	const refresh = async () => {
		const [localResult, sshResult, wslResult] = await Promise.allSettled([
			client.getLocalConnection(),
			client.listSshConnections(),
			client.listWslConnections(),
		]);
		if (localResult.status === "fulfilled") local.set(localResult.value);
		if (sshResult.status === "fulfilled") sshItems.set(sshResult.value);
		else setResult("ssh-list", t("connection.sshLoadFailed"));
		if (wslResult.status === "fulfilled") wslItems.set(wslResult.value);
		loading.set(false);
	};

	/* The project list reloads on host configuration changes; reload the
	 * connection catalog with it, like React's configurationRevision effect. */
	effect(() => {
		void props.state().projects;
		void refresh();
	});

	const testConnection = async (connection: Connection) => {
		const id = connection.id;
		setTesting(id, true);
		try {
			const result =
				connection.kind.type === "local"
					? await client.testLocalConnection()
					: connection.kind.type === "wsl"
						? await client.testWslConnection(connection.kind.distro)
						: await client.testSshConnection(id);
			setResult(
				id,
				`${t("connection.available", {
					name: connectionLabel(connection),
				})} · pilo-server ${result.serverVersion} · protocol ${
					result.protocolVersion
				}`,
			);
		} catch (caught) {
			setResult(
				id,
				`${t("connection.connectionFailed", {
					name: connectionLabel(connection),
				})} · ${userErrorMessage(caught)}`,
			);
		} finally {
			setTesting(id, false);
		}
	};

	const toggleShown = async (connection: Connection, shown: boolean) => {
		try {
			await client.setConnectionShownInHome(connection.id, shown);
			await refresh();
		} catch (caught) {
			setResult(
				connection.id,
				`${t("connection.saveFailed")} · ${userErrorMessage(caught)}`,
			);
		}
	};

	const openConnectionSettings = (connection: Connection) => {
		configureError.set(null);
		configureDraft = {
			connection,
			name: connection.name,
			piExecutable: connection.piExecutable ?? "",
		};
		configureOpen.set(true);
	};

	const closeConnectionSettings = () => {
		configureDraft = null;
		configureOpen.set(false);
	};

	const saveConnectionSettings = async () => {
		const draft = configureDraft;
		if (!draft?.name.trim()) return;
		busy.set(true);
		configureError.set(null);
		try {
			await client.updateConnectionSettings(
				draft.connection.id,
				draft.name.trim(),
				draft.piExecutable.trim() || null,
			);
			closeConnectionSettings();
			await refresh();
			setResult(draft.connection.id, t("connection.connectionSaved"));
		} catch (caught) {
			configureError.set(
				`${t("connection.saveFailed")} · ${userErrorMessage(caught)}`,
			);
		} finally {
			busy.set(false);
		}
	};

	const probePi = async () => {
		const draft = configureDraft;
		if (!draft) return;
		probing.set(true);
		configureError.set(null);
		try {
			const info = await client.probeConnectionPi(
				draft.connection.id,
				draft.piExecutable.trim() || null,
			);
			if (configureDraft?.connection.id === draft.connection.id) {
				configureDraft.piExecutable = info.executable;
				configurePiRev.update((n) => n + 1);
			}
			setResult(
				draft.connection.id,
				`${t("connection.piAvailable", {
					name: connectionLabel(draft.connection),
				})} · ${[info.executable, info.version].filter(Boolean).join(" · ")}`,
			);
		} catch (caught) {
			configureError.set(
				`${t("connection.piUnavailable", {
					name: connectionLabel(draft.connection),
				})} · ${userErrorMessage(caught)}`,
			);
		} finally {
			probing.set(false);
		}
	};

	const addWsl = async (distro: string) => {
		busy.set(true);
		try {
			await client.saveWslConnection({
				id: `wsl:${distro}`,
				name: `WSL · ${distro}`,
				kind: { type: "wsl", distro },
			});
			await refresh();
			setResult(`wsl:${distro}`, t("connection.wslAdded", { name: distro }));
		} catch (caught) {
			setResult(
				"wsl-add",
				`${t("connection.wslAddFailed")} · ${userErrorMessage(caught)}`,
			);
		} finally {
			busy.set(false);
		}
	};

	const removeConnection = async () => {
		const connection = removing();
		if (!connection || busy() || connection.kind.type === "local") return;
		busy.set(true);
		try {
			if (connection.kind.type === "wsl") {
				await client.removeWslConnection(connection.id);
			} else {
				await client.removeSshConnection(connection.id);
			}
			await refresh();
			removing.set(null);
			/* The row is gone by now; the pane-level line carries the result. */
			setResult(
				"list",
				t("connection.removed", { name: connectionLabel(connection) }),
			);
		} catch (caught) {
			setResult(
				connection.id,
				`${t("connection.removeFailed")} · ${userErrorMessage(caught)}`,
			);
		} finally {
			busy.set(false);
		}
	};

	const loadAgentIdentities = () => {
		agentIdentities.set(undefined);
		client
			.listSshAgentIdentities()
			.then((identities) => agentIdentities.set(identities))
			.catch(() => agentIdentities.set(null));
	};

	const openSshEditor = async (info: SshConnectionInfo) => {
		sshFieldError.set(null);
		sshStatus.set(null);
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
		sshEditorOpen.set(true);
		if (form.authMethod === "agent") loadAgentIdentities();
	};

	const openNewSsh = () => {
		sshFieldError.set(null);
		sshStatus.set(null);
		passwordRevealed.set(false);
		sshDraft = emptyDraft();
		sshEditorOpen.set(true);
		loadAgentIdentities();
	};

	const closeSshEditor = () => {
		sshDraft = null;
		sshEditorOpen.set(false);
		sshFieldError.set(null);
		passwordRevealed.set(false);
	};

	const patchDraft = (patch: Partial<SshDraft>) => {
		const draft = sshDraft;
		if (!draft) return;
		Object.assign(draft, patch);
		if ("authMethod" in patch || "mode" in patch || "piRuntime" in patch)
			sshStructRev.update((n) => n + 1);
		sshFormRev.update((n) => n + 1);
		if (sshFieldError()) sshFieldError.set(null);
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

	const saveSsh = async () => {
		const base = sshDraft;
		if (!base || !base.name.trim() || !base.hostname.trim()) return;
		if (
			base.mode === "direct" &&
			base.authMethod === "key" &&
			!base.identityFile.trim()
		) {
			sshFieldError.set({
				field: "identityFile",
				message: t("connection.privateKeyRequired"),
			});
			return;
		}
		if (base.authMethod === "password" && !base.password && !base.hasPassword) {
			sshFieldError.set({
				field: "password",
				message: t("connection.passwordRequired"),
			});
			return;
		}
		const draft = { ...base, agentPublicKey: agentPublicKey() };
		sshBusy.set(true);
		sshStatus.set(null);
		try {
			await client.saveSshConnection(
				connectionFromDraft(draft),
				draft.password || undefined,
				draft.localPiResources === draft.initialLocalPiResources
					? undefined
					: draft.localPiResources,
			);
			closeSshEditor();
			await refresh();
			setResult(draft.id, t("connection.sshSaved"));
		} catch (caught) {
			sshStatus.set(
				`${t("connection.sshSaveFailed")} · ${
					String(caught).includes("SSH_LOCAL_PI_RESOURCES_BUSY")
						? t("connection.localPiResourcesBusy")
						: userErrorMessage(caught)
				}`,
			);
		} finally {
			sshBusy.set(false);
		}
	};

	const testSshDraft = async () => {
		const base = sshDraft;
		if (!base) return;
		const draft = { ...base, agentPublicKey: agentPublicKey() };
		const label = draft.name.trim() || draft.hostname.trim();
		sshTesting.set(true);
		sshStatus.set(null);
		try {
			const result = await client.testSshConnectionDraft(
				connectionFromDraft(draft),
				draft.password || undefined,
			);
			sshStatus.set(
				`${t("connection.available", { name: label })} · pilo-server ${
					result.serverVersion
				} · protocol ${result.protocolVersion}`,
			);
		} catch (caught) {
			sshStatus.set(
				`${t("connection.connectionFailed", { name: label })} · ${userErrorMessage(caught)}`,
			);
		} finally {
			sshTesting.set(false);
		}
	};

	const openWslPicker = () => {
		wslPickerOpen.set(true);
		if (IS_WINDOWS && distros() === null) {
			client
				.listWslDistributions()
				.then((items) => distros.set(items))
				.catch((caught) => {
					distros.set([]);
					setResult(
						"wsl-add",
						`${t("connection.loadWslFailed")} · ${userErrorMessage(caught)}`,
					);
				});
		}
	};

	const addedDistros = () =>
		new Set(
			wslItems().flatMap((info) =>
				info.connection.kind.type === "wsl"
					? [info.connection.kind.distro]
					: [],
			),
		);

	const connectionIcon = (connection: Connection): JSX.Element => (
		<Icon
			name={
				connection.kind.type === "local"
					? "Laptop"
					: connection.kind.type === "wsl"
						? "Monitor"
						: "Server"
			}
			size={14}
		/>
	);

	const hint = (label: string) => (
		<Tooltip>
			<Text class="font-sans">{label}</Text>
		</Tooltip>
	);

	const rowButton = (button: {
		testID: string;
		label: string;
		icon: JSX.Element;
		disabled: boolean;
		destructive?: boolean;
		selected?: boolean;
		onPress: () => void;
	}) => (
		<Button
			testID={button.testID}
			variant="ghost"
			size="icon"
			class={`h-8 w-8 text-muted-foreground hover:text-foreground${
				button.destructive
					? " hover:bg-destructive/10 hover:text-destructive"
					: ""
			}`}
			disabled={button.disabled}
			selected={button.selected}
			accessibilityLabel={button.label}
			tooltip={hint(button.label)}
			onPress={button.onPress}
		>
			{button.icon}
		</Button>
	);

	const rowBusy = (connection: Connection) =>
		busy() || probing() || testing().has(connection.id);

	const connectionRow = (
		connection: Connection,
		description: JSX.Element,
		projectCountValue: number,
		shownInHome: boolean,
		options: { edit?: () => void; remove?: () => void } = {},
	) => (
		<View class="px-3 py-2.5 hover:bg-hover/30">
			<View class="flex-row items-center gap-2.5">
				<View class="size-6 shrink-0 items-center justify-center text-foreground/70">
					{connectionIcon(connection)}
				</View>
				<View class="min-w-0 flex-1">
					<Text class="font-sans truncate text-sm font-medium">
						{connectionLabel(connection)}
					</Text>
					<View class="mt-0.5 flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
						{description}
						<Text class="font-sans text-[11px] text-muted-foreground">
							{() =>
								projectCountValue > 0
									? t("connection.projectCount", {
											count: projectCountValue,
										})
									: t("connection.unlinkedProjects")
							}
						</Text>
					</View>
				</View>
				<View class="shrink-0 flex-row items-center gap-1">
					{rowButton({
						testID: `settings-conn-home-${connection.id}`,
						label: t("connection.shownInHome"),
						icon: <Icon name={shownInHome ? "Eye" : "EyeOff"} size={16} />,
						disabled: rowBusy(connection),
						selected: shownInHome,
						onPress: () => void toggleShown(connection, !shownInHome),
					})}
					{rowButton({
						testID: `settings-conn-test-${connection.id}`,
						label: t("connection.test"),
						icon: testing().has(connection.id) ? (
							<Spinner size={16} />
						) : (
							<Icon name="Wifi" size={16} />
						),
						disabled: rowBusy(connection),
						onPress: () => void testConnection(connection),
					})}
					{rowButton({
						testID: `settings-conn-configure-${connection.id}`,
						label: t("connection.configure"),
						icon: <Icon name="Settings2" size={16} />,
						disabled: rowBusy(connection),
						onPress: () => openConnectionSettings(connection),
					})}
					{options.edit
						? rowButton({
								testID: `settings-conn-edit-${connection.id}`,
								label: t("connection.editSsh"),
								icon: <Icon name="Pencil" size={16} />,
								disabled: rowBusy(connection),
								onPress: options.edit,
							})
						: null}
					{options.remove
						? rowButton({
								testID: `settings-conn-remove-${connection.id}`,
								label: t("connection.remove"),
								icon: <Icon name="Trash2" size={16} />,
								disabled: rowBusy(connection),
								destructive: true,
								onPress: options.remove,
							})
						: null}
				</View>
			</View>
			{() =>
				results()[connection.id] ? (
					<Text
						testID={`settings-conn-result-${connection.id}`}
						class="font-sans mt-1.5 text-[11px] text-muted-foreground"
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
		return connectionRow(
			connection,
			<Text class="font-sans text-[11px] text-muted-foreground">
				{t("connection.localMachine")}
			</Text>,
			projectCount(connection.id, 0),
			connection.shownInHome ?? true,
		);
	};

	const wslRow = (info: WslConnectionInfo) => {
		const connection = info.connection;
		return connectionRow(
			connection,
			<Text class="font-sans text-[11px] text-muted-foreground">
				{t("connection.wslLabel")}
			</Text>,
			projectCount(connection.id, info.projectCount),
			connection.shownInHome ?? false,
			{ remove: () => removing.set(connection) },
		);
	};

	const sshRow = (info: SshConnectionInfo) => {
		const connection = info.connection;
		const description =
			connection.kind.type === "ssh" ? (
				<>
					<Text class="truncate font-mono text-[11px] text-muted-foreground">
						{sshTargetLabel(connection.kind.target)}
					</Text>
					<Text class="font-sans text-[11px] text-muted-foreground">
						{t(
							AUTH_LABEL_KEYS[
								typeof connection.kind.target.authMethod === "string"
									? connection.kind.target.authMethod
									: "agent"
							],
						)}
					</Text>
					{connection.kind.target.type === "direct" &&
					connection.kind.target.proxyJump ? (
						<Text class="font-sans text-[11px] text-muted-foreground">
							{t("connection.via", {
								name: connection.kind.target.proxyJump,
							})}
						</Text>
					) : null}
				</>
			) : null;
		return connectionRow(
			connection,
			description,
			projectCount(connection.id, info.projectCount),
			connection.shownInHome ?? false,
			{
				edit: () => void openSshEditor(info),
				remove: () => removing.set(connection),
			},
		);
	};

	const field = (label: string, child: JSX.Element) => (
		<View class="gap-1">
			<Text class="font-sans text-xs">{label}</Text>
			{child}
		</View>
	);

	const fieldError = (fieldName: SshFieldError["field"]) => () =>
		sshFieldError()?.field === fieldName ? (
			<Text
				testID={`settings-ssh-error-${fieldName}`}
				class="font-sans text-[11px] text-destructive"
			>
				{sshFieldError()?.message}
			</Text>
		) : null;

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

	const sshEditorDialog = () => {
		const draft = sshDraft;
		if (!draft) return null;
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
					if (!open) closeSshEditor();
				}}
			>
				<DialogHeader>
					<DialogTitle>
						{() => {
							void sshFormRev();
							return draft.name
								? t("settings.editSshConnection")
								: t("settings.addSshConnection");
						}}
					</DialogTitle>
				</DialogHeader>
				<View class="flex-row gap-3">
					<View class="flex-1 gap-1">
						<Text class="font-sans text-xs">
							{t("settings.connectionName")}
						</Text>
						<Input
							testID="settings-ssh-name"
							value={draft.name}
							placeholder={String(t("settings.productionServer"))}
							onChange={(event) => patchDraft({ name: event.value })}
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
								patchDraft({
									mode: event.value as SshDraft["mode"],
								})
							}
						/>
					</View>
				</View>
				{() => {
					void sshStructRev();
					return field(
						draft.mode === "config"
							? t("connection.hostAlias")
							: t("connection.host"),
						<Input
							testID="settings-ssh-host"
							value={draft.hostname}
							placeholder={draft.mode === "config" ? "devbox" : "example.com"}
							onChange={(event) => patchDraft({ hostname: event.value })}
						/>,
					);
				}}
				{() => {
					void sshStructRev();
					return draft.mode === "direct" ? (
						<View class="flex-row gap-3">
							<View class="flex-1 gap-1">
								<Text class="font-sans text-xs">
									{t("connection.username")}
								</Text>
								<Input
									testID="settings-ssh-user"
									value={draft.user}
									placeholder="root"
									onChange={(event) => patchDraft({ user: event.value })}
								/>
							</View>
							<View class="w-24 gap-1">
								<Text class="font-sans text-xs">{t("connection.port")}</Text>
								<Input
									testID="settings-ssh-port"
									value={draft.port}
									onChange={(event) => patchDraft({ port: event.value })}
								/>
							</View>
						</View>
					) : null;
				}}
				{() => {
					void sshStructRev();
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
								patchDraft({
									authMethod: event.value as SshAuthMethod,
								})
							}
						/>,
					);
				}}
				{() => {
					void sshStructRev();
					void sshFormRev();
					if (draft.authMethod !== "agent") return null;
					const identities = agentIdentities();
					const key = agentPublicKey();
					const savedKeyMissing =
						Boolean(key) &&
						identities != null &&
						!identities.some((identity) => identity.publicKey === key);
					return (
						<View class="min-w-0 gap-1">
							<Text class="font-sans text-xs">
								{t("connection.sshAgentKey")}
							</Text>
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
											patchDraft({
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
									disabled={waitingForAgent() || sshBusy() || sshTesting()}
									onPress={() => loadAgentIdentities()}
								>
									<Text class="font-sans">{t("common.refresh")}</Text>
								</Button>
							</View>
							<Text
								testID="settings-ssh-agent-status"
								class="font-sans text-xs text-muted-foreground"
							>
								{agentStatus()}
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
							patchDraft({ piRuntime: event.value as PiRuntime })
						}
					/>,
				)}
				{() => {
					void sshStructRev();
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
								disabled={sshBusy()}
								onChange={({ checked }) =>
									patchDraft({ localPiResources: checked })
								}
							/>
						</View>
					) : null;
				}}
				{() => {
					void sshStructRev();
					const revealed = passwordRevealed();
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
									onChange={(event) => patchDraft({ password: event.value })}
								/>
								{() => {
									void sshFormRev();
									const shown = passwordRevealed();
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
											onPress={() => passwordRevealed.set(!passwordRevealed())}
										>
											<Icon name={shown ? "EyeOff" : "Eye"} size={16} />
										</Button>
									);
								}}
							</View>
							{fieldError("password")}
						</View>
					) : null;
				}}
				{() => {
					void sshStructRev();
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
								onChange={(event) => patchDraft({ identityFile: event.value })}
							/>
							{fieldError("identityFile")}
						</View>
					) : null;
				}}
				{() => {
					void sshStructRev();
					return draft.mode === "direct"
						? field(
								t("connection.proxyJump"),
								<Input
									testID="settings-ssh-proxy"
									value={draft.proxyJump}
									placeholder="user@jump.example.com:22"
									onChange={(event) => patchDraft({ proxyJump: event.value })}
								/>,
							)
						: null;
				}}
				{() =>
					sshStatus() ? (
						<Text
							testID="settings-ssh-error"
							class="font-sans text-xs text-muted-foreground"
						>
							{sshStatus()}
						</Text>
					) : null
				}
				{() => {
					void sshFormRev();
					const busyNow = sshBusy();
					const testingNow = sshTesting();
					const waiting = waitingForAgent();
					return (
						<View class="mt-1 flex-row flex-wrap items-center justify-between gap-2">
							<Button
								testID="settings-ssh-test"
								variant="outline"
								size="sm"
								disabled={busyNow || testingNow || waiting}
								onPress={() => void testSshDraft()}
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
									onPress={() => closeSshEditor()}
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
									onPress={() => void saveSsh()}
								>
									<Text class="font-sans">
										{busyNow ? t("common.saving") : t("common.save")}
									</Text>
								</Button>
							</View>
						</View>
					);
				}}
			</Dialog>
		);
	};

	const configureDialog = () => {
		const draft = configureDraft;
		if (!draft) return null;
		const usesLocalPi =
			draft.connection.kind.type === "ssh" &&
			draft.connection.piRuntime === "local";
		return (
			<Dialog
				testID="settings-conn-configure"
				open={true}
				accessibilityLabel={t("connection.configureTitle")}
				class="max-w-md"
				onOpenChange={({ open }) => {
					if (!open) closeConnectionSettings();
				}}
			>
				<DialogHeader>
					<DialogTitle>{t("connection.configureTitle")}</DialogTitle>
				</DialogHeader>
				{field(
					t("connection.name"),
					<Input
						testID="settings-conn-name"
						value={draft.name}
						onChange={(event) => {
							draft.name = event.value;
							configureFormRev.update((n) => n + 1);
						}}
					/>,
				)}
				{() => {
					void configurePiRev();
					const disabled = busy() || probing();
					return usesLocalPi
						? field(
								t("connection.runtimeLocation"),
								<View class="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
									<Text class="font-sans text-[11px] text-muted-foreground">
										{t("connection.localPi")}
									</Text>
								</View>,
							)
						: field(
								t("connection.piPath"),
								<View class="flex-row gap-2">
									<Input
										testID="settings-conn-pi"
										class="flex-1 font-mono"
										value={draft.piExecutable}
										placeholder={String(t("connection.autoDetect"))}
										onChange={(event) => {
											draft.piExecutable = event.value;
											configureFormRev.update((n) => n + 1);
										}}
									/>
									<Button
										testID="settings-conn-probe"
										variant="outline"
										size="sm"
										disabled={disabled}
										onPress={() => void probePi()}
									>
										<Text class="font-sans">
											{probing()
												? t("connection.detecting")
												: t("connection.detectPi")}
										</Text>
									</Button>
								</View>,
							);
				}}
				{() =>
					configureError() ? (
						<Text
							testID="settings-conn-configure-error"
							class="font-sans text-[11px] text-destructive"
						>
							{configureError()}
						</Text>
					) : null
				}
				{() => {
					void configureFormRev();
					return (
						<DialogFooter>
							<Button
								testID="settings-conn-cancel"
								variant="outline"
								size="sm"
								disabled={busy()}
								onPress={() => closeConnectionSettings()}
							>
								<Text class="font-sans">{t("common.cancel")}</Text>
							</Button>
							<Button
								testID="settings-conn-save"
								size="sm"
								disabled={busy() || !draft.name.trim()}
								onPress={() => void saveConnectionSettings()}
							>
								<Text class="font-sans">
									{busy() ? t("common.saving") : t("common.save")}
								</Text>
							</Button>
						</DialogFooter>
					);
				}}
			</Dialog>
		);
	};

	const wslPickerDialog = () => {
		if (!wslPickerOpen()) return null;
		const items = distros();
		return (
			<Dialog
				testID="settings-wsl-picker"
				open={true}
				accessibilityLabel={t("connection.addWslTitle")}
				class="max-w-md"
				onOpenChange={({ open }) => {
					if (!open) wslPickerOpen.set(false);
				}}
			>
				<DialogHeader>
					<DialogTitle>{t("connection.addWslTitle")}</DialogTitle>
				</DialogHeader>
				<Scroll class="max-h-72 rounded-md border border-border/60">
					{items === null ? (
						<Text class="font-sans px-3 py-4 text-xs text-muted-foreground">
							{t("connection.loading")}
						</Text>
					) : items.length === 0 ? (
						<Text class="font-sans px-3 py-4 text-xs text-muted-foreground">
							{t("connection.noWsl")}
						</Text>
					) : (
						items.map((distro) => {
							const added = addedDistros().has(distro.name);
							return (
								<View class="flex-row items-center gap-3 border-border/60 border-b px-3 py-2 last:border-b-0">
									<Icon
										name="Monitor"
										size={16}
										color={token("muted-foreground")}
									/>
									<Text class="font-sans min-w-0 flex-1 truncate text-sm">
										{distro.name}
									</Text>
									<Button
										testID={`settings-wsl-add-${distro.name}`}
										variant="outline"
										size="sm"
										disabled={busy() || added}
										onPress={() => void addWsl(distro.name)}
									>
										<Text class="font-sans">
											{added ? t("common.added") : t("common.add")}
										</Text>
									</Button>
								</View>
							);
						})
					)}
				</Scroll>
			</Dialog>
		);
	};

	const addConnectionMenu = () => (
		<Menu
			align="end"
			popupStyle={{ minWidth: 0 }}
			trigger={
				<Button
					testID="settings-conn-add"
					variant="outline"
					size="icon"
					accessibilityLabel={t("connection.addConnection")}
					tooltip={hint(t("connection.addConnection"))}
				>
					<Icon name="Plus" size={16} />
				</Button>
			}
		>
			<View class="gap-1">
				{IS_WINDOWS ? (
					<MenuItem
						testID="settings-conn-add-wsl"
						indicatorClass="hidden"
						icon={<Icon name="Monitor" size={14} />}
						onSelect={() => openWslPicker()}
					>
						<Text class="font-sans">{t("connection.addWsl")}</Text>
					</MenuItem>
				) : null}
				<MenuItem
					testID="settings-conn-add-ssh"
					indicatorClass="hidden"
					icon={<Icon name="Server" size={14} />}
					onSelect={() => openNewSsh()}
				>
					<Text class="font-sans">{t("connection.addSsh")}</Text>
				</MenuItem>
			</View>
		</Menu>
	);

	const removeDialog = () => {
		const connection = removing();
		return (
			<SettingsConfirmDialog
				testID="settings-conn-remove-dialog"
				open={connection !== null}
				title={
					connection
						? `${t("connection.removeQuestion")} · ${connectionLabel(connection)}`
						: t("connection.removeQuestion")
				}
				description={
					connection
						? `${t("connection.removeDescription", {
								name: connectionLabel(connection),
							})}${
								connection.kind.type === "ssh"
									? t("connection.sshCredentialsDeleted")
									: ""
							}`
						: null
				}
				confirmLabel={t("connection.confirmRemove")}
				busyLabel={t("connection.removing")}
				busy={busy()}
				destructive
				onOpenChange={(open) => {
					if (!open) removing.set(null);
				}}
				onConfirm={() => void removeConnection()}
			/>
		);
	};

	return (
		<View class="gap-3">
			<SettingsSection
				title={t("settings.connections")}
				actions={addConnectionMenu()}
			>
				{() => localRow()}
				{() =>
					loading() ? (
						<Text class="font-sans px-3 py-5 text-xs text-muted-foreground">
							{t("connection.loading")}
						</Text>
					) : (
						<>
							{wslItems().map(wslRow)}
							{sshItems().map(sshRow)}
							{() =>
								results()["ssh-list"] || results()["wsl-add"] ? (
									<Text class="font-sans px-3 py-2 text-[11px] text-destructive">
										{results()["ssh-list"] ?? results()["wsl-add"]}
									</Text>
								) : null
							}
							{() =>
								results()["list"] ? (
									<Text class="font-sans px-3 py-2 text-[11px] text-muted-foreground">
										{results()["list"]}
									</Text>
								) : null
							}
						</>
					)
				}
			</SettingsSection>
			{() => (sshEditorOpen() ? sshEditorDialog() : null)}
			{() => (configureOpen() ? configureDialog() : null)}
			{() => wslPickerDialog()}
			{() => removeDialog()}
		</View>
	);
}

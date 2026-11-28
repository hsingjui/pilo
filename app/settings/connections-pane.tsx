import {
	type Accessor,
	cleanup,
	computed,
	effect,
	platform,
	signal,
	Text,
	View,
} from "nsh";

import type {
	SshConnectionInfo,
	WslConnectionInfo,
} from "@shared/api/connections-types";
import type { Connection } from "@shared/api/pi-runtime-types";
import { userErrorMessage } from "@shared/app-error";
import type { RemoteHostProxy } from "@shared/remote-hosts";
import {
	AddRemoteHostDialog,
	remoteProxyError,
} from "../hosts/add-remote-host-dialog";
import { hostSupportsWsl } from "../hosts/host-perspective";
import type {
	HostEntry,
	HostEntryStatus,
	HostRegistry,
} from "../hosts/host-registry";
import { AppToaster, AppToasts, AppToastStack } from "../shell/app-toasts";
import { connectionLabel } from "../shell/connection-label";
import type { AppState } from "../state/app-state";
import type { HostClient } from "@shared/api/host-client";
import { t } from "../shell/i18n";
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
import { textTooltip } from "../ui/tooltip";
import { showConnectionTestToast } from "./connection-settings";
import {
	SETTINGS_HEADER_ICON_BUTTON_CLASS,
	SettingsIconButton,
	SettingsSection,
	SettingsSectionMessage,
} from "./layout";
import { SettingsConfirmDialog } from "./settings-confirm-dialog";
import { ConnectionRow } from "./connection-row";
import {
	ConfigureConnectionDialog,
	createConfigureDialog,
} from "./configure-connection-dialog";
import {
	createSshEditor,
	SshConnectionEditorDialog,
} from "./ssh-connection-editor";
import { createWslPicker, WslPickerDialog } from "./wsl-picker-dialog";
import { AUTH_LABEL_KEYS, sshTargetLabel } from "./ssh-connection-draft";

/** The native calls the pane makes; tests pass a scripted stand-in. */
export type ConnectionsClient = Pick<
	HostClient,
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
> &
	Partial<
		Pick<
			HostClient,
			"getConnectionHealth" | "listSshConfigHosts" | "listSshLocalKeys"
		>
	>;

export interface ConnectionsPaneProps {
	state: Accessor<AppState>;
	client: ConnectionsClient;
	/** A remote Host's connections: listed without credentials, edited only on that Host. */
	readOnly?: boolean;
	/** Pairing is managed by this desktop, not by the Host whose connections are listed. */
	remoteHostPairing?: {
		registry: HostRegistry;
		machineName: () => string | null;
	};
}

const HOST_STATUS_KEYS = {
	connected: "hosts.connected",
	connecting: "hosts.connecting",
	offline: "hosts.offline",
	disconnected: "hosts.disconnected",
	unauthorized: "hosts.unauthorized",
	incompatible: "hosts.incompatible",
	rateLimited: "hosts.rateLimited",
} as const satisfies Record<HostEntryStatus, string>;

type ManagedConnection = Connection | HostEntry;

export function ConnectionsPane(props: ConnectionsPaneProps) {
	const { remoteHostPairing } = props;
	const registry = remoteHostPairing?.registry;
	const client = registry?.local.client ?? props.client;
	const state = registry?.local.store.state ?? props.state;
	const editable = !!registry || !props.readOnly;
	const label = (connection: Connection) =>
		connectionLabel(connection, registry ? null : undefined);
	const supportsWsl = () =>
		registry ? platform.os === "windows" : hostSupportsWsl();
	const addRemoteOpen = signal(false);
	const inheritedToasts = AppToaster();
	const ownToasts = inheritedToasts ? null : new AppToasts();
	const toasts = inheritedToasts ?? ownToasts!;
	const local = signal<Connection | null>(null);
	const wslItems = signal<WslConnectionInfo[]>([]);
	const sshItems = signal<SshConnectionInfo[]>([]);
	const loading = signal(true);
	const testing = signal<Set<string>>(new Set());
	const localLoadFailed = signal(false);
	const wslLoadFailed = signal(false);
	const sshLoadFailed = signal(false);
	const removing = signal<ManagedConnection | null>(null);
	const editingHost = signal<{
		host: HostEntry;
		proxyMode: RemoteHostProxy["mode"] | "direct";
	} | null>(null);
	const nameDraft = signal("");
	const proxyMode = signal<RemoteHostProxy["mode"] | "direct">("direct");
	const proxyUrl = signal("");
	const editError = signal<string | null>(null);
	const busy = signal(false);
	let alive = true;
	cleanup(() => {
		alive = false;
	});

	const setTesting = (id: string, value: boolean) => {
		const next = new Set(testing());
		if (value) next.add(id);
		else next.delete(id);
		testing.set(next);
	};

	const projects = computed(() => state().projects);
	const projectCount = (id: string, fallback: number) => {
		const count = projects().filter(
			(project) => project.connection.id === id,
		).length;
		return count > 0 ? count : fallback;
	};

	let refreshRevision = 0;
	const refresh = async () => {
		const revision = ++refreshRevision;
		const [localResult, sshResult, wslResult] = await Promise.allSettled([
			client.getLocalConnection(),
			client.listSshConnections(),
			client.listWslConnections(),
		]);
		if (!alive || revision !== refreshRevision) return;
		if (localResult.status === "fulfilled") local.set(localResult.value);
		localLoadFailed.set(localResult.status === "rejected");
		if (sshResult.status === "fulfilled") sshItems.set(sshResult.value);
		sshLoadFailed.set(sshResult.status === "rejected");
		if (wslResult.status === "fulfilled") wslItems.set(wslResult.value);
		wslLoadFailed.set(wslResult.status === "rejected");
		loading.set(false);
	};

	/* The project list reloads on host configuration changes; reload the
	 * connection catalog with it, like React's configurationRevision effect. */
	effect(() => {
		void projects();
		void refresh();
	});

	const sshEditor = createSshEditor({ client, refresh, toasts });
	const configureDialog = createConfigureDialog({
		client,
		refresh,
		toasts,
		label,
	});
	const addedDistros = () =>
		new Set(
			wslItems().flatMap((info) =>
				info.connection.kind.type === "wsl"
					? [info.connection.kind.distro]
					: [],
			),
		);
	const wslPicker = createWslPicker({
		client,
		refresh,
		toasts,
		addedDistros,
		supportsWsl,
	});

	const testConnection = async (connection: Connection) => {
		const id = connection.id;
		const name = label(connection);
		setTesting(id, true);
		try {
			if (client.getConnectionHealth) {
				const health = await client.getConnectionHealth(id);
				if (health.reachable) {
					const description = health.pi
						? t("connection.healthSummary", {
								ms: Math.round(health.latencyMs),
								version: health.pi.version || health.pi.executable,
							})
						: t("connection.healthPiMissing", {
								ms: Math.round(health.latencyMs),
							});
					toasts.show({
						variant: health.pi ? "success" : "warning",
						title: t("connection.available", { name }),
						description,
					});
					return;
				}
				showConnectionTestToast(toasts, name, {
					ok: false,
					error: health.error || t("errors.connectionUnavailable"),
				});
				return;
			}
			const result =
				connection.kind.type === "local"
					? await client.testLocalConnection()
					: connection.kind.type === "wsl"
						? await client.testWslConnection(connection.kind.distro)
						: await client.testSshConnection(id);
			showConnectionTestToast(toasts, name, { ok: true, result });
		} catch (caught) {
			showConnectionTestToast(toasts, name, { ok: false, error: caught });
		} finally {
			if (alive) setTesting(id, false);
		}
	};

	const testRemote = async (host: HostEntry) => {
		if (!registry) return;
		setTesting(host.hostId, true);
		try {
			const status = await registry.test(host.hostId);
			if (status === "connected") {
				toasts.show({
					variant: "success",
					title: t("connection.available", { name: host.name }),
				});
			} else {
				showConnectionTestToast(toasts, host.name, {
					ok: false,
					error: t(HOST_STATUS_KEYS[status]),
				});
			}
		} catch (error) {
			showConnectionTestToast(toasts, host.name, { ok: false, error });
		} finally {
			if (alive) setTesting(host.hostId, false);
		}
	};

	const toggleShown = async (connection: ManagedConnection, shown: boolean) => {
		const remote = "hostId" in connection;
		if (remote) {
			if (busy()) return;
			busy.set(true);
		}
		try {
			if (remote) {
				await registry?.setShownInHome(connection.hostId, shown);
			} else {
				await client.setConnectionShownInHome(connection.id, shown);
				await refresh();
			}
		} catch (caught) {
			toasts.show({
				variant: "error",
				title: t("connection.saveFailed"),
				description: userErrorMessage(caught),
			});
		} finally {
			if (remote && alive) busy.set(false);
		}
	};

	const removeConnection = async (dialogToasts: AppToasts) => {
		const connection = removing();
		if (!connection || busy()) return;
		if (!("hostId" in connection) && connection.kind.type === "local") return;
		busy.set(true);
		try {
			if ("hostId" in connection) {
				if (!registry) return;
				const wasActive = registry.activeHostId() === connection.hostId;
				const revoked = await registry.remove(connection.hostId);
				removing.set(null);
				(wasActive ? registry.activeSession().toasts : toasts).show({
					variant: revoked ? "success" : "info",
					title: t(revoked ? "hosts.removed" : "hosts.removedOffline", {
						name: connection.name,
					}),
				});
				return;
			}
			if (connection.kind.type === "wsl") {
				await client.removeWslConnection(connection.id);
			} else {
				await client.removeSshConnection(connection.id);
			}
			await refresh();
			removing.set(null);
			toasts.show({
				variant: "success",
				title: t("connection.removed", { name: label(connection) }),
			});
		} catch (caught) {
			const errorToasts = alive
				? dialogToasts
				: (registry?.activeSession().toasts ?? toasts);
			errorToasts.show({
				variant: "error",
				title: t("connection.removeFailed"),
				description: userErrorMessage(caught),
			});
		} finally {
			busy.set(false);
		}
	};

	const localRow = () => {
		const connection = local();
		if (!connection) return null;
		return (
			<ConnectionRow
				id={connection.id}
				kind={connection.kind.type}
				label={label(connection)}
				description={
					<Text class="font-sans text-[11px] text-muted-foreground">
						{t("connection.localMachine")}
					</Text>
				}
				projectCount={projectCount(connection.id, 0)}
				shownInHome={connection.shownInHome ?? true}
				testing={() => testing().has(connection.id)}
				busy={() => busy() || configureDialog.probing()}
				onToggleShown={
					editable ? (shown) => void toggleShown(connection, shown) : undefined
				}
				onTest={editable ? () => void testConnection(connection) : undefined}
				onConfigure={
					editable ? () => configureDialog.openSettings(connection) : undefined
				}
			/>
		);
	};

	const wslRow = (info: WslConnectionInfo) => {
		const connection = info.connection;
		return (
			<ConnectionRow
				id={connection.id}
				kind={connection.kind.type}
				label={label(connection)}
				description={
					<Text class="font-sans text-[11px] text-muted-foreground">
						{t("connection.wslLabel")}
					</Text>
				}
				projectCount={projectCount(connection.id, info.projectCount)}
				shownInHome={connection.shownInHome ?? false}
				testing={() => testing().has(connection.id)}
				busy={() => busy() || configureDialog.probing()}
				onToggleShown={
					editable ? (shown) => void toggleShown(connection, shown) : undefined
				}
				onTest={editable ? () => void testConnection(connection) : undefined}
				onConfigure={
					editable ? () => configureDialog.openSettings(connection) : undefined
				}
				onRemove={editable ? () => removing.set(connection) : undefined}
			/>
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
		return (
			<ConnectionRow
				id={connection.id}
				kind={connection.kind.type}
				label={label(connection)}
				description={description}
				projectCount={projectCount(connection.id, info.projectCount)}
				shownInHome={connection.shownInHome ?? false}
				testing={() => testing().has(connection.id)}
				busy={() => busy() || configureDialog.probing()}
				onToggleShown={
					editable ? (shown) => void toggleShown(connection, shown) : undefined
				}
				onTest={editable ? () => void testConnection(connection) : undefined}
				onEdit={editable ? () => void sshEditor.openEdit(info) : undefined}
				onRemove={editable ? () => removing.set(connection) : undefined}
			/>
		);
	};

	const hostRow = (registry: HostRegistry, host: HostEntry) => {
		const { hostId } = host;
		const id = `host:${hostId}`;
		return (
			<ConnectionRow
				id={id}
				kind="remote"
				label={host.name}
				description={
					<Text class="font-sans text-[11px] text-muted-foreground">
						{`${t("hosts.remotePilo")} · ${t(HOST_STATUS_KEYS[host.status])}`}
					</Text>
				}
				shownInHome={host.shownInHome}
				testing={() => testing().has(hostId)}
				busy={busy}
				onToggleShown={(shown) => void toggleShown(host, shown)}
				onTest={() => void testRemote(host)}
				onEdit={() => {
					const mode = registry.record(hostId)?.proxyMode ?? "direct";
					nameDraft.set(host.name);
					proxyMode.set(mode);
					proxyUrl.set("");
					editError.set(null);
					editingHost.set({ host, proxyMode: mode });
				}}
				onRemove={() => removing.set(host)}
				actions={
					host.session ? (
						<SettingsIconButton
							testID={`settings-conn-disconnect-${id}`}
							accessibilityLabel={t("hosts.disconnect")}
							tooltip={t("hosts.disconnect")}
							disabled={busy() || testing().has(hostId)}
							onPress={() => registry.disconnect(hostId)}
						>
							<Icon name="WifiOff" size={16} />
						</SettingsIconButton>
					) : null
				}
			/>
		);
	};

	const proxyDraft = (): RemoteHostProxy | null | undefined => {
		const mode = proxyMode();
		const url = proxyUrl().trim();
		if (mode === editingHost()?.proxyMode && (mode !== "custom" || !url))
			return undefined;
		if (mode === "custom") return { mode, url };
		return mode === "system" ? { mode } : null;
	};
	const canSaveEdit = () => {
		const edit = editingHost();
		const name = nameDraft().trim();
		const proxy = proxyDraft();
		return (
			!!edit &&
			!busy() &&
			!!name &&
			(name !== edit.host.name || proxy !== undefined) &&
			(proxy?.mode !== "custom" || !!proxy.url)
		);
	};
	const closeEdit = () => {
		editingHost.set(null);
		proxyUrl.set("");
	};
	const saveEdit = async () => {
		const edit = editingHost();
		if (!registry || !edit || !canSaveEdit()) return;
		busy.set(true);
		editError.set(null);
		try {
			await registry.updateConnection(
				edit.host.hostId,
				nameDraft(),
				proxyDraft(),
			);
			closeEdit();
		} catch (error) {
			editError.set(remoteProxyError(error) ?? t("connection.saveFailed"));
		} finally {
			busy.set(false);
		}
	};

	const addConnectionMenu = () => {
		if (!editable && !remoteHostPairing) return null;
		const showWsl = editable && supportsWsl();
		if (!showWsl && (!editable || !remoteHostPairing)) {
			const label = t(editable ? "connection.addSsh" : "hosts.addRemote");
			return (
				<Button
					testID="settings-conn-add"
					variant="outline"
					size="icon"
					class={SETTINGS_HEADER_ICON_BUTTON_CLASS}
					accessibilityLabel={label}
					tooltip={textTooltip(label)}
					onPress={() => {
						if (editable) sshEditor.openNew();
						else addRemoteOpen.set(true);
					}}
				>
					<Icon name="Plus" size={14} />
				</Button>
			);
		}
		return (
			<Menu
				align="end"
				popupStyle={{ minWidth: 0 }}
				trigger={
					<Button
						testID="settings-conn-add"
						variant="outline"
						size="icon"
						class={SETTINGS_HEADER_ICON_BUTTON_CLASS}
						accessibilityLabel={t("connection.addConnection")}
						tooltip={textTooltip(t("connection.addConnection"))}
					>
						<Icon name="Plus" size={14} />
					</Button>
				}
			>
				<View class="gap-1">
					{showWsl ? (
						<MenuItem
							testID="settings-conn-add-wsl"
							indicatorClass="hidden"
							icon={<Icon name="Monitor" size={14} />}
							onSelect={() => wslPicker.openPicker()}
						>
							<Text class="font-sans">{t("connection.addWsl")}</Text>
						</MenuItem>
					) : null}
					<MenuItem
						testID="settings-conn-add-ssh"
						indicatorClass="hidden"
						icon={<Icon name="Server" size={14} />}
						onSelect={() => sshEditor.openNew()}
					>
						<Text class="font-sans">{t("connection.addSsh")}</Text>
					</MenuItem>
					{remoteHostPairing ? (
						<MenuItem
							testID="settings-conn-add-remote-host"
							indicatorClass="hidden"
							icon={<Icon name="Monitor" size={14} />}
							onSelect={() => addRemoteOpen.set(true)}
						>
							<Text class="font-sans">{t("hosts.addRemote")}</Text>
						</MenuItem>
					) : null}
				</View>
			</Menu>
		);
	};

	const lastRemoving = signal<ManagedConnection | null>(null);
	effect(() => {
		const next = removing();
		if (next) lastRemoving.set(next);
	});
	const removeDialog = () => {
		const active = removing();
		const connection = active ?? lastRemoving();
		if (!connection) return null;
		const remote = "hostId" in connection;
		const name = remote ? connection.name : label(connection);
		const dialogToasts = new AppToasts();
		return (
			<SettingsConfirmDialog
				testID="settings-conn-remove-dialog"
				open={active !== null}
				title={`${t("connection.removeQuestion")} · ${name}`}
				description={
					remote
						? t("hosts.removeDescription", { name })
						: `${t("connection.removeDescription", { name })}${connection.kind.type === "ssh" ? t("connection.sshCredentialsDeleted") : ""}`
				}
				confirmLabel={t("connection.confirmRemove")}
				busyLabel={t("connection.removing")}
				busy={busy()}
				destructive
				onOpenChange={(open) => {
					if (!open) removing.set(null);
				}}
				onClose={() => {
					if (!removing()) lastRemoving.set(null);
				}}
				onConfirm={() => void removeConnection(dialogToasts)}
			>
				<AppToastStack toasts={dialogToasts} />
			</SettingsConfirmDialog>
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
						<SettingsSectionMessage padded="roomy">
							{t("connection.loading")}
						</SettingsSectionMessage>
					) : (
						<>
							{wslItems().map(wslRow)}
							{sshItems().map(sshRow)}
							{() =>
								localLoadFailed() ? (
									<SettingsSectionMessage tone="error" size="2xs">
										{t("connection.localLoadFailed")}
									</SettingsSectionMessage>
								) : null
							}
							{() =>
								wslLoadFailed() ? (
									<SettingsSectionMessage tone="error" size="2xs">
										{t("connection.wslLoadFailed")}
									</SettingsSectionMessage>
								) : null
							}
							{() =>
								sshLoadFailed() ? (
									<SettingsSectionMessage tone="error" size="2xs">
										{t("connection.sshLoadFailed")}
									</SettingsSectionMessage>
								) : null
							}
						</>
					)
				}
				{() =>
					registry
						?.entries()
						.filter((host) => host.kind === "remote")
						.map((host) => hostRow(registry, host))
				}
			</SettingsSection>
			<SshConnectionEditorDialog editor={sshEditor} />
			<ConfigureConnectionDialog dialog={configureDialog} />
			<WslPickerDialog picker={wslPicker} />
			{remoteHostPairing ? (
				<AddRemoteHostDialog
					{...remoteHostPairing}
					open={addRemoteOpen}
					onPaired={(name) =>
						toasts.show({
							variant: "success",
							title: t("hosts.paired", { name }),
						})
					}
				/>
			) : null}
			{registry ? (
				<Dialog
					testID="settings-conn-host-name-dialog"
					open={editingHost() !== null}
					accessibilityLabel={t("hosts.editConnection")}
					closeOnEscape={!busy()}
					closeOnBackdropPress={!busy()}
					onOpenChange={({ open }) => {
						if (!open && !busy()) closeEdit();
					}}
				>
					<DialogHeader>
						<DialogTitle>{t("hosts.editConnection")}</DialogTitle>
					</DialogHeader>
					<Input
						testID="settings-conn-host-name-input"
						size="sm"
						autoFocus
						disabled={busy()}
						accessibilityLabel={t("settings.connectionName")}
						value={nameDraft()}
						onChange={(event) => nameDraft.set(event.value)}
						onSubmit={() => void saveEdit()}
					/>
					<View class="gap-1.5">
						<Text class="font-sans text-xs font-medium text-muted-foreground">
							{t("hosts.proxy")}
						</Text>
						<Select
							size="sm"
							testID="settings-conn-host-proxy"
							accessibilityLabel={t("hosts.proxy")}
							items={[
								{ value: "direct", title: t("hosts.proxyDirect") },
								{ value: "system", title: t("hosts.proxySystem") },
								{ value: "custom", title: t("hosts.proxyCustom") },
							]}
							value={proxyMode()}
							disabled={busy()}
							onChange={({ value }) =>
								proxyMode.set(
									value === "system" || value === "custom" ? value : "direct",
								)
							}
						/>
						{() =>
							proxyMode() === "custom" ? (
								<Input
									size="sm"
									testID="settings-conn-host-proxy-url"
									accessibilityLabel={t("hosts.proxyUrl")}
									placeholder={
										editingHost()?.proxyMode === "custom"
											? t("hosts.proxyKeepSaved")
											: "http://proxy.example:8080"
									}
									value={proxyUrl()}
									masked
									autoComplete="off"
									disabled={busy()}
									onChange={({ value }) => proxyUrl.set(value)}
									onSubmit={() => void saveEdit()}
								/>
							) : null
						}
					</View>
					{() =>
						editError() ? (
							<SettingsSectionMessage tone="error">
								{editError()}
							</SettingsSectionMessage>
						) : null
					}
					<DialogFooter>
						<Button
							variant="ghost"
							size="sm"
							disabled={busy()}
							onPress={closeEdit}
						>
							<Text class="font-sans">{t("common.cancel")}</Text>
						</Button>
						<Button
							testID="settings-conn-host-name-save"
							size="sm"
							disabled={!canSaveEdit()}
							onPress={() => void saveEdit()}
						>
							<Text class="font-sans">{t("common.save")}</Text>
						</Button>
					</DialogFooter>
				</Dialog>
			) : null}
			{() => removeDialog()}
			{/* Standalone fixture fallback; inside SettingsDialog the parent stack renders toasts. */}
			{ownToasts ? <AppToastStack toasts={ownToasts} /> : null}
		</View>
	);
}

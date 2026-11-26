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
import { AppToaster, AppToasts, AppToastStack } from "../shell/app-toasts";
import { connectionLabel } from "../shell/connection-label";
import type { AppState } from "../state/app-state";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { textTooltip } from "../ui/tooltip";
import { showConnectionTestToast } from "./connection-settings";
import {
	SETTINGS_HEADER_ICON_BUTTON_CLASS,
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
> &
	Partial<
		Pick<
			NshPiloClient,
			"getConnectionHealth" | "listSshConfigHosts" | "listSshLocalKeys"
		>
	>;

const IS_WINDOWS = platform.os === "windows";

export function ConnectionsPane(props: {
	state: Accessor<AppState>;
	client: ConnectionsClient;
}) {
	const client = props.client;
	const inheritedToasts = AppToaster();
	const ownToasts = inheritedToasts ? null : new AppToasts();
	const toasts = inheritedToasts ?? ownToasts!;
	const local = signal<Connection | null>(null);
	const wslItems = signal<WslConnectionInfo[]>([]);
	const sshItems = signal<SshConnectionInfo[]>([]);
	const loading = signal(true);
	const testing = signal<Set<string>>(new Set());
	const sshLoadFailed = signal(false);
	const removing = signal<Connection | null>(null);
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

	const projects = computed(() => props.state().projects);
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
		if (sshResult.status === "fulfilled") sshItems.set(sshResult.value);
		sshLoadFailed.set(sshResult.status === "rejected");
		if (wslResult.status === "fulfilled") wslItems.set(wslResult.value);
		loading.set(false);
	};

	/* The project list reloads on host configuration changes; reload the
	 * connection catalog with it, like React's configurationRevision effect. */
	effect(() => {
		void projects();
		void refresh();
	});

	const sshEditor = createSshEditor({ client, refresh, toasts });
	const configureDialog = createConfigureDialog({ client, refresh, toasts });
	const addedDistros = () =>
		new Set(
			wslItems().flatMap((info) =>
				info.connection.kind.type === "wsl"
					? [info.connection.kind.distro]
					: [],
			),
		);
	const wslPicker = createWslPicker({ client, refresh, toasts, addedDistros });

	const testConnection = async (connection: Connection) => {
		const id = connection.id;
		const label = connectionLabel(connection);
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
						title: t("connection.available", { name: label }),
						description,
					});
					return;
				}
				showConnectionTestToast(toasts, label, {
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
			showConnectionTestToast(toasts, label, { ok: true, result });
		} catch (caught) {
			showConnectionTestToast(toasts, label, { ok: false, error: caught });
		} finally {
			if (alive) setTesting(id, false);
		}
	};

	const toggleShown = async (connection: Connection, shown: boolean) => {
		try {
			await client.setConnectionShownInHome(connection.id, shown);
			await refresh();
		} catch (caught) {
			toasts.show({
				variant: "error",
				title: t("connection.saveFailed"),
				description: userErrorMessage(caught),
			});
		}
	};

	const removeConnection = async (dialogToasts: AppToasts) => {
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
			toasts.show({
				variant: "success",
				title: t("connection.removed", { name: connectionLabel(connection) }),
			});
		} catch (caught) {
			dialogToasts.show({
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
				connection={connection}
				label={connectionLabel(connection)}
				description={
					<Text class="font-sans text-[11px] text-muted-foreground">
						{t("connection.localMachine")}
					</Text>
				}
				projectCount={projectCount(connection.id, 0)}
				shownInHome={connection.shownInHome ?? true}
				testing={() => testing().has(connection.id)}
				busy={() => busy() || configureDialog.probing()}
				onToggleShown={(shown) => void toggleShown(connection, shown)}
				onTest={() => void testConnection(connection)}
				onConfigure={() => configureDialog.openSettings(connection)}
			/>
		);
	};

	const wslRow = (info: WslConnectionInfo) => {
		const connection = info.connection;
		return (
			<ConnectionRow
				connection={connection}
				label={connectionLabel(connection)}
				description={
					<Text class="font-sans text-[11px] text-muted-foreground">
						{t("connection.wslLabel")}
					</Text>
				}
				projectCount={projectCount(connection.id, info.projectCount)}
				shownInHome={connection.shownInHome ?? false}
				testing={() => testing().has(connection.id)}
				busy={() => busy() || configureDialog.probing()}
				onToggleShown={(shown) => void toggleShown(connection, shown)}
				onTest={() => void testConnection(connection)}
				onConfigure={() => configureDialog.openSettings(connection)}
				onRemove={() => removing.set(connection)}
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
				connection={connection}
				label={connectionLabel(connection)}
				description={description}
				projectCount={projectCount(connection.id, info.projectCount)}
				shownInHome={connection.shownInHome ?? false}
				testing={() => testing().has(connection.id)}
				busy={() => busy() || configureDialog.probing()}
				onToggleShown={(shown) => void toggleShown(connection, shown)}
				onTest={() => void testConnection(connection)}
				onEdit={() => void sshEditor.openEdit(info)}
				onRemove={() => removing.set(connection)}
			/>
		);
	};

	const addConnectionMenu = () =>
		!IS_WINDOWS ? (
			<Button
				testID="settings-conn-add"
				variant="outline"
				size="icon"
				class={SETTINGS_HEADER_ICON_BUTTON_CLASS}
				accessibilityLabel={t("connection.addSsh")}
				tooltip={textTooltip(t("connection.addSsh"))}
				onPress={() => sshEditor.openNew()}
			>
				<Icon name="Plus" size={14} />
			</Button>
		) : (
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
					<MenuItem
						testID="settings-conn-add-wsl"
						indicatorClass="hidden"
						icon={<Icon name="Monitor" size={14} />}
						onSelect={() => wslPicker.openPicker()}
					>
						<Text class="font-sans">{t("connection.addWsl")}</Text>
					</MenuItem>
					<MenuItem
						testID="settings-conn-add-ssh"
						indicatorClass="hidden"
						icon={<Icon name="Server" size={14} />}
						onSelect={() => sshEditor.openNew()}
					>
						<Text class="font-sans">{t("connection.addSsh")}</Text>
					</MenuItem>
				</View>
			</Menu>
		);

	const lastRemoving = signal<Connection | null>(null);
	effect(() => {
		const next = removing();
		if (next) lastRemoving.set(next);
	});
	const removeDialog = () => {
		const active = removing();
		const connection = active ?? lastRemoving();
		if (!connection) return null;
		const dialogToasts = new AppToasts();
		return (
			<SettingsConfirmDialog
				testID="settings-conn-remove-dialog"
				open={active !== null}
				title={`${t("connection.removeQuestion")} · ${connectionLabel(connection)}`}
				description={`${t("connection.removeDescription", {
					name: connectionLabel(connection),
				})}${connection.kind.type === "ssh" ? t("connection.sshCredentialsDeleted") : ""}`}
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
								sshLoadFailed() ? (
									<SettingsSectionMessage tone="error" size="2xs">
										{t("connection.sshLoadFailed")}
									</SettingsSectionMessage>
								) : null
							}
						</>
					)
				}
			</SettingsSection>
			<SshConnectionEditorDialog editor={sshEditor} />
			<ConfigureConnectionDialog dialog={configureDialog} />
			<WslPickerDialog picker={wslPicker} />
			{() => removeDialog()}
			{/* Standalone fixture fallback; inside SettingsDialog the parent stack renders toasts. */}
			{ownToasts ? <AppToastStack toasts={ownToasts} /> : null}
		</View>
	);
}

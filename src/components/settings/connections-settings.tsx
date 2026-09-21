import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { userErrorMessage } from "@/lib/app-error";
import {
	getLocalConnection,
	listWslConnections,
	probeConnectionPi,
	removeWslConnection,
	saveWslConnection,
	testLocalConnection,
	testWslConnection,
	updateConnectionSettings,
	type WslConnectionInfo,
} from "@/lib/connections";
import {
	listHomeConnectionIds,
	setConnectionShownInHome,
} from "@/lib/home-connections";
import type { Connection } from "@/lib/pi-runtime";
import {
	connectionLabel,
	listProjects,
	localConnection,
	wslConnection,
} from "@/lib/projects";
import {
	listSshConnections,
	removeSshConnection,
	saveSshConnection,
	testSshConnection,
	type SshConnectionInfo,
} from "@/lib/ssh-connections";

import {
	connectionFromSshForm,
	emptySshConnectionForm,
	sshConnectionFormFromInfo,
	type SshConnectionFormState,
} from "./connection-form";
import {
	ConnectionRow,
	ConnectionSettingsDialog,
	ConnectionsHelpSection,
	ConnectionsSection,
	WslDistributionDialog,
	sshConnectionDescription,
	type ConnectionSettingsDraft,
} from "./connection-sections";
import { SettingsConfirmDialog } from "./settings-confirm-dialog";
import { SshConnectionEditor } from "./ssh-connection-editor";

export function ConnectionsSettings() {
	const [local, setLocal] = useState<Connection>(() => localConnection());
	const [wslItems, setWslItems] = useState<WslConnectionInfo[]>([]);
	const [sshItems, setSshItems] = useState<SshConnectionInfo[]>([]);
	const [projectCounts, setProjectCounts] = useState<Map<string, number>>(
		() => new Map(),
	);
	const [shownIds, setShownIds] = useState<Set<string>>(() =>
		listHomeConnectionIds(),
	);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState<SshConnectionFormState | null>(null);
	const [connectionSettings, setConnectionSettings] =
		useState<ConnectionSettingsDraft | null>(null);
	const [probingPi, setProbingPi] = useState(false);
	const [wslPickerOpen, setWslPickerOpen] = useState(false);
	const [removingConnection, setRemovingConnection] =
		useState<Connection | null>(null);
	const [sshFieldError, setSshFieldError] = useState<{
		field: "identityFile" | "password";
		message: string;
	} | null>(null);

	const refresh = useCallback(async () => {
		const [localResult, sshResult, wslResult, projectsResult] =
			await Promise.allSettled([
				getLocalConnection(),
				listSshConnections(),
				listWslConnections(),
				listProjects(),
			]);
		if (localResult.status === "fulfilled") setLocal(localResult.value);
		if (sshResult.status === "fulfilled") {
			setSshItems(sshResult.value);
		} else {
			toast.error("读取 SSH 连接失败", {
				description: userErrorMessage(sshResult.reason),
			});
		}
		if (wslResult.status === "fulfilled") setWslItems(wslResult.value);
		if (projectsResult.status === "fulfilled") {
			const counts = new Map<string, number>();
			for (const project of projectsResult.value) {
				counts.set(
					project.connection.id,
					(counts.get(project.connection.id) ?? 0) + 1,
				);
			}
			setProjectCounts(counts);
		}
		setShownIds(listHomeConnectionIds());
		setLoading(false);
	}, []);

	useEffect(() => {
		const load = async () => {
			await refresh();
		};
		void load();
	}, [refresh]);

	const toggleShown = (id: string, shown: boolean) => {
		setConnectionShownInHome(id, shown);
		setShownIds(listHomeConnectionIds());
	};

	const projectCount = (id: string, fallback = 0) =>
		projectCounts.get(id) ?? fallback;

	const testConnection = async (
		label: string,
		test: () => Promise<{ serverVersion: string; protocolVersion: number }>,
	) => {
		setBusy(true);
		try {
			const result = await test();
			toast.success(`${label} 可用`, {
				description: `pilo-server ${result.serverVersion} · protocol ${result.protocolVersion}`,
			});
		} catch (error) {
			toast.error(`${label} 连接失败`, {
				description: userErrorMessage(error),
			});
		} finally {
			setBusy(false);
		}
	};

	const openConnectionSettings = (connection: Connection) => {
		setConnectionSettings({
			connection,
			name: connection.name,
			piExecutable: connection.piExecutable ?? "",
		});
	};

	const probePi = async (
		connection: Connection,
		executable?: string | null,
		updateDraft = false,
	) => {
		setProbingPi(true);
		try {
			const result = await probeConnectionPi(connection.id, executable);
			if (updateDraft) {
				setConnectionSettings((current) =>
					current?.connection.id === connection.id
						? { ...current, piExecutable: result.executable }
						: current,
				);
			}
			toast.success(`${connectionLabel(connection)} 的 Pi 可用`, {
				description: [result.executable, result.version]
					.filter(Boolean)
					.join(" · "),
			});
		} catch (error) {
			toast.error(`未检测到 ${connectionLabel(connection)} 可用的 Pi`, {
				description: userErrorMessage(error),
			});
		} finally {
			setProbingPi(false);
		}
	};

	const saveConnectionSettings = async () => {
		const draft = connectionSettings;
		if (!draft?.name.trim()) return;
		setBusy(true);
		try {
			await updateConnectionSettings(
				draft.connection.id,
				draft.name.trim(),
				draft.piExecutable.trim() || null,
			);
			setConnectionSettings(null);
			await refresh();
			toast.success("连接设置已保存");
		} catch (error) {
			toast.error("保存连接设置失败", {
				description: userErrorMessage(error),
			});
		} finally {
			setBusy(false);
		}
	};

	const addWsl = async (distro: string) => {
		setBusy(true);
		try {
			await saveWslConnection(wslConnection(distro));
			await refresh();
			toast.success(`已添加 WSL · ${distro}`);
		} catch (error) {
			toast.error("添加 WSL 发行版失败", {
				description: userErrorMessage(error),
			});
		} finally {
			setBusy(false);
		}
	};

	const saveSsh = async () => {
		if (!editing?.name.trim() || !editing.hostname.trim()) return;
		if (
			editing.mode === "direct" &&
			editing.authMethod === "key" &&
			!editing.identityFile.trim()
		) {
			setSshFieldError({
				field: "identityFile",
				message: "请选择或填写私钥路径。",
			});
			return;
		}
		if (
			editing.authMethod === "password" &&
			!editing.password &&
			!editing.hasPassword
		) {
			setSshFieldError({ field: "password", message: "请输入 SSH 密码。" });
			return;
		}
		setBusy(true);
		try {
			await saveSshConnection(
				connectionFromSshForm(editing),
				editing.password || undefined,
			);
			setEditing(null);
			await refresh();
			toast.success("SSH 连接已保存");
		} catch (error) {
			toast.error("保存 SSH 连接失败", {
				description: userErrorMessage(error),
			});
		} finally {
			setBusy(false);
		}
	};

	const removeConnection = async () => {
		const connection = removingConnection;
		if (!connection || connection.kind.type === "local") return;
		setBusy(true);
		try {
			if (connection.kind.type === "wsl") {
				await removeWslConnection(connection.id);
			} else {
				await removeSshConnection(connection.id);
			}
			setConnectionShownInHome(connection.id, false);
			await refresh();
			setRemovingConnection(null);
			toast.success(`已删除 ${connectionLabel(connection)}`);
		} catch (error) {
			toast.error("删除连接失败", {
				description: userErrorMessage(error),
			});
		} finally {
			setBusy(false);
		}
	};

	const addedDistros = new Set(
		wslItems.flatMap((info) =>
			info.connection.kind.type === "wsl" ? [info.connection.kind.distro] : [],
		),
	);

	return (
		<div className="space-y-3">
			<ConnectionsSection
				onAddSsh={() => {
					setSshFieldError(null);
					setEditing(emptySshConnectionForm());
				}}
				onAddWsl={() => setWslPickerOpen(true)}
			>
				<ConnectionRow
					connection={local}
					description="当前系统环境"
					projectCount={projectCount(local.id)}
					shownInHome={shownIds.has(local.id)}
					busy={busy || probingPi}
					onToggleShown={(shown) => toggleShown(local.id, shown)}
					onTest={() =>
						void testConnection(connectionLabel(local), testLocalConnection)
					}
					onProbePi={() => void probePi(local, local.piExecutable)}
					onConfigure={() => openConnectionSettings(local)}
				/>
				{loading ? (
					<div className="px-3 py-5 text-xs text-muted-foreground">
						正在读取连接…
					</div>
				) : (
					<>
						{wslItems.map((info) => {
							if (info.connection.kind.type !== "wsl") return null;
							const distro = info.connection.kind.distro;
							return (
								<ConnectionRow
									key={info.connection.id}
									connection={info.connection}
									description="WSL 发行版"
									projectCount={projectCount(
										info.connection.id,
										info.projectCount,
									)}
									shownInHome={shownIds.has(info.connection.id)}
									busy={busy || probingPi}
									onToggleShown={(shown) =>
										toggleShown(info.connection.id, shown)
									}
									onTest={() =>
										void testConnection(info.connection.name, () =>
											testWslConnection(distro),
										)
									}
									onProbePi={() =>
										void probePi(info.connection, info.connection.piExecutable)
									}
									onConfigure={() => openConnectionSettings(info.connection)}
									onRemove={() => setRemovingConnection(info.connection)}
								/>
							);
						})}
						{sshItems.map((info) =>
							info.connection.kind.type === "ssh" ? (
								<ConnectionRow
									key={info.connection.id}
									connection={info.connection}
									description={sshConnectionDescription(info.connection)}
									projectCount={projectCount(
										info.connection.id,
										info.projectCount,
									)}
									shownInHome={shownIds.has(info.connection.id)}
									busy={busy || probingPi}
									onToggleShown={(shown) =>
										toggleShown(info.connection.id, shown)
									}
									onTest={() =>
										void testConnection(info.connection.name, () =>
											testSshConnection(info.connection.id),
										)
									}
									onProbePi={() =>
										void probePi(info.connection, info.connection.piExecutable)
									}
									onConfigure={() => openConnectionSettings(info.connection)}
									onEdit={() => {
										setSshFieldError(null);
										setEditing(sshConnectionFormFromInfo(info));
									}}
									onRemove={() => setRemovingConnection(info.connection)}
								/>
							) : null,
						)}
					</>
				)}
			</ConnectionsSection>
			<ConnectionsHelpSection />
			<ConnectionSettingsDialog
				draft={connectionSettings}
				busy={busy}
				probing={probingPi}
				onChange={setConnectionSettings}
				onClose={() => setConnectionSettings(null)}
				onProbe={() => {
					const draft = connectionSettings;
					if (draft) {
						void probePi(draft.connection, draft.piExecutable || null, true);
					}
				}}
				onSave={() => void saveConnectionSettings()}
			/>
			<SshConnectionEditor
				editing={editing}
				busy={busy}
				fieldError={sshFieldError}
				onChange={(next) => {
					setEditing(next);
					if (sshFieldError) setSshFieldError(null);
				}}
				onClose={() => {
					setEditing(null);
					setSshFieldError(null);
				}}
				onSave={() => void saveSsh()}
			/>
			<WslDistributionDialog
				open={wslPickerOpen}
				busy={busy}
				addedDistros={addedDistros}
				onOpenChange={setWslPickerOpen}
				onAdd={(distro) => void addWsl(distro)}
			/>
			<SettingsConfirmDialog
				open={removingConnection !== null}
				title="删除连接？"
				description={
					removingConnection ? (
						<>
							将从 Pilo 中删除
							<span className="font-medium text-foreground">
								“{connectionLabel(removingConnection)}”
							</span>
							。关联项目记录也会移除，但不会删除实际项目文件。
							{removingConnection.kind.type === "ssh"
								? " 已保存的 SSH 凭据也会一并删除。"
								: null}
						</>
					) : null
				}
				confirmLabel="删除连接"
				busyLabel="正在删除…"
				busy={busy}
				destructive
				onOpenChange={(open) => {
					if (!open) setRemovingConnection(null);
				}}
				onConfirm={() => void removeConnection()}
			/>
		</div>
	);
}

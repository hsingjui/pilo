import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
	listWslConnections,
	removeWslConnection,
	saveWslConnection,
	testLocalConnection,
	testWslConnection,
	type WslConnectionInfo,
} from "@/lib/connections";
import {
	listHomeConnectionIds,
	setConnectionShownInHome,
} from "@/lib/home-connections";
import { listProjects, localConnection, wslConnection } from "@/lib/projects";
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
	ConnectionsHelpSection,
	ConnectionsSection,
	WslDistributionDialog,
	sshConnectionDescription,
} from "./connection-sections";
import { SshConnectionEditor } from "./ssh-connection-editor";

export function ConnectionsSettings() {
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
	const [wslPickerOpen, setWslPickerOpen] = useState(false);

	const refresh = useCallback(async () => {
		const [sshResult, wslResult, projectsResult] = await Promise.allSettled([
			listSshConnections(),
			listWslConnections(),
			listProjects(),
		]);
		if (sshResult.status === "fulfilled") {
			setSshItems(sshResult.value);
		} else {
			toast.error("读取 SSH 连接失败", {
				description: String(sshResult.reason),
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
			toast.error(`${label} 连接失败`, { description: String(error) });
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
			toast.error("添加 WSL 发行版失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const removeWsl = async (info: WslConnectionInfo) => {
		if (!window.confirm(`移除 WSL 连接“${info.connection.name}”？`)) return;
		setBusy(true);
		try {
			await removeWslConnection(info.connection.id);
			setConnectionShownInHome(info.connection.id, false);
			await refresh();
			toast.success("WSL 连接已移除");
		} catch (error) {
			toast.error("移除 WSL 连接失败", { description: String(error) });
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
			toast.error("请选择或填写私钥路径");
			return;
		}
		if (
			editing.authMethod === "password" &&
			!editing.password &&
			!editing.hasPassword
		) {
			toast.error("请输入 SSH 密码");
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
			toast.error("保存 SSH 连接失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const removeSsh = async (info: SshConnectionInfo) => {
		if (!window.confirm(`删除 SSH 连接“${info.connection.name}”？`)) return;
		setBusy(true);
		try {
			await removeSshConnection(info.connection.id);
			setConnectionShownInHome(info.connection.id, false);
			await refresh();
			toast.success("SSH 连接已删除");
		} catch (error) {
			toast.error("删除 SSH 连接失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const local = localConnection();
	const addedDistros = new Set(
		wslItems.flatMap((info) =>
			info.connection.kind.type === "wsl" ? [info.connection.kind.distro] : [],
		),
	);

	return (
		<div className="space-y-3">
			<ConnectionsSection
				onAddSsh={() => setEditing(emptySshConnectionForm())}
				onAddWsl={() => setWslPickerOpen(true)}
			>
				<ConnectionRow
					connection={local}
					description="当前系统环境"
					projectCount={projectCount(local.id)}
					shownInHome={shownIds.has(local.id)}
					busy={busy}
					onToggleShown={(shown) => toggleShown(local.id, shown)}
					onTest={() => void testConnection("Local", testLocalConnection)}
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
									busy={busy}
									onToggleShown={(shown) =>
										toggleShown(info.connection.id, shown)
									}
									onTest={() =>
										void testConnection(info.connection.name, () =>
											testWslConnection(distro),
										)
									}
									onRemove={() => void removeWsl(info)}
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
									busy={busy}
									onToggleShown={(shown) =>
										toggleShown(info.connection.id, shown)
									}
									onTest={() =>
										void testConnection(info.connection.name, () =>
											testSshConnection(info.connection.id),
										)
									}
									onEdit={() => setEditing(sshConnectionFormFromInfo(info))}
									onRemove={() => void removeSsh(info)}
								/>
							) : null,
						)}
					</>
				)}
			</ConnectionsSection>
			<ConnectionsHelpSection />
			<SshConnectionEditor
				editing={editing}
				busy={busy}
				onChange={setEditing}
				onClose={() => setEditing(null)}
				onSave={() => void saveSsh()}
			/>
			<WslDistributionDialog
				open={wslPickerOpen}
				busy={busy}
				addedDistros={addedDistros}
				onOpenChange={setWslPickerOpen}
				onAdd={(distro) => void addWsl(distro)}
			/>
		</div>
	);
}

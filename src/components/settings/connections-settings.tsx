import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import {
	listWslConnections,
	testLocalConnection,
	testWslConnection,
	type WslConnectionInfo,
} from "@/lib/connections";
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
	ConnectionsHelpSection,
	LocalWslConnectionsSection,
	SshConnectionsSection,
} from "./connection-sections";
import { SshConnectionEditor } from "./ssh-connection-editor";

export function ConnectionsSettings() {
	const [items, setItems] = useState<SshConnectionInfo[]>([]);
	const [wslItems, setWslItems] = useState<WslConnectionInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [editing, setEditing] = useState<SshConnectionFormState | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = useCallback(async () => {
		try {
			setItems(await listSshConnections());
		} catch (error) {
			toast.error("读取 SSH 连接失败", { description: String(error) });
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		let cancelled = false;
		void Promise.allSettled([listSshConnections(), listWslConnections()]).then(
			([sshResult, wslResult]) => {
				if (cancelled) return;
				if (sshResult.status === "fulfilled") {
					setItems(sshResult.value);
				} else {
					toast.error("读取 SSH 连接失败", {
						description: String(sshResult.reason),
					});
				}
				if (wslResult.status === "fulfilled") setWslItems(wslResult.value);
				setLoading(false);
			},
		);
		return () => {
			cancelled = true;
		};
	}, []);

	const save = async () => {
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

	const testSsh = async (id: string) => {
		setBusy(true);
		try {
			const result = await testSshConnection(id);
			toast.success("SSH 连接可用", {
				description: `pilo-server ${result.serverVersion} · protocol ${result.protocolVersion}`,
			});
		} catch (error) {
			toast.error("SSH 连接失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const testWsl = async (distro: string) => {
		setBusy(true);
		try {
			const result = await testWslConnection(distro);
			toast.success(`${distro} 可用`, {
				description: `pilo-server ${result.serverVersion} · protocol ${result.protocolVersion}`,
			});
		} catch (error) {
			toast.error(`${distro} 连接失败`, { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const testLocal = async () => {
		setBusy(true);
		try {
			const result = await testLocalConnection();
			toast.success("Local 可用", {
				description: `pilo-server ${result.serverVersion} · protocol ${result.protocolVersion}`,
			});
		} catch (error) {
			toast.error("Local 连接失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	const remove = async (info: SshConnectionInfo) => {
		if (!window.confirm(`删除 SSH 连接“${info.connection.name}”？`)) return;
		setBusy(true);
		try {
			await removeSshConnection(info.connection.id);
			await refresh();
			toast.success("SSH 连接已删除");
		} catch (error) {
			toast.error("删除 SSH 连接失败", { description: String(error) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="space-y-3">
			<LocalWslConnectionsSection
				items={wslItems}
				loading={loading}
				busy={busy}
				onTestLocal={() => void testLocal()}
				onTestWsl={(distro) => void testWsl(distro)}
			/>
			<SshConnectionsSection
				items={items}
				loading={loading}
				busy={busy}
				onAdd={() => setEditing(emptySshConnectionForm())}
				onEdit={(info) => setEditing(sshConnectionFormFromInfo(info))}
				onRemove={(info) => void remove(info)}
				onTest={(id) => void testSsh(id)}
			/>
			<ConnectionsHelpSection />
			<SshConnectionEditor
				editing={editing}
				busy={busy}
				onChange={setEditing}
				onClose={() => setEditing(null)}
				onSave={() => void save()}
			/>
		</div>
	);
}

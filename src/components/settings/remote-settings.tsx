import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";

import {
	getRemoteHostState,
	regenerateRemotePairing,
	renameRemoteDevice,
	revokeRemoteDevice,
	setRemoteEnabled,
	setRemotePort,
	type RemoteDevice,
	type RemoteHostState,
} from "@/lib/remote";
import { Button, Input, Spinner, Switch } from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_TEXT_BUTTON_CLASS,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./compact-layout";

/** 双击 / Enter / 铅笔按钮进入重命名,Enter/失焦保存,Escape 取消。 */
function DeviceNameCell({
	device,
	onRename,
}: {
	device: RemoteDevice;
	onRename: (name: string) => void;
}) {
	const { t } = useTranslation();
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(device.name);
	const inputRef = useRef<HTMLInputElement>(null);

	/* oxlint-disable react/set-state-in-effect -- 进入编辑时一次性聚焦并全选，便于直接覆盖旧名称。 */
	useEffect(() => {
		if (!editing) return;
		inputRef.current?.focus();
		inputRef.current?.select();
	}, [editing]);
	/* oxlint-enable react/set-state-in-effect */

	if (!editing) {
		const startEditing = () => {
			setDraft(device.name);
			setEditing(true);
		};
		return (
			<span className="flex items-center gap-1.5">
				<button
					type="button"
					title={t("settings.remoteRenameHint")}
					className="text-left font-medium leading-tight text-foreground"
					onDoubleClick={startEditing}
					onKeyDown={(event) => {
						if (event.key !== "Enter") return;
						startEditing();
					}}
				>
					{device.name}
					{device.pairIp ? (
						<span className="ml-2 font-mono text-2xs font-normal text-muted-foreground">
							{device.pairIp}
						</span>
					) : null}
				</button>
				<button
					type="button"
					aria-label={t("settings.remoteRename")}
					title={t("settings.remoteRenameHint")}
					className="text-muted-foreground transition-colors hover:text-foreground"
					onClick={startEditing}
				>
					<Pencil className="size-3" />
				</button>
			</span>
		);
	}

	const commit = () => {
		const next = draft.trim();
		setEditing(false);
		if (next && next !== device.name) onRename(next);
	};

	return (
		<Input
			ref={inputRef}
			className="h-7 w-full text-sm"
			value={draft}
			aria-label={t("settings.remoteRename")}
			onChange={(event) => setDraft(event.target.value)}
			onBlur={commit}
			onKeyDown={(event) => {
				if (event.key === "Enter") commit();
				if (event.key === "Escape") setEditing(false);
			}}
		/>
	);
}

export function RemoteSettings() {
	const { t } = useTranslation();
	const [state, setState] = useState<RemoteHostState | null>(null);
	const [busy, setBusy] = useState<
		"toggle" | "port" | "pairing" | string | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [portDraft, setPortDraft] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			const next = await getRemoteHostState();
			setState(next);
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	/* oxlint-disable react/set-state-in-effect -- This settings panel mirrors lifecycle state owned by the external Rust Remote Host. */
	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		if (!state?.enabled) return;
		const timer = window.setInterval(() => void refresh(), 3_000);
		return () => window.clearInterval(timer);
	}, [refresh, state?.enabled]);
	/* oxlint-enable react/set-state-in-effect */

	const activeDevices = useMemo(
		() =>
			(state?.devices ?? []).filter((device) => device.revokedAtMs === null),
		[state?.devices],
	);

	const toggle = async (enabled: boolean) => {
		if (busy) return;
		setBusy("toggle");
		try {
			const next = await setRemoteEnabled(enabled);
			setState(next);
			setError(null);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			toast.error(t("settings.remoteActionFailed"), { description: message });
		} finally {
			setBusy(null);
		}
	};

	const savePort = async () => {
		if (busy || !state || portDraft === null) return;
		const port = Number(portDraft);
		if (port === state.port) {
			setPortDraft(null);
			return;
		}
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			toast.error(t("settings.remotePortInvalid"));
			setPortDraft(null);
			return;
		}
		setBusy("port");
		try {
			setState(await setRemotePort(port));
			setPortDraft(null);
			setError(null);
			toast.success(t("settings.remotePortSaved"));
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			toast.error(t("settings.remoteActionFailed"), { description: message });
		} finally {
			setBusy(null);
		}
	};

	const regenerate = async () => {
		if (busy) return;
		setBusy("pairing");
		try {
			setState(await regenerateRemotePairing());
			setError(null);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			toast.error(t("settings.remoteActionFailed"), { description: message });
		} finally {
			setBusy(null);
		}
	};

	const revoke = async (deviceId: string) => {
		if (busy) return;
		setBusy(deviceId);
		try {
			setState(await revokeRemoteDevice(deviceId));
			setError(null);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			toast.error(t("settings.remoteActionFailed"), { description: message });
		} finally {
			setBusy(null);
		}
	};

	const rename = async (deviceId: string, name: string) => {
		try {
			setState(await renameRemoteDevice(deviceId, name));
			setError(null);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			toast.error(t("settings.remoteActionFailed"), { description: message });
		}
	};

	const copyToClipboard = async (value: string | null | undefined) => {
		if (!value) return;
		try {
			await navigator.clipboard.writeText(value);
			toast.success(t("settings.remoteLinkCopied"));
		} catch (cause) {
			toast.error(t("settings.remoteCopyFailed"), {
				description: cause instanceof Error ? cause.message : String(cause),
			});
		}
	};

	if (!state) {
		return (
			<div className={SETTINGS_CONTAINER_CLASS}>
				<SettingsSection>
					<SettingsRow label={t("settings.remoteWebUi")}>
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Spinner className="size-3.5" />
							{t("settings.remoteLoading")}
						</div>
					</SettingsRow>
				</SettingsSection>
			</div>
		);
	}

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection>
				<SettingsRow
					label={t("settings.remoteWebUi")}
					helper={t("settings.remoteDescription")}
				>
					<div className="flex items-center gap-2">
						<div className="flex items-center gap-1.5">
							<span className="text-2xs text-muted-foreground">
								{t("settings.remotePort")}
							</span>
							<Input
								className="h-7 w-[4.5rem] text-right font-mono text-2xs"
								inputMode="numeric"
								value={portDraft ?? String(state.port)}
								disabled={busy === "port"}
								onChange={(event) => setPortDraft(event.target.value)}
								onBlur={() => void savePort()}
								onKeyDown={(event) => {
									if (event.key === "Enter") void savePort();
								}}
								aria-label={t("settings.remotePort")}
							/>
						</div>
						<SettingsStatus muted={!state.running}>
							{state.running
								? t("settings.remoteRunning")
								: t("settings.remoteStopped")}
						</SettingsStatus>
						<Switch
							checked={state.enabled}
							disabled={busy === "toggle"}
							onCheckedChange={(checked) => void toggle(checked)}
							aria-label={t("settings.remoteWebUi")}
						/>
					</div>
				</SettingsRow>
				{error || state.lastError ? (
					<SettingsRow
						label={t("settings.remoteError")}
						helper={error ?? state.lastError}
					>
						<Button
							variant="ghost"
							size="sm"
							className={SETTINGS_TEXT_BUTTON_CLASS}
							onClick={() => void toggle(true)}
						>
							<RefreshCw className="size-3.5" />
							{t("common.retry")}
						</Button>
					</SettingsRow>
				) : null}
			</SettingsSection>

			{state.enabled && state.running && state.baseUrl ? (
				<SettingsSection
					title={t("settings.remoteAccessAddress")}
					headerRight={t("settings.remoteAccessAddressHint")}
				>
					<SettingsRow
						label={<span className="font-mono text-2xs">{state.baseUrl}</span>}
					>
						<Button
							variant="outline"
							size="sm"
							className={SETTINGS_TEXT_BUTTON_CLASS}
							onClick={() => void copyToClipboard(state.baseUrl)}
						>
							<Copy className="size-3.5" />
							{t("settings.remoteCopyLink")}
						</Button>
					</SettingsRow>
				</SettingsSection>
			) : null}

			{state.enabled && state.running ? (
				<SettingsSection
					title={t("settings.remotePairing")}
					headerRight={t("settings.remotePairingHint")}
				>
					{state.pairingUrl ? (
						<div className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_148px] sm:items-center">
							<div className="min-w-0 space-y-2">
								<p className="text-sm font-medium">
									{t("settings.remoteOpenLink")}
								</p>
								<div
									className="truncate rounded-md border bg-muted/30 px-2.5 py-1.5 font-mono text-2xs leading-5"
									title={state.pairingUrl}
								>
									{state.pairingUrl}
								</div>
								<div className="flex flex-wrap gap-1.5">
									<Button
										variant="outline"
										size="sm"
										className={SETTINGS_TEXT_BUTTON_CLASS}
										onClick={() => void copyToClipboard(state.pairingUrl)}
									>
										<Copy className="size-3.5" />
										{t("settings.remoteCopyLink")}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										className={SETTINGS_TEXT_BUTTON_CLASS}
										disabled={busy === "pairing"}
										onClick={() => void regenerate()}
									>
										<RefreshCw
											className={
												busy === "pairing"
													? "size-3.5 animate-spin"
													: "size-3.5"
											}
										/>
										{t("settings.remoteNewLink")}
									</Button>
								</div>
							</div>
							<div className="mx-auto rounded-xl border bg-white p-2.5">
								<QRCodeSVG
									value={state.pairingUrl}
									size={124}
									level="M"
									marginSize={0}
								/>
							</div>
						</div>
					) : (
						<SettingsRow
							label={t("settings.remotePairingExpired")}
							helper={t("settings.remotePairingExpiredDescription")}
						>
							<Button
								variant="outline"
								size="sm"
								className={SETTINGS_TEXT_BUTTON_CLASS}
								disabled={busy === "pairing"}
								onClick={() => void regenerate()}
							>
								<RefreshCw className="size-3.5" />
								{t("settings.remoteNewLink")}
							</Button>
						</SettingsRow>
					)}
				</SettingsSection>
			) : null}

			<SettingsSection
				title={t("settings.remoteDevices")}
				headerRight={t("settings.remoteDeviceCount", {
					count: activeDevices.length,
				})}
			>
				{activeDevices.length === 0 ? (
					<SettingsRow
						label={t("settings.remoteNoDevices")}
						helper={t("settings.remoteNoDevicesDescription")}
					/>
				) : (
					activeDevices.map((device) => (
						<SettingsRow
							key={device.id}
							label={
								<DeviceNameCell
									device={device}
									onRename={(name) => void rename(device.id, name)}
								/>
							}
						>
							<Button
								variant="ghost"
								size="sm"
								className={SETTINGS_TEXT_BUTTON_CLASS}
								disabled={busy === device.id}
								onClick={() => void revoke(device.id)}
							>
								{busy === device.id ? (
									<Spinner className="size-3.5" />
								) : (
									<Trash2 className="size-3.5" />
								)}
								{t("settings.remoteRevoke")}
							</Button>
						</SettingsRow>
					))
				)}
			</SettingsSection>
		</div>
	);
}

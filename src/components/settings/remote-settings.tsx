import { useConfigurationRevision } from "@/lib/use-configuration-revision";
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
	setRemoteAddresses,
	type RemoteAccessAddress,
	type RemoteDevice,
	type RemoteHostState,
} from "@/lib/api/remote";
import { randomId } from "@/lib/utils";
import {
	remoteAddressConfig,
	sameAddressList,
	sortRemoteAddresses,
} from "@/lib/remote-addresses";
import { Button, Input, Spinner, Switch } from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_TEXT_BUTTON_CLASS,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./compact-layout";
import { RemoteLanAddressPicker } from "./remote-lan-address-picker";

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

export function RemoteSettings({
	initialState,
}: {
	initialState?: RemoteHostState | null;
}) {
	const configurationRevision = useConfigurationRevision();
	const { t } = useTranslation();
	const [state, setState] = useState<RemoteHostState | null>(
		initialState ?? null,
	);
	const [busy, setBusy] = useState<
		"toggle" | "port" | "pairing" | string | null
	>(null);
	const [error, setError] = useState<string | null>(null);
	const [portDraft, setPortDraft] = useState<string | null>(null);
	const [addressDraft, setAddressDraft] = useState<
		RemoteAccessAddress[] | null
	>(null);
	const [savingAddressDraft, setSavingAddressDraft] = useState(false);
	const savingAddresses = useRef(false);
	const addressRevision = useRef(0);
	const draftRevision = useRef(0);
	const focusAddressId = useRef<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			if (savingAddresses.current) return;
			const revision = addressRevision.current;
			const next = await getRemoteHostState();
			if (savingAddresses.current || revision !== addressRevision.current)
				return;
			const config = remoteAddressConfig(next.addresses, next.entryAddressId);
			if (
				config.entryAddressId !== next.entryAddressId &&
				!next.addressConfigError
			) {
				savingAddresses.current = true;
				addressRevision.current += 1;
				try {
					setState(
						await setRemoteAddresses(next.addresses, config.entryAddressId),
					);
				} finally {
					savingAddresses.current = false;
				}
			} else {
				setState(next);
			}
			setError(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	/* oxlint-disable react/set-state-in-effect -- This settings panel mirrors lifecycle state owned by the external Rust Remote Host. */
	/* oxlint-disable react/exhaustive-effect-dependencies -- Host configuration revisions intentionally reload externally owned settings. */
	useEffect(() => {
		void refresh();
	}, [refresh, configurationRevision]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	useEffect(() => {
		if (!state?.enabled) return;
		const timer = window.setInterval(() => void refresh(), 3_000);
		return () => window.clearInterval(timer);
	}, [refresh, state?.enabled]);
	/* oxlint-enable react/set-state-in-effect */

	const addresses = useMemo(
		() => sortRemoteAddresses(state?.addresses ?? []),
		[state?.addresses],
	);

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

	const saveAddresses = async (
		draft = addressDraft ?? addresses,
	): Promise<RemoteAccessAddress[] | null> => {
		if (busy || savingAddresses.current || !state) return null;
		const config = remoteAddressConfig(draft, state.entryAddressId);
		if (
			sameAddressList(sortRemoteAddresses(config.addresses), addresses) &&
			config.entryAddressId === state.entryAddressId
		)
			return draft;
		savingAddresses.current = true;
		setSavingAddressDraft(true);
		addressRevision.current += 1;
		const draftRevisionAtStart = draftRevision.current;
		try {
			const next = await setRemoteAddresses(
				config.addresses,
				config.entryAddressId,
			);
			const savedDraft = draft.map(
				(address) =>
					next.addresses.find((item) => item.id === address.id) ?? address,
			);
			setState(next);
			// A save that overlapped new typing must not clobber the newer draft.
			if (draftRevision.current === draftRevisionAtStart)
				setAddressDraft(
					savedDraft.some((address) => !address.baseUrl.trim())
						? savedDraft
						: null,
				);
			setError(null);
			return savedDraft;
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			setError(message);
			toast.error(t("settings.remoteActionFailed"), { description: message });
			return null;
		} finally {
			savingAddresses.current = false;
			setSavingAddressDraft(false);
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
				{error || state.lastError || state.addressConfigError ? (
					<SettingsRow
						label={t("settings.remoteError")}
						helper={error ?? state.lastError ?? state.addressConfigError}
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

			<SettingsSection
				title={t("settings.remoteAccessAddress")}
				headerRight={
					<RemoteLanAddressPicker
						port={state.port}
						addresses={addressDraft ?? addresses}
						disabled={
							Boolean(busy) ||
							savingAddressDraft ||
							(addressDraft ?? addresses).filter((item) => item.baseUrl.trim())
								.length >= 32
						}
						onAdd={(baseUrl) => {
							if (busy || savingAddresses.current) return;
							const current = addressDraft ?? addresses;
							const host = new URL(baseUrl).hostname.replaceAll(".", "-");
							const id = `lan-${host}-${randomId().replaceAll("-", "")}`;
							const empty = current.find((item) => !item.baseUrl.trim());
							const next = empty
								? current.map((item) =>
										item.id === empty.id ? { ...item, id, baseUrl } : item,
									)
								: [...current, { id, name: "", baseUrl }];
							draftRevision.current += 1;
							setAddressDraft(next);
							void saveAddresses(next);
						}}
					/>
				}
			>
				<div className="space-y-2 px-3 py-3">
					{(addressDraft ?? addresses).map((address, index) => (
						<div key={address.id} className="flex items-center gap-2">
							<Input
								ref={(input) => {
									if (input && focusAddressId.current === address.id) {
										input.focus();
										focusAddressId.current = null;
									}
								}}
								className="min-h-11 min-w-0 flex-1 font-mono text-xs sm:min-h-9"
								inputMode="url"
								enterKeyHint="next"
								autoCapitalize="none"
								autoCorrect="off"
								spellCheck={false}
								maxLength={2048}
								value={address.baseUrl}
								placeholder="https://example.com"
								disabled={Boolean(busy)}
								aria-label={`${t("settings.remoteAddressUrl")} ${index + 1}`}
								onChange={(event) => {
									draftRevision.current += 1;
									setAddressDraft((current) =>
										(current ?? addresses).map((item) =>
											item.id === address.id
												? Object.assign({}, item, {
														baseUrl: event.target.value,
													})
												: item,
										),
									);
								}}
								onBlur={(event) => {
									if (event.relatedTarget?.hasAttribute("data-remove-address"))
										return;
									void saveAddresses();
								}}
								onKeyDown={async (event) => {
									if (event.key !== "Enter" || event.nativeEvent.isComposing)
										return;
									event.preventDefault();
									const draftRevisionAtStart = draftRevision.current;
									const saved = await saveAddresses();
									if (!saved || draftRevision.current !== draftRevisionAtStart)
										return;
									const empty = saved.find((item) => !item.baseUrl.trim());
									if (empty) {
										focusAddressId.current = empty.id;
										setAddressDraft([...saved]);
									} else if (saved.length < 32) {
										const id = randomId();
										focusAddressId.current = id;
										setAddressDraft([...saved, { id, name: "", baseUrl: "" }]);
									}
								}}
							/>
							<Button
								variant="ghost"
								size="icon"
								className="size-11 shrink-0 sm:size-9"
								disabled={
									!state.addresses.some(
										(item) => item.baseUrl === address.baseUrl,
									)
								}
								aria-label={`${t("settings.remoteCopyLink")} ${address.baseUrl}`}
								onClick={() => void copyToClipboard(address.baseUrl)}
							>
								<Copy className="size-4" />
							</Button>
							<Button
								variant="ghost"
								size="icon"
								className="size-11 shrink-0 sm:size-9"
								disabled={
									Boolean(busy) || (addressDraft ?? addresses).length <= 1
								}
								data-remove-address=""
								onPointerDown={(event) => event.preventDefault()}
								aria-label={`${t("common.remove")} ${address.baseUrl || index + 1}`}
								onClick={() => {
									const next = (addressDraft ?? addresses).filter(
										(item) => item.id !== address.id,
									);
									draftRevision.current += 1;
									setAddressDraft(next);
									void saveAddresses(next);
								}}
							>
								<Trash2 className="size-4" />
							</Button>
						</div>
					))}
					<p className="text-xs leading-5 text-muted-foreground">
						{t("settings.remoteAddressConfigHint")}
					</p>
				</div>
			</SettingsSection>

			{state.enabled && state.running ? (
				<SettingsSection title={t("settings.remotePairing")}>
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
									title={t("settings.remotePairingPageTitle")}
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

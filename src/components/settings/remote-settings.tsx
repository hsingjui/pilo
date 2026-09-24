import { useCallback, useEffect, useMemo, useState } from "react";
import { Copy, RefreshCw, Trash2, Wifi, WifiOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";

import {
	getRemoteHostState,
	regenerateRemotePairing,
	revokeRemoteDevice,
	setRemoteEnabled,
	type RemoteHostState,
} from "@/lib/remote";
import { Button, Spinner, Switch } from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_TEXT_BUTTON_CLASS,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./compact-layout";

function relativeDeviceTime(value: number) {
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

export function RemoteSettings() {
	const { t } = useTranslation();
	const [state, setState] = useState<RemoteHostState | null>(null);
	const [busy, setBusy] = useState<"toggle" | "pairing" | string | null>(null);
	const [error, setError] = useState<string | null>(null);

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

	const copyPairingLink = async () => {
		if (!state?.pairingUrl) return;
		try {
			await navigator.clipboard.writeText(state.pairingUrl);
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

			{state.enabled && state.running ? (
				<SettingsSection
					title={t("settings.remotePairing")}
					headerRight={t("settings.remotePairingHint")}
				>
					{state.pairingUrl ? (
						<div className="grid gap-4 px-3 py-4 sm:grid-cols-[minmax(0,1fr)_180px] sm:items-center">
							<div className="min-w-0 space-y-3">
								<div>
									<p className="text-sm font-medium">
										{t("settings.remoteOpenLink")}
									</p>
									<p className="mt-1 text-2xs leading-5 text-muted-foreground">
										{t("settings.remoteOpenLinkDescription")}
									</p>
								</div>
								<div className="break-all rounded-md border bg-muted/30 px-2.5 py-2 font-mono text-2xs leading-5">
									{state.pairingUrl}
								</div>
								<div className="flex flex-wrap gap-1.5">
									<Button
										variant="outline"
										size="sm"
										className={SETTINGS_TEXT_BUTTON_CLASS}
										onClick={() => void copyPairingLink()}
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
							<div className="mx-auto rounded-xl border bg-white p-3">
								<QRCodeSVG
									value={state.pairingUrl}
									size={154}
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
					<SettingsRow
						label={t("settings.remoteAddress")}
						helper={t("settings.remoteAddressDescription")}
					>
						<code className="max-w-[360px] truncate text-2xs text-muted-foreground">
							{state.baseUrl}
						</code>
					</SettingsRow>
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
							label={device.name}
							helper={t("settings.remoteDeviceDetails", {
								lastSeen: relativeDeviceTime(device.lastSeenAtMs),
								expires: relativeDeviceTime(device.expiresAtMs),
							})}
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

			<SettingsSection>
				<SettingsRow
					label={t("settings.remoteSecurity")}
					helper={t("settings.remoteSecurityDescription")}
				>
					{state.running ? (
						<Wifi className="size-4 text-muted-foreground" />
					) : (
						<WifiOff className="size-4 text-muted-foreground" />
					)}
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}

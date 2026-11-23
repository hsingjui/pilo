import {
	cleanup,
	computed,
	effect,
	Clipboard,
	type InputRef,
	signal,
	Text,
	View,
} from "nsh";
import type {
	RemoteAccessAddress,
	RemoteHostState,
} from "@shared/api/remote-types";
import { userErrorMessage } from "@shared/app-error";
import {
	remoteAddressConfig,
	sameAddressList,
	sortRemoteAddresses,
} from "@shared/remote-addresses";
import { randomId } from "@shared/random-id";
import { AppToaster, showToast } from "../app/app-toasts";
import { t } from "../app/i18n";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { subscribeSettingsEvents } from "./connection-settings";
import {
	SettingsActionButton,
	SettingsIconButton,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./layout";
import { RemoteDevicesSection } from "./remote-devices-section";
import { RemoteLanAddressPicker } from "./remote-lan-address-picker";
import { RemotePairingSection } from "./remote-pairing-section";
import type { SettingsClient } from "./settings-dialog";

const MAX_ADDRESSES = 32;

/**
 * The Remote settings pane: Remote Host on/off and port, LAN access
 * addresses, the pairing link + QR, and paired devices. Mirrors
 * `remote-settings.tsx`, toasts included.
 */
export function RemotePane(props: {
	client: SettingsClient;
	/** The state the sidebar already polled, shown before the first load. */
	initialState?: RemoteHostState | null;
}) {
	const client = props.client;
	const state = signal<RemoteHostState | null>(props.initialState ?? null);
	const busy = signal<"toggle" | "port" | "pairing" | string | null>(null);
	const error = signal<string | null>(null);
	const toasts = AppToaster();
	const portDraft = signal<string | null>(null);
	const addressDraft = signal<RemoteAccessAddress[] | null>(null);
	const savingAddressDraft = signal(false);
	/* The same guards as React's refs: a save in flight blocks refresh, and
	 * revisions keep a slow save from clobbering newer typing. */
	let savingAddresses = false;
	let addressRevision = 0;
	let draftRevision = 0;
	let alive = true;
	cleanup(() => {
		alive = false;
	});
	/** Address fields by row id, so Enter can move to the next row. */
	const addressInputs = new Map<string, InputRef>();

	const addresses = computed(() =>
		sortRemoteAddresses(state()?.addresses ?? []),
	);
	const activeDevices = computed(() =>
		(state()?.devices ?? []).filter((device) => device.revokedAtMs === null),
	);
	/* Boolean gates for `{() =>}` branches: a section mounts once when its
	 * gate flips, so a poll never remounts mounted rows and fields. */
	const loaded = computed(() => state() !== null);
	const pairingVisible = computed(() => {
		const current = state();
		return Boolean(current?.enabled && current.running);
	});
	const hasPairingLink = computed(() => Boolean(state()?.pairingUrl));

	const refresh = async () => {
		try {
			if (savingAddresses) return;
			const revision = addressRevision;
			const next = await client.remoteHostState();
			if (!alive || savingAddresses || revision !== addressRevision) return;
			const config = remoteAddressConfig(next.addresses, next.entryAddressId);
			if (
				config.entryAddressId !== next.entryAddressId &&
				!next.addressConfigError
			) {
				savingAddresses = true;
				addressRevision += 1;
				try {
					const updated = await client.remoteSetAddresses(
						next.addresses,
						config.entryAddressId,
					);
					if (alive) state.set(updated);
				} finally {
					savingAddresses = false;
				}
			} else {
				state.set(next);
			}
			if (alive) error.set(null);
		} catch (caught) {
			if (alive) error.set(userErrorMessage(caught));
		}
	};

	void refresh();
	subscribeSettingsEvents(client, (event) => {
		if (event.type === "configuration_changed") void refresh();
	});

	const enabled = computed(() => state()?.enabled ?? false);
	effect(() => {
		if (!enabled()) return;
		const timer = setInterval(() => void refresh(), 3_000);
		return () => clearInterval(timer);
	});

	const fail = (caught: unknown) => {
		const message = userErrorMessage(caught);
		error.set(message);
		showToast(toasts, {
			variant: "error",
			title: t("settings.remoteActionFailed"),
			description: message,
		});
	};

	const toggle = async (next: boolean) => {
		if (busy()) return;
		busy.set("toggle");
		try {
			state.set(await client.remoteSetEnabled(next));
			error.set(null);
		} catch (caught) {
			fail(caught);
		} finally {
			busy.set(null);
		}
	};

	const savePort = async () => {
		const current = state();
		const draft = portDraft();
		if (busy() || !current || draft === null) return;
		const port = Number(draft);
		if (port === current.port) {
			portDraft.set(null);
			return;
		}
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			showToast(toasts, {
				variant: "error",
				title: t("settings.remotePortInvalid"),
			});
			portDraft.set(null);
			return;
		}
		busy.set("port");
		try {
			state.set(await client.remoteSetPort(port));
			portDraft.set(null);
			error.set(null);
			showToast(toasts, {
				variant: "success",
				title: t("settings.remotePortSaved"),
			});
		} catch (caught) {
			fail(caught);
		} finally {
			busy.set(null);
		}
	};

	const saveAddresses = async (
		draft: RemoteAccessAddress[] = addressDraft() ?? addresses(),
	): Promise<RemoteAccessAddress[] | null> => {
		const current = state();
		if (busy() || savingAddresses || !current) return null;
		const config = remoteAddressConfig(draft, current.entryAddressId);
		if (
			sameAddressList(sortRemoteAddresses(config.addresses), addresses()) &&
			config.entryAddressId === current.entryAddressId
		)
			return draft;
		savingAddresses = true;
		savingAddressDraft.set(true);
		addressRevision += 1;
		const draftRevisionAtStart = draftRevision;
		try {
			const next = await client.remoteSetAddresses(
				config.addresses,
				config.entryAddressId,
			);
			const savedDraft = draft.map(
				(address) =>
					next.addresses.find((item) => item.id === address.id) ?? address,
			);
			state.set(next);
			// A save that overlapped new typing must not clobber the newer draft.
			if (draftRevision === draftRevisionAtStart)
				addressDraft.set(
					savedDraft.some((address) => !address.baseUrl.trim())
						? savedDraft
						: null,
				);
			error.set(null);
			return savedDraft;
		} catch (caught) {
			fail(caught);
			return null;
		} finally {
			savingAddresses = false;
			savingAddressDraft.set(false);
		}
	};

	const regenerate = async () => {
		if (busy()) return;
		busy.set("pairing");
		try {
			state.set(await client.remotePairingRegenerate());
			error.set(null);
		} catch (caught) {
			fail(caught);
		} finally {
			busy.set(null);
		}
	};

	const revoke = async (deviceId: string) => {
		if (busy()) return;
		busy.set(deviceId);
		try {
			state.set(await client.remoteDeviceRevoke(deviceId));
			error.set(null);
		} catch (caught) {
			fail(caught);
		} finally {
			busy.set(null);
		}
	};

	const rename = async (deviceId: string, name: string) => {
		try {
			state.set(await client.remoteDeviceRename(deviceId, name));
			error.set(null);
		} catch (caught) {
			fail(caught);
		}
	};

	const copyToClipboard = async (value: string | null | undefined) => {
		if (!value) return;
		try {
			await Clipboard.writeText(value);
			showToast(toasts, {
				variant: "success",
				title: t("settings.remoteLinkCopied"),
			});
		} catch (caught) {
			showToast(toasts, {
				variant: "error",
				title: t("settings.remoteCopyFailed"),
				description: userErrorMessage(caught),
			});
		}
	};

	const addLanAddress = (baseUrl: string) => {
		const current = state();
		if (busy() || savingAddresses || !current) return;
		const draft = addressDraft() ?? addresses();
		const host = new URL(baseUrl).hostname.replaceAll(".", "-");
		const id = `lan-${host}-${randomId().replaceAll("-", "")}`;
		const empty = draft.find((item) => !item.baseUrl.trim());
		const next = empty
			? draft.map((item) =>
					item.id === empty.id ? { ...item, id, baseUrl } : item,
				)
			: [...draft, { id, name: "", baseUrl }];
		draftRevision += 1;
		addressDraft.set(next);
		void saveAddresses(next);
	};

	const removeAddress = (id: string) => {
		const next = (addressDraft() ?? addresses()).filter(
			(item) => item.id !== id,
		);
		addressInputs.delete(id);
		draftRevision += 1;
		addressDraft.set(next);
		void saveAddresses(next);
	};

	const onAddressSubmit = async () => {
		const draftRevisionAtStart = draftRevision;
		const saved = await saveAddresses();
		if (!saved || draftRevision !== draftRevisionAtStart) return;
		const empty = saved.find((item) => !item.baseUrl.trim());
		let focusId: string | null = null;
		if (empty) {
			focusId = empty.id;
			addressDraft.set([...saved]);
		} else if (saved.length < MAX_ADDRESSES) {
			focusId = randomId();
			addressDraft.set([...saved, { id: focusId, name: "", baseUrl: "" }]);
		}
		// The next (or new) row takes the focus once it is mounted, as React's.
		if (focusId) {
			const id = focusId;
			setTimeout(() => addressInputs.get(id)?.focus(), 0);
		}
	};

	const current = () => state() as RemoteHostState;

	return (
		<View class="gap-3">
			<SettingsSection>
				{() =>
					!loaded() ? (
						<SettingsRow label={t("settings.remoteWebUi")}>
							<View class="flex-row items-center gap-2">
								<Spinner class="size-3.5" />
								<Text class="font-sans text-xs text-muted-foreground">
									{t("settings.remoteLoading")}
								</Text>
							</View>
						</SettingsRow>
					) : (
						<>
							<SettingsRow
								label={t("settings.remoteWebUi")}
								helper={t("settings.remoteDescription")}
							>
								<View class="flex-row flex-wrap items-center gap-x-3 gap-y-2">
									<View class="flex-row items-center gap-1.5">
										<Text class="font-sans text-[10px] text-muted-foreground">
											{t("settings.remotePort")}
										</Text>
										<Input
											testID="remote-port-input"
											size="sm"
											class="w-18 text-right font-mono text-xs"
											value={portDraft() ?? String(current().port)}
											disabled={busy() === "port"}
											accessibilityLabel={t("settings.remotePort")}
											onChange={(event) => portDraft.set(event.value)}
											onBlur={() => void savePort()}
											onSubmit={() => void savePort()}
										/>
									</View>
									<View class="flex-row items-center gap-2">
										<SettingsStatus muted={!current().running}>
											{() =>
												current().running
													? t("settings.remoteRunning")
													: current().enabled
														? t("settings.remoteNotRunning")
														: t("settings.remoteStopped")
											}
										</SettingsStatus>
										<Switch
											testID="remote-enabled-switch"
											checked={current().enabled}
											disabled={busy() === "toggle"}
											accessibilityLabel={t("settings.remoteWebUi")}
											onChange={(event) => void toggle(event.checked)}
										/>
									</View>
								</View>
							</SettingsRow>
							{() =>
								error() ||
								current().lastError ||
								current().addressConfigError ? (
									<SettingsRow
										label={t("settings.remoteError")}
										helper={
											error() ??
											current().lastError ??
											current().addressConfigError ??
											undefined
										}
										ghostEdge="both"
									>
										<SettingsActionButton onPress={() => void toggle(true)}>
											<Icon name="RefreshCw" size={14} />
											<Text class="font-sans text-xs">{t("common.retry")}</Text>
										</SettingsActionButton>
									</SettingsRow>
								) : null
							}
						</>
					)
				}
			</SettingsSection>
			{() =>
				loaded() ? (
					<>
						{/* gap kept on the fragment's sections, not this wrapper */}

						<SettingsSection
							title={t("settings.remoteAccessAddress")}
							actions={
								<RemoteLanAddressPicker
									client={client}
									port={current().port}
									addresses={addressDraft() ?? addresses()}
									disabled={
										Boolean(busy()) ||
										savingAddressDraft() ||
										(addressDraft() ?? addresses()).filter((item) =>
											item.baseUrl.trim(),
										).length >= MAX_ADDRESSES
									}
									onAdd={addLanAddress}
								/>
							}
						>
							<View class="gap-2 px-3 py-3">
								<Each
									of={addressDraft() ?? addresses()}
									key={(address) => address.id}
								>
									{(address, index) => (
										<View class="flex-row items-center gap-2">
											<Input
												testID={`remote-address:${index()}:input`}
												size="sm"
												ref={(ref) => addressInputs.set(address().id, ref)}
												class="min-w-0 flex-1 font-mono text-xs"
												value={address().baseUrl}
												placeholder="https://example.com"
												disabled={Boolean(busy())}
												accessibilityLabel={`${t("settings.remoteAddressUrl")} ${index() + 1}`}
												onChange={(event) => {
													draftRevision += 1;
													addressDraft.set(
														(addressDraft() ?? addresses()).map((item) =>
															item.id === address().id
																? { ...item, baseUrl: event.value }
																: item,
														),
													);
												}}
												onBlur={() => void saveAddresses()}
												onSubmit={() => void onAddressSubmit()}
											/>
											<SettingsIconButton
												testID={`remote-address:${index()}:copy`}
												disabled={
													!current().addresses.some(
														(item) => item.baseUrl === address().baseUrl,
													)
												}
												accessibilityLabel={`${t("settings.remoteCopyLink")} ${address().baseUrl}`}
												onPress={() => void copyToClipboard(address().baseUrl)}
											>
												<Icon name="Copy" size={16} />
											</SettingsIconButton>
											<SettingsIconButton
												testID={`remote-address:${index()}:remove`}
												destructive
												disabled={
													Boolean(busy()) ||
													(addressDraft() ?? addresses()).length <= 1
												}
												accessibilityLabel={`${t("common.remove")} ${address().baseUrl || index() + 1}`}
												onPress={() => removeAddress(address().id)}
											>
												<Icon name="Trash2" size={16} />
											</SettingsIconButton>
										</View>
									)}
								</Each>
								<Text class="font-sans text-xs leading-5 text-muted-foreground">
									{t("settings.remoteAddressConfigHint")}
								</Text>
							</View>
						</SettingsSection>

						{() =>
							pairingVisible() ? (
								<RemotePairingSection
									hasLink={hasPairingLink}
									url={() => current().pairingUrl}
									regenerating={() => busy() === "pairing"}
									onCopy={() => void copyToClipboard(current().pairingUrl)}
									onRegenerate={() => void regenerate()}
								/>
							) : null
						}

						<RemoteDevicesSection
							devices={activeDevices}
							showEmptyHint={() => pairingVisible() && hasPairingLink()}
							isRevoking={(deviceId) => busy() === deviceId}
							onRename={(deviceId, name) => void rename(deviceId, name)}
							onRevoke={(deviceId) => void revoke(deviceId)}
						/>
					</>
				) : null
			}
		</View>
	);
}

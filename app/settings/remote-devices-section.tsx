import { type Accessor, computed, signal, Text, View } from "nsh";

import type { RemoteDevice, RemoteScopes } from "@shared/api/remote-types";
import { appLocale, t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { textTooltip } from "../ui/tooltip";
import {
	SettingsActionButton,
	SettingsIconButton,
	SettingsRow,
	SettingsSection,
} from "./layout";
import { RemoteScopeSelect } from "./remote-scope-select";

/** A device name that turns into a rename field (double-click / pencil / Enter). */
function DeviceNameCell(props: {
	device: () => RemoteDevice;
	onRename: (name: string) => void;
}) {
	const editing = signal(false);
	const draft = signal(props.device().name);
	const commit = () => {
		const next = draft().trim();
		editing.set(false);
		if (next && next !== props.device().name) props.onRename(next);
	};
	const startEditing = () => {
		draft.set(props.device().name);
		editing.set(true);
	};
	return (
		<View class="flex-row items-center gap-1.5">
			{() =>
				editing() ? (
					<Input
						testID={`remote-device:${props.device().id}:rename-input`}
						size="sm"
						class="h-7 w-full text-sm"
						autoFocus
						value={draft()}
						accessibilityLabel={t("settings.remoteRename")}
						onChange={(event) => draft.set(event.value)}
						onBlur={commit}
						onSubmit={commit}
						onKeyDown={(event) => {
							if (event.key === "Escape") editing.set(false);
						}}
					/>
				) : (
					<>
						<Button
							variant="ghost"
							class="h-auto px-0 text-left font-medium leading-tight text-foreground"
							tooltip={textTooltip(t("settings.remoteRenameHint"))}
							onPress={startEditing}
						>
							<Text class="font-sans font-medium leading-tight text-foreground">
								{() => props.device().name}
								{() =>
									props.device().pairIp ? (
										<Text class="ml-2 font-mono text-[10px] font-normal text-muted-foreground">
											{` ${props.device().pairIp}`}
										</Text>
									) : null
								}
							</Text>
						</Button>
						<SettingsIconButton
							class="size-5"
							accessibilityLabel={t("settings.remoteRename")}
							tooltip={t("settings.remoteRenameHint")}
							onPress={startEditing}
						>
							<Icon name="Pencil" size={12} />
						</SettingsIconButton>
					</>
				)
			}
		</View>
	);
}

export function RemoteDevicesSection(props: {
	devices: Accessor<RemoteDevice[]>;
	showEmptyHint: Accessor<boolean>;
	isRevoking: (deviceId: string) => boolean;
	busy: Accessor<boolean>;
	canRevokeAll: Accessor<boolean>;
	onRename: (deviceId: string, name: string) => void;
	onRevoke: (deviceId: string) => void;
	onRevokeAll: () => void;
	onSetScopes: (deviceId: string, scopes: RemoteScopes) => void;
}) {
	const hasDevices = computed(() => props.devices().length > 0);
	const confirmingId = signal<string | null>(null);
	return (
		<SettingsSection
			title={t("settings.remoteDevices")}
			headerRight={
				<Text class="font-sans text-[11px] text-muted-foreground">
					{() =>
						t("settings.remoteDeviceCount", {
							count: props.devices().length,
						})
					}
				</Text>
			}
		>
			{() =>
				hasDevices() ? (
					<Each of={props.devices()} key={(device) => device.id}>
						{(device) => {
							const isConfirming = () => confirmingId() === device().id;
							return (
								<SettingsRow
									ghostEdge="both"
									helper={t("settings.remoteDeviceLastSeen", {
										date: new Date(device().lastSeenAtMs).toLocaleString(
											appLocale(),
										),
									})}
									label={
										<DeviceNameCell
											device={device}
											onRename={(name) => props.onRename(device().id, name)}
										/>
									}
								>
									<View class="flex-row flex-wrap items-center gap-1.5">
										<RemoteScopeSelect
											testID={`remote-device:${device().id}:scopes`}
											label={t("settings.remoteDevicePermissions")}
											value={device().scopes}
											disabled={props.busy()}
											onChange={(scopes) =>
												props.onSetScopes(device().id, scopes)
											}
										/>
										{() =>
											isConfirming() ? (
												<SettingsActionButton
													testID={`remote-device:${device().id}:revoke-cancel`}
													disabled={props.isRevoking(device().id)}
													onPress={() => confirmingId.set(null)}
												>
													<Text class="font-sans text-xs">
														{t("common.cancel")}
													</Text>
												</SettingsActionButton>
											) : null
										}
										<SettingsActionButton
											testID={`remote-device:${device().id}:revoke`}
											class={
												isConfirming()
													? "border-destructive/40 bg-destructive/10 text-destructive"
													: undefined
											}
											disabled={props.busy()}
											onPress={() => {
												if (!isConfirming()) {
													confirmingId.set(device().id);
													return;
												}
												confirmingId.set(null);
												props.onRevoke(device().id);
											}}
										>
											{() =>
												props.isRevoking(device().id) ? (
													<Spinner class="size-3.5" />
												) : (
													<Icon name="Trash2" size={14} />
												)
											}
											<Text class="font-sans text-xs">
												{() =>
													isConfirming()
														? t("settings.remoteRevokeConfirm")
														: t("settings.remoteRevoke")
												}
											</Text>
										</SettingsActionButton>
									</View>
								</SettingsRow>
							);
						}}
					</Each>
				) : (
					<SettingsRow
						label={t("settings.remoteNoDevices")}
						helper={
							props.showEmptyHint()
								? t("settings.remoteNoDevicesDescription")
								: undefined
						}
					/>
				)
			}
			{() =>
				props.canRevokeAll() ? (
					<SettingsRow label="">
						<SettingsActionButton
							testID="remote-devices-revoke-all"
							class="border-destructive/40 text-destructive"
							disabled={props.busy()}
							onPress={props.onRevokeAll}
						>
							<Icon name="Trash2" size={14} />
							<Text class="font-sans text-xs">
								{t("settings.remoteRevokeAll")}
							</Text>
						</SettingsActionButton>
					</SettingsRow>
				) : null
			}
		</SettingsSection>
	);
}

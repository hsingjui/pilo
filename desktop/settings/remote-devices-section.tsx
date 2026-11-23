import { type Accessor, computed, signal, Text, View } from "nsh";

import type { RemoteDevice } from "@shared/api/remote-types";
import { t } from "../app/i18n";
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
	onRename: (deviceId: string, name: string) => void;
	onRevoke: (deviceId: string) => void;
}) {
	const hasDevices = computed(() => props.devices().length > 0);
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
						{(device) => (
							<SettingsRow
								ghostEdge="both"
								label={
									<DeviceNameCell
										device={device}
										onRename={(name) => props.onRename(device().id, name)}
									/>
								}
							>
								<SettingsActionButton
									testID={`remote-device:${device().id}:revoke`}
									disabled={props.isRevoking(device().id)}
									onPress={() => props.onRevoke(device().id)}
								>
									{() =>
										props.isRevoking(device().id) ? (
											<Spinner class="size-3.5" />
										) : (
											<Icon name="Trash2" size={14} />
										)
									}
									<Text class="font-sans text-xs">
										{t("settings.remoteRevoke")}
									</Text>
								</SettingsActionButton>
							</SettingsRow>
						)}
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
		</SettingsSection>
	);
}

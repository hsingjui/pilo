import { type Accessor, computed, signal, Text, View } from "nsh";

import type { RemoteDevice } from "@shared/api/remote-types";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import {
	SETTINGS_TEXT_BUTTON_CLASS,
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
							tooltip={t("settings.remoteRenameHint")}
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
						<Button
							variant="ghost"
							size="icon"
							class="size-5 text-muted-foreground hover:text-foreground"
							accessibilityLabel={t("settings.remoteRename")}
							tooltip={t("settings.remoteRenameHint")}
							onPress={startEditing}
						>
							<Icon name="Pencil" size={12} />
						</Button>
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
							<View class="gap-2 px-3 py-2 border-b border-border/60 last:border-b-0">
								<View class="flex-row items-center gap-4">
									<View class="min-w-0 flex-1">
										<DeviceNameCell
											device={device}
											onRename={(name) => props.onRename(device().id, name)}
										/>
									</View>
									<View class="min-w-0 shrink-0 justify-end pl-4">
										<Button
											variant="ghost"
											class={SETTINGS_TEXT_BUTTON_CLASS}
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
										</Button>
									</View>
								</View>
							</View>
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

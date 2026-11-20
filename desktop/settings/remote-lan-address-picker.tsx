import { signal, Text, View } from "nsh";
import type { RemoteAccessAddress } from "@/lib/api/remote-types";
import { userErrorMessage } from "@/lib/app-error";
import { remoteAddressConfig } from "@/lib/remote-addresses";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { Spinner } from "../ui/spinner";
import type { SettingsClient } from "./settings-dialog";

/**
 * The "+" menu beside the access-address rows: lists the host's LAN IPs as
 * ready-made `http://<ip>:<port>` addresses, dimming the ones already saved.
 * Mirrors `remote-lan-address-picker.tsx` in the Tauri app.
 */
export function RemoteLanAddressPicker(props: {
	client: SettingsClient;
	port: number;
	addresses: RemoteAccessAddress[];
	disabled?: boolean;
	onAdd: (baseUrl: string) => void;
}) {
	type LoadState =
		| { status: "loading" }
		| { status: "ready"; ips: string[] }
		| { status: "error"; message: string };
	const result = signal<LoadState>({ status: "loading" });

	const load = async () => {
		result.set({ status: "loading" });
		try {
			result.set({
				status: "ready",
				ips: await props.client.remoteLanAddresses(),
			});
		} catch (caught) {
			result.set({ status: "error", message: userErrorMessage(caught) });
		}
	};

	return (
		<Menu
			testID="remote-lan-address-picker"
			align="end"
			popupClass="min-w-55"
			onOpen={() => void load()}
			trigger={
				<Button
					variant="ghost"
					size="icon"
					testID="remote-lan-add"
					class="size-11 shrink-0 sm:size-7"
					disabled={props.disabled}
					accessibilityLabel={t("settings.remoteAddLanAddress")}
					tooltip={t("settings.remoteAddLanAddress")}
				>
					<Icon name="Plus" size={14} />
				</Button>
			}
		>
			{() => {
				const state = result();
				const existingOrigins = new Set(
					remoteAddressConfig(props.addresses, "").addresses.map((address) => {
						try {
							return new URL(address.baseUrl).origin;
						} catch {
							return null;
						}
					}),
				);
				if (state.status === "loading")
					return (
						<MenuItem disabled>
							<View class="flex-row items-center gap-2">
								<Spinner class="size-3.5" />
								<Text class="text-xs text-muted-foreground">
									{t("common.loading")}
								</Text>
							</View>
						</MenuItem>
					);
				if (state.status === "error")
					return (
						<>
							<View class="px-3 py-2" testID="remote-lan-address-error">
								<Text class="text-xs text-muted-foreground">
									{t("settings.remoteLanAddressLoadFailed")}
								</Text>
							</View>
							<MenuItem
								onSelect={() => {
									void load();
								}}
							>
								{t("common.retry")}
							</MenuItem>
						</>
					);
				if (state.ips.length === 0)
					return (
						<View class="px-3 py-2" testID="remote-lan-address-empty">
							<Text class="text-xs text-muted-foreground">
								{t("settings.remoteLanAddressEmpty")}
							</Text>
						</View>
					);
				return state.ips.map((ip) => {
					const baseUrl = new URL(`http://${ip}:${props.port}`).origin;
					const added = existingOrigins.has(baseUrl);
					return (
						<MenuItem
							testID={`remote-lan:${ip}`}
							class="min-h-11 sm:min-h-8"
							disabled={props.disabled || added}
							onSelect={() => props.onAdd(baseUrl)}
						>
							<View class="min-w-0 flex-1 flex-row items-center gap-3">
								<Text class="min-w-0 flex-1 truncate font-mono text-xs">
									{baseUrl}
								</Text>
								{added ? (
									<Text class="shrink-0 text-[10px] text-muted-foreground">
										{t("common.added")}
									</Text>
								) : null}
							</View>
						</MenuItem>
					);
				});
			}}
		</Menu>
	);
}

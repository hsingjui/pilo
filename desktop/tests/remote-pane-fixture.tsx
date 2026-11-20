import { mount, Scroll, View } from "nsh";

import type { RemoteHostState } from "@/lib/api/remote-types";
import "../app/fonts";
import { AppToaster, AppToasts, AppToastStack } from "../app/app-toasts";
import { initializeI18n } from "../app/i18n";
import { RemotePane } from "../settings/remote-pane";
import { scriptedClient } from "./scripted-app-client";

/**
 * The remote settings pane alone over a scripted client whose Remote Host is
 * enabled and running: two access addresses, a live pairing link and two
 * paired devices.
 */
const remoteHost: RemoteHostState = {
	enabled: true,
	running: true,
	port: 48_001,
	baseUrl: "http://192.168.1.5:48001",
	publicBaseUrl: "",
	addresses: [
		{ id: "lan", name: "", baseUrl: "http://192.168.1.5:48001" },
		{ id: "tail", name: "", baseUrl: "https://pilo.tailscale.example.com" },
	],
	entryAddressId: "lan",
	addressConfigError: null,
	pairingRemainingUses: 3,
	pairingTotalUses: 5,
	pairingUrl: "http://192.168.1.5:48001/pair?code=PAIR-CODE",
	pairingExpiresAtMs: Date.now() + 600_000,
	lastError: null,
	devices: [
		{
			id: "dev-iphone",
			name: "Jui's iPhone",
			pairIp: "192.168.1.20",
			createdAtMs: 1,
			lastSeenAtMs: 2,
			expiresAtMs: 9,
			revokedAtMs: null,
		},
		{
			id: "dev-ipad",
			name: "iPad",
			pairIp: "192.168.1.21",
			createdAtMs: 1,
			lastSeenAtMs: 2,
			expiresAtMs: 9,
			revokedAtMs: null,
		},
	],
};

const runtime = scriptedClient({
	remoteHost,
	remoteLanIps: ["192.168.1.5", "10.0.0.8"],
});

function run() {
	mount(() => {
		const toasts = new AppToasts();
		return (
			<AppToaster.Provider value={toasts}>
				<Scroll class="flex-1 bg-background">
					<View class="p-3">
						<RemotePane client={runtime.client} />
					</View>
				</Scroll>
				<AppToastStack toasts={toasts} />
			</AppToaster.Provider>
		);
	});
}

initializeI18n();
void run();

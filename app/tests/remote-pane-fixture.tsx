import { mount, Scroll, Storage, View } from "nsh";

import type { RemoteHostState, RemoteScopes } from "@shared/api/remote-types";
import { AppToaster, AppToasts, AppToastStack } from "../shell/app-toasts";
import { initializeI18n } from "../shell/i18n";
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
	pairingScopes: "chat",
	pairingUrl: "http://192.168.1.5:48001/pair?code=PAIR-CODE",
	pairingExpiresAtMs: Date.now() + 600_000,
	lastError: null,
	devices: [
		{
			id: "dev-iphone",
			name: "Jui's iPhone",
			pairIp: "192.168.1.20",
			scopes: "chat",
			createdAtMs: 1,
			lastSeenAtMs: 2,
			expiresAtMs: 9,
			revokedAtMs: null,
		},
		{
			id: "dev-ipad",
			name: "iPad",
			pairIp: "192.168.1.21",
			scopes: "chat",
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
const client = {
	...runtime.client,
	async remotePairingRegenerate(scopes: RemoteScopes) {
		const state = await runtime.client.remotePairingRegenerate(scopes);
		await Storage.setItem("pilo.test.pairingScopes", scopes);
		return state;
	},
};

function run() {
	mount(() => {
		const toasts = new AppToasts();
		return (
			<AppToaster.Provider value={toasts}>
				<Scroll class="flex-1 bg-background">
					<View class="p-3">
						<RemotePane client={client} />
					</View>
				</Scroll>
				<AppToastStack toasts={toasts} />
			</AppToaster.Provider>
		);
	});
}

initializeI18n();
void run();

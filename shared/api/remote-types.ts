export type RemoteScopes = "chat" | "chat,workspace";

export type RemoteDevice = {
	id: string;
	name: string;
	displayName?: string;
	pairIp: string;
	scopes: RemoteScopes;
	createdAtMs: number;
	lastSeenAtMs: number;
	expiresAtMs: number;
	revokedAtMs: number | null;
};

export type RemoteAccessAddress = {
	id: string;
	name: string;
	baseUrl: string;
};

export type RemoteHostState = {
	enabled: boolean;
	running: boolean;
	port: number;
	baseUrl: string | null;
	publicBaseUrl: string;
	addresses: RemoteAccessAddress[];
	entryAddressId: string;
	addressConfigError: string | null;
	pairingRemainingUses: number;
	pairingTotalUses: number;
	pairingScopes: RemoteScopes | null;
	pairingUrl: string | null;
	pairingExpiresAtMs: number | null;
	lastError: string | null;
	devices: RemoteDevice[];
};

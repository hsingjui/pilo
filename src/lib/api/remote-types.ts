export type RemoteDevice = {
	id: string;
	name: string;
	pairIp: string;
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
	pairingUrl: string | null;
	pairingExpiresAtMs: number | null;
	lastError: string | null;
	devices: RemoteDevice[];
};

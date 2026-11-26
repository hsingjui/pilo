import type { Connection } from "./pi-runtime-types";

export type ConnectionTestResult = {
	protocolVersion: number;
	serverVersion: string;
};

export type PiExecutableInfo = {
	executable: string;
	version: string;
};

export type ConnectionHealth = {
	reachable: boolean;
	latencyMs: number;
	protocolVersion?: number | null;
	serverVersion?: string | null;
	pi?: PiExecutableInfo | null;
	error?: string | null;
	piError?: string | null;
};

export type WslConnectionInfo = {
	connection: Connection;
	projectCount: number;
};

export type SshConnectionInfo = {
	connection: Connection;
	projectCount: number;
	hasPassword: boolean;
	localPiResources?: boolean;
};

export type SshAgentIdentity = {
	publicKey: string;
	fingerprint: string;
	comment: string;
};

export type SshConfigHost = {
	host: string;
	hostname?: string | null;
	user?: string | null;
	port?: number | null;
};

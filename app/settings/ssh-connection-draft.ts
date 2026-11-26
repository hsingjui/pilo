import type { SshConnectionInfo } from "@shared/api/connections-types";
import type {
	Connection,
	PiRuntime,
	SshAuthMethod,
	SshTarget,
} from "@shared/api/pi-runtime-types";

export const AUTH_LABEL_KEYS: Record<
	SshAuthMethod,
	"connection.sshAgent" | "connection.password" | "connection.privateKey"
> = {
	agent: "connection.sshAgent",
	password: "connection.password",
	key: "connection.privateKey",
};

export function sshTargetLabel(target: SshTarget): string {
	if (target.type === "config_host") return target.host;
	const host =
		target.port && target.port !== 22
			? `${target.hostname}:${target.port}`
			: target.hostname;
	return target.user ? `${target.user}@${host}` : host;
}

export type SshDraft = {
	id: string;
	isNew: boolean;
	name: string;
	mode: "direct" | "config";
	hostname: string;
	port: string;
	user: string;
	authMethod: SshAuthMethod;
	agentPublicKey: string | null;
	identityFile: string;
	password: string;
	proxyJump: string;
	hasPassword: boolean;
	piExecutable: string;
	piRuntime: PiRuntime;
	localPiResources: boolean;
	initialLocalPiResources: boolean;
};

function newConnectionId() {
	return `ssh:${Date.now().toString(36)}${Math.random()
		.toString(36)
		.slice(2, 8)}`;
}

export function emptyDraft(): SshDraft {
	return {
		id: newConnectionId(),
		isNew: true,
		name: "",
		mode: "direct",
		hostname: "",
		port: "22",
		user: "",
		authMethod: "agent",
		agentPublicKey: null,
		identityFile: "",
		password: "",
		proxyJump: "",
		hasPassword: false,
		piExecutable: "",
		piRuntime: "workspace",
		localPiResources: false,
		initialLocalPiResources: false,
	};
}

export function draftFromInfo(info: SshConnectionInfo): SshDraft {
	const target =
		info.connection.kind.type === "ssh" ? info.connection.kind.target : null;
	if (!target) return emptyDraft();
	const auth = target.authMethod;
	const authMethod: SshAuthMethod = typeof auth === "string" ? auth : "agent";
	const agentPublicKey = typeof auth === "string" ? "" : auth.agent_key;
	const localPiResources = info.localPiResources ?? false;
	const base: SshDraft = {
		...emptyDraft(),
		id: info.connection.id,
		isNew: false,
		name: info.connection.name,
		authMethod,
		agentPublicKey,
		hasPassword: info.hasPassword,
		piExecutable: info.connection.piExecutable ?? "",
		piRuntime: info.connection.piRuntime ?? "workspace",
		localPiResources,
		initialLocalPiResources: localPiResources,
	};
	if (target.type === "config_host") {
		return { ...base, mode: "config", hostname: target.host };
	}
	return {
		...base,
		mode: "direct",
		hostname: target.hostname,
		port: target.port ? String(target.port) : "22",
		user: target.user ?? "",
		identityFile: target.identityFile ?? "",
		proxyJump: target.proxyJump ?? "",
	};
}

export function parseSshPort(raw: string): number | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	if (!/^\d+$/.test(trimmed)) return Number.NaN;
	const value = Number(trimmed);
	return Number.isInteger(value) && value >= 1 && value <= 65535
		? value
		: Number.NaN;
}

export function connectionFromDraft(draft: SshDraft): Connection {
	const authMethod =
		draft.authMethod === "agent" && draft.agentPublicKey
			? { agent_key: draft.agentPublicKey }
			: draft.authMethod;
	const parsedPort = parseSshPort(draft.port);
	const target: SshTarget =
		draft.mode === "config"
			? { type: "config_host", host: draft.hostname.trim(), authMethod }
			: {
					type: "direct",
					hostname: draft.hostname.trim(),
					port:
						parsedPort !== null && Number.isFinite(parsedPort)
							? parsedPort
							: null,
					user: draft.user.trim() || null,
					identityFile:
						draft.authMethod === "key"
							? draft.identityFile.trim() || null
							: null,
					authMethod,
					proxyJump: draft.proxyJump.trim() || null,
				};
	return {
		id: draft.id,
		name: draft.name.trim(),
		piExecutable: draft.piExecutable.trim() || null,
		piRuntime: draft.piRuntime,
		kind: { type: "ssh", target },
	};
}

/** The "name + Pi path" editor shared by local, WSL and SSH connections. */
export type ConfigureDraft = {
	connection: Connection;
	name: string;
	piExecutable: string;
};

export type SshFieldError = {
	field: "identityFile" | "password" | "port";
	message: string;
};

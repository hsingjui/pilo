import type {
	Connection,
	PiRuntime,
	SshAuthMethod,
	SshTarget,
} from "@/lib/api/pi-runtime";
import { randomId } from "@/lib/utils";
import type { SshConnectionInfo } from "@/lib/api/ssh-connections";

export const AUTH_LABEL_KEYS: Record<
	SshAuthMethod,
	"connection.sshAgent" | "connection.password" | "connection.privateKey"
> = {
	agent: "connection.sshAgent",
	password: "connection.password",
	key: "connection.privateKey",
};

export type SshConnectionFormState = {
	id: string;
	name: string;
	mode: "direct" | "config";
	hostname: string;
	port: string;
	user: string;
	authMethod: SshAuthMethod;
	identityFile: string;
	// null allows a new connection to auto-select the only available key.
	agentPublicKey: string | null;
	password: string;
	proxyJump: string;
	hasPassword: boolean;
	piExecutable: string;
	piRuntime: PiRuntime;
};

export function emptySshConnectionForm(): SshConnectionFormState {
	return {
		id: `ssh:${randomId()}`,
		name: "",
		mode: "direct",
		hostname: "",
		port: "22",
		user: "",
		authMethod: "agent",
		identityFile: "",
		agentPublicKey: null,
		password: "",
		proxyJump: "",
		hasPassword: false,
		piExecutable: "",
		piRuntime: "workspace",
	};
}

export function sshConnectionFormFromInfo(
	info: SshConnectionInfo,
): SshConnectionFormState {
	const target =
		info.connection.kind.type === "ssh" ? info.connection.kind.target : null;
	if (!target) return emptySshConnectionForm();
	const auth = target.authMethod;
	const authMethod = typeof auth === "string" ? auth : "agent";
	const agentPublicKey = typeof auth === "string" ? "" : auth.agent_key;
	if (target.type === "config_host") {
		return {
			...emptySshConnectionForm(),
			id: info.connection.id,
			name: info.connection.name,
			mode: "config",
			hostname: target.host,
			authMethod,
			agentPublicKey,
			hasPassword: info.hasPassword,
			piExecutable: info.connection.piExecutable ?? "",
			piRuntime: info.connection.piRuntime ?? "workspace",
		};
	}
	return {
		...emptySshConnectionForm(),
		id: info.connection.id,
		name: info.connection.name,
		mode: "direct",
		hostname: target.hostname,
		port: target.port ? String(target.port) : "22",
		user: target.user ?? "",
		authMethod,
		agentPublicKey,
		identityFile: target.identityFile ?? "",
		proxyJump: target.proxyJump ?? "",
		hasPassword: info.hasPassword,
		piExecutable: info.connection.piExecutable ?? "",
		piRuntime: info.connection.piRuntime ?? "workspace",
	};
}

export function connectionFromSshForm(
	form: SshConnectionFormState,
): Connection {
	const authMethod =
		form.authMethod === "agent" && form.agentPublicKey
			? { agent_key: form.agentPublicKey }
			: form.authMethod;
	let target: SshTarget;
	if (form.mode === "config") {
		target = {
			type: "config_host",
			host: form.hostname.trim(),
			authMethod,
		};
	} else {
		target = {
			type: "direct",
			hostname: form.hostname.trim(),
			port: form.port.trim() ? Number(form.port) : null,
			user: form.user.trim() || null,
			identityFile:
				form.authMethod === "key" ? form.identityFile.trim() || null : null,
			authMethod,
			proxyJump: form.proxyJump.trim() || null,
		};
	}
	return {
		id: form.id,
		name: form.name.trim(),
		piExecutable: form.piExecutable.trim() || null,
		piRuntime: form.piRuntime,
		kind: { type: "ssh", target },
	};
}

export function sshTargetLabel(target: SshTarget) {
	if (target.type === "config_host") return target.host;
	const host =
		target.port && target.port !== 22
			? `${target.hostname}:${target.port}`
			: target.hostname;
	return target.user ? `${target.user}@${host}` : host;
}

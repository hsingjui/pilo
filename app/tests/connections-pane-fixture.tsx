import { mount, Scroll, View } from "nsh";

import type { Connection } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import "../shell/fonts";
import { initializeI18n } from "../shell/i18n";
import { conversationContext } from "../shell/open-chat";
import { ConnectionsPane } from "../settings/connections-pane";
import { AppStore } from "../state/app-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { scriptedClient } from "./scripted-app-client";

/**
 * The connections settings pane alone over a scripted client with one SSH
 * connection (agent auth, a linked project), one WSL connection, two
 * distributions and one SSH agent identity.
 */
const sshConnection: Connection = {
	id: "ssh:prod",
	name: "prod-server",
	kind: {
		type: "ssh",
		target: {
			type: "direct",
			hostname: "prod.example.com",
			port: 2222,
			user: "deploy",
			identityFile: null,
			authMethod: "agent",
			proxyJump: "ops@jump.example.com:22",
		},
	},
	piRuntime: "workspace",
	shownInHome: true,
};

const sshProject = {
	id: "pilo",
	name: "pilo",
	path: "/code/pilo",
	connection: sshConnection,
} as Project;

async function run() {
	const runtime = scriptedClient({
		projects: [sshProject],
		localConnection: {
			id: "local",
			name: "Local",
			kind: { type: "local" },
			piExecutable: "pi",
			piRuntime: "workspace",
			shownInHome: true,
		},
		sshConnections: [
			{
				connection: sshConnection,
				projectCount: 1,
				hasPassword: false,
				localPiResources: false,
			},
			{
				connection: {
					id: "ssh:vault",
					name: "vault",
					kind: {
						type: "ssh",
						target: {
							type: "config_host",
							host: "vault-alias",
							authMethod: "password",
						},
					},
					piRuntime: "local",
					shownInHome: false,
				},
				projectCount: 0,
				hasPassword: true,
				localPiResources: true,
			},
		],
		wslConnections: [
			{
				connection: {
					id: "wsl:Ubuntu",
					name: "WSL · Ubuntu",
					kind: { type: "wsl", distro: "Ubuntu" },
					piRuntime: "workspace",
					shownInHome: true,
				},
				projectCount: 0,
			},
		],
		wslDistributions: [{ name: "Ubuntu" }, { name: "Debian" }],
		sshAgentIdentities: [
			{
				publicKey: "ssh-ed25519 AAAA test",
				fingerprint: "SHA256:abc123",
				comment: "jui@mac",
			},
		],
		sshPasswords: { "ssh:vault": "hunter2" },
	});
	const chat = new ChatTranscriptStore(runtime.client, conversationContext());
	const store = new AppStore(runtime.client, chat);
	mount(() => (
		<Scroll class="flex-1 bg-background">
			<View class="p-3">
				<ConnectionsPane state={store.state} client={runtime.client} />
			</View>
		</Scroll>
	));
	await store.start();
}

initializeI18n();
void run();

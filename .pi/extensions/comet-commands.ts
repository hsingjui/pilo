import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const commands = [
	"comet",
	"comet-review",
	"comet-any",
	"comet-native",
	"comet-memory",
] as const;

export default function registerCometCommands(pi: ExtensionAPI) {
	for (const name of commands) {
		pi.registerCommand(name, {
			description: `Comet: /${name}`,
			handler: async (args) => {
				pi.sendUserMessage(args ? `/skill:${name} ${args}` : `/skill:${name}`);
			},
		});
	}
}

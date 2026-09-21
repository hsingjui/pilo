import type { PiCommand } from "@/lib/pi-runtime";
import type { ComposerSuggestion } from "@/components/chat/chat-composer-suggestions";

export type PiCommandSuggestion = ComposerSuggestion & {
	kind: "command";
	value: string;
	label: string;
	detail?: string;
	skill?: boolean;
};

// pi 内置 llama.cpp 扩展注册的 /llama，仅 TUI 模式可用（RPC 下直接 return），不透出。
const RESERVED_NATIVE_COMMANDS = new Set(["new", "compact", "llama"]);

function commandDetail(command: PiCommand) {
	return (
		command.description ||
		[command.source, command.sourceInfo.scope].filter(Boolean).join(" · ")
	);
}

function availablePiCommands(commands: readonly PiCommand[]) {
	return commands.filter(
		(command) => !RESERVED_NATIVE_COMMANDS.has(command.name),
	);
}

export function createPiCommandSuggestions(
	commands: readonly PiCommand[],
): PiCommandSuggestion[] {
	return availablePiCommands(commands).map((command) => ({
		kind: "command",
		value: `/${command.name}`,
		label: `/${command.name}`,
		detail: commandDetail(command),
		skill: command.source === "skill",
	}));
}

export function createPiExtensionCommandNames(commands: readonly PiCommand[]) {
	return new Set(
		availablePiCommands(commands)
			.filter((command) => command.source === "extension")
			.map((command) => command.name),
	);
}

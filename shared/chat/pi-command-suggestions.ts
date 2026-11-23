import type { PiCommand } from "../api/pi-runtime-types.ts";
import { PI_MODEL_CATALOG_COMMAND } from "../pi-model-catalog-extension.ts";
import type { ComposerSuggestion } from "./composer-suggestions.ts";

export type PiCommandSuggestion = ComposerSuggestion & {
	kind: "command";
	value: string;
	label: string;
	detail?: string;
	skill?: boolean;
};

export type ParsedSlashCommand = {
	name: string;
	args: string;
	raw: string;
};

const MODEL_CATALOG_COMMAND_NAME = PI_MODEL_CATALOG_COMMAND.replace(/^\//, "");

// pi 内置 llama.cpp 扩展注册的 /llama，仅 TUI 模式可用（RPC 下直接 return），不透出。
// /new、/compact 由 Pilo 白名单命令直接提供，这里去重；探针内部命令同样不透出。
const RESERVED_NATIVE_COMMANDS = new Set([
	"new",
	"compact",
	"llama",
	MODEL_CATALOG_COMMAND_NAME,
]);

function commandDetail(command: PiCommand) {
	return (
		command.description ||
		[command.source, command.sourceInfo?.scope].filter(Boolean).join(" · ")
	);
}

function availablePiCommands(commands: readonly PiCommand[]) {
	return commands.filter(
		(command) => !RESERVED_NATIVE_COMMANDS.has(command.name),
	);
}

/**
 * 按命令名去重合并多个来源的 Pi 命令（例如项目缓存 + 运行中会话实时命令）。
 * 靠后的来源覆盖同名项，同时保持首次出现的顺序。
 */
export function mergePiCommands(
	...sources: readonly (readonly PiCommand[] | null | undefined)[]
): PiCommand[] {
	const merged = new Map<string, PiCommand>();
	for (const source of sources) {
		if (!source) continue;
		for (const command of source) {
			if (!command?.name) continue;
			merged.set(command.name, command);
		}
	}
	return [...merged.values()];
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

/**
 * 解析输入开头的斜杠命令（`/name [args]`）；非斜杠开头或裸 `/` 返回 null。
 */
export function parseSlashCommand(text: string): ParsedSlashCommand | null {
	if (!text.startsWith("/")) return null;
	const raw = text.trim();
	const name = raw.slice(1).split(/\s+/, 1)[0] ?? "";
	if (!name) return null;
	const args = raw.slice(1 + name.length).trim();
	return { name, args, raw };
}

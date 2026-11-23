import { fileBasename } from "./chat/chat-tool-result.ts";

export type WorkspaceFileIconKind =
	| "text"
	| "json"
	| "config"
	| "terminal"
	| "style"
	| "file"
	| "code";

/** Classifies a workspace file path into a shared icon category for Desktop and WebUI tabs. */
export function workspaceFileIconKind(path: string): WorkspaceFileIconKind {
	const name = fileBasename(path).toLowerCase();
	if (
		/\.(?:md|markdown|txt|log)$/.test(name) ||
		/^(?:readme|license)$/.test(name)
	) {
		return "text";
	}
	if (/\.(?:json|jsonc|json5)$/.test(name)) return "json";
	if (
		/\.(?:ya?ml|toml|ini|conf|cfg)$/.test(name) ||
		/^\.env(?:\.|$)/.test(name) ||
		/^(?:\.gitignore|\.dockerignore)$/.test(name)
	) {
		return "config";
	}
	if (
		/\.(?:sh|bash|zsh|fish|ps1|psm1|bat|cmd)$/.test(name) ||
		/^(?:dockerfile|makefile)$/.test(name)
	) {
		return "terminal";
	}
	if (/\.(?:css|scss|sass|less)$/.test(name)) return "style";
	if (!name.includes(".")) return "file";
	return "code";
}

export interface AuxTabCapacityOptions {
	/** Fallback capacity before the tab container has been measured. */
	defaultVisible?: number;
	/** Width budget reserved for the chat title tab when visible. */
	chatWidth?: number;
	/** Width budget reserved for the divider + overflow button + drag breathing room. */
	reserveWidth?: number;
	/** Approximate width budget per auxiliary tab (Git, file, terminal). */
	tabWidth?: number;
	minVisible?: number;
	maxVisible?: number;
}

/**
 * Estimates how many auxiliary tabs (Git, files, terminals) fit cleanly in the
 * single-row title bar while leaving breathing room for the chat title and window drag.
 */
export function computeMaxVisibleAuxTabs(
	containerWidth: number,
	hasChatTitle: boolean,
	options: AuxTabCapacityOptions = {},
): number {
	const {
		defaultVisible = 4,
		chatWidth = 176,
		reserveWidth = 88,
		tabWidth = 132,
		minVisible = 1,
		maxVisible = 8,
	} = options;
	if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
		return defaultVisible;
	}
	const available =
		containerWidth - (hasChatTitle ? chatWidth : 0) - reserveWidth;
	const count = Math.floor(available / tabWidth);
	return Math.max(minVisible, Math.min(maxVisible, count));
}

export interface PartitionedHeaderTabs<T extends { id: string }> {
	visible: T[];
	overflow: T[];
}

/**
 * Splits auxiliary header tabs into directly visible tabs and an overflow list.
 * If the currently active tab would fall into overflow, it swaps into the last
 * visible slot so the active view stays directly visible and closeable.
 */
export function partitionHeaderTabs<T extends { id: string }>(
	items: readonly T[],
	activeId: string | null,
	maxVisible: number,
): PartitionedHeaderTabs<T> {
	const limit = Math.max(1, Math.floor(maxVisible));
	if (items.length <= limit) {
		return { visible: [...items], overflow: [] };
	}
	const visible = items.slice(0, limit);
	const overflow = items.slice(limit);
	if (activeId !== null) {
		const overflowIndex = overflow.findIndex((item) => item.id === activeId);
		if (overflowIndex >= 0) {
			const [activeItem] = overflow.splice(overflowIndex, 1);
			const displaced = visible[visible.length - 1];
			if (activeItem && displaced) {
				visible[visible.length - 1] = activeItem;
				overflow.unshift(displaced);
			}
		}
	}
	return { visible, overflow };
}

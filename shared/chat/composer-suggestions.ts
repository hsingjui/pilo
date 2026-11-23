import type { t as translate } from "../i18n/translate.ts";

export type ComposerSuggestionKind = "file" | "session" | "command";

export type ComposerSuggestion = {
	kind: ComposerSuggestionKind;
	value: string;
	label: string;
	detail?: string;
	/** 标记 /skill:<name> 命令，菜单中用独立图标区分。 */
	skill?: boolean;
};

export type SuggestionTrigger = "@" | "/";

export type ActiveSuggestionQuery = {
	trigger: SuggestionTrigger;
	query: string;
	start: number;
	end: number;
};

export type MentionTab = "file" | "session";

export const DEFAULT_SUGGESTIONS: readonly ComposerSuggestion[] = [];
export const FILE_SUGGESTION_LIMIT = 5;

export function piSessionSuggestions(
	t: typeof translate,
): ComposerSuggestion[] {
	return [
		{
			kind: "command",
			value: "/new",
			label: "/new",
			detail: t("chat.newSessionDetail"),
		},
		{
			kind: "command",
			value: "/compact",
			label: "/compact",
			detail: t("chat.compactContextDetail"),
		},
	];
}

export const TRIGGER_META: Record<
	SuggestionTrigger,
	{
		kind: ComposerSuggestionKind;
		titleKey: "chat.fileSuggestion" | "chat.piCommandSuggestion";
	}
> = {
	"@": { kind: "file", titleKey: "chat.fileSuggestion" },
	"/": { kind: "command", titleKey: "chat.piCommandSuggestion" },
};

export function activeSuggestionQuery(
	value: string,
	caret: number,
): ActiveSuggestionQuery | null {
	const beforeCaret = value.slice(0, caret);
	const tokenStart =
		Math.max(
			beforeCaret.lastIndexOf(" "),
			beforeCaret.lastIndexOf("\n"),
			beforeCaret.lastIndexOf("\t"),
		) + 1;
	const token = beforeCaret.slice(tokenStart);
	const trigger = token[0];
	if (trigger !== "@" && trigger !== "/") return null;
	// 命令仅由输入开头的斜杠触发；@ 文件引用可在任意位置触发。
	if (trigger === "/" && tokenStart !== 0) return null;
	if (token.slice(1).includes(" ")) return null;
	return {
		trigger,
		query: token.slice(1),
		start: tokenStart,
		end: caret,
	};
}

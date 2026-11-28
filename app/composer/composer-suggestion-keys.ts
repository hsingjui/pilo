/**
 * What a suggestion-menu key press does, shared by the desktop and mobile
 * composers: Escape dismisses, arrows cycle the candidates, and Tab/Enter
 * pick the focused one. Shells that give Tab other meaning (mention tab
 * switching) handle it before calling this.
 */
export type SuggestionMenuKey =
	| "ArrowUp"
	| "ArrowDown"
	| "Tab"
	| "Enter"
	| "Escape";

export type SuggestionMenuAction =
	| "dismiss"
	| "next"
	| "prev"
	| "pick"
	| "none";

export function suggestionMenuAction(
	key: SuggestionMenuKey | string,
	count: number,
): SuggestionMenuAction {
	if (key === "Escape") return "dismiss";
	if (count === 0) return "none";
	if (key === "ArrowDown") return "next";
	if (key === "ArrowUp") return "prev";
	if (key === "Enter" || key === "Tab") return "pick";
	return "none";
}

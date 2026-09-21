import { useEffect, useRef } from "react";
import { FileCode2, Sparkles, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import {
	menuItemClassName,
	menuItemIconClassName,
	menuSurfaceClassName,
	menuSurfaceStyle,
} from "@/ui/menu-styles";

export type ComposerSuggestionKind = "file" | "command";

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

export const DEFAULT_SUGGESTIONS: readonly ComposerSuggestion[] = [];
export const FILE_SUGGESTION_LIMIT = 5;

export const PI_SESSION_SUGGESTIONS: readonly ComposerSuggestion[] = [
	{
		kind: "command",
		value: "/new",
		label: "/new",
		detail: "新建会话",
	},
	{
		kind: "command",
		value: "/compact",
		label: "/compact",
		detail: "压缩当前上下文",
	},
];

export const TRIGGER_META: Record<
	SuggestionTrigger,
	{ kind: ComposerSuggestionKind; title: string }
> = {
	"@": { kind: "file", title: "文件" },
	"/": { kind: "command", title: "Pi 命令" },
};

// 中英混排：标题以 ASCII 开头时才补一个分隔空格，避免「没有可用的 文件」。
function spacedTitle(title: string) {
	return title.charCodeAt(0) < 0x80 ? ` ${title}` : title;
}

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
	if (token.slice(1).includes(" ")) return null;
	return {
		trigger,
		query: token.slice(1),
		start: tokenStart,
		end: caret,
	};
}

function SuggestionIcon({
	kind,
	skill = false,
}: {
	kind: ComposerSuggestionKind;
	skill?: boolean;
}) {
	if (kind === "file") return <FileCode2 className="size-3" />;
	if (skill) return <Sparkles className="size-3" />;
	return <TerminalSquare className="size-3" />;
}

type ComposerSuggestionMenuProps = {
	activeQuery: ActiveSuggestionQuery;
	title: string;
	suggestions: readonly ComposerSuggestion[];
	highlightedIndex: number;
	onHighlight: (index: number) => void;
	onSelect: (suggestion: ComposerSuggestion) => void;
};

export function ComposerSuggestionMenu({
	activeQuery,
	title,
	suggestions,
	highlightedIndex,
	onHighlight,
	onSelect,
}: ComposerSuggestionMenuProps) {
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const list = listRef.current;
		if (!list || suggestions.length === 0) return;
		const item = list.querySelector<HTMLElement>(
			`[data-suggestion-index="${highlightedIndex}"]`,
		);
		if (!item) return;

		const listRect = list.getBoundingClientRect();
		const itemRect = item.getBoundingClientRect();
		if (itemRect.top < listRect.top) {
			list.scrollTop -= listRect.top - itemRect.top;
		} else if (itemRect.bottom > listRect.bottom) {
			list.scrollTop += itemRect.bottom - listRect.bottom;
		}
	}, [highlightedIndex, suggestions.length]);

	return (
		<div
			role="menu"
			aria-label={`${title}建议`}
			className={cn(
				"absolute bottom-[calc(100%+6px)] left-0 z-40 w-full overflow-hidden",
				menuSurfaceClassName,
				activeQuery.trigger === "/" ? "max-w-[520px]" : "max-w-[600px]",
			)}
			style={menuSurfaceStyle}
		>
			<div
				ref={listRef}
				className={cn(
					"scrollbar-pro overflow-y-auto",
					activeQuery.trigger === "/" ? "max-h-72" : "max-h-52",
				)}
			>
				{suggestions.length > 0 ? (
					suggestions.map((suggestion, index) => (
						<button
							key={`${suggestion.kind}:${suggestion.value}`}
							type="button"
							role="menuitem"
							aria-current={index === highlightedIndex ? "true" : undefined}
							data-suggestion-index={index}
							tabIndex={-1}
							className={cn(
								menuItemClassName,
								index === highlightedIndex && "bg-hover text-hover-foreground",
							)}
							onMouseDown={(event) => event.preventDefault()}
							onPointerMove={() => onHighlight(index)}
							onClick={() => onSelect(suggestion)}
						>
							<span className={menuItemIconClassName}>
								<SuggestionIcon
									kind={suggestion.kind}
									skill={suggestion.skill}
								/>
							</span>
							<span className="min-w-0 flex-1 truncate font-mono text-xs">
								{suggestion.label}
							</span>
							{suggestion.detail ? (
								<span className="min-w-0 max-w-[45%] shrink truncate text-xs text-muted-foreground">
									{suggestion.detail}
								</span>
							) : null}
						</button>
					))
				) : (
					<div className="px-3 py-4 text-center text-xs text-muted-foreground">
						{activeQuery.query
							? `没有匹配“${activeQuery.query}”的${spacedTitle(title)}`
							: `没有可用${spacedTitle(title)}`}
					</div>
				)}
			</div>
		</div>
	);
}

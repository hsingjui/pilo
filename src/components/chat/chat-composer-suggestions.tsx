import { useEffect, useRef } from "react";
import { FileCode2, TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";

export type ComposerSuggestionKind = "file" | "command";

export type ComposerSuggestion = {
	kind: ComposerSuggestionKind;
	value: string;
	label: string;
	detail?: string;
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
	{ kind: ComposerSuggestionKind; title: string; hint: string }
> = {
	"@": { kind: "file", title: "文件", hint: "输入路径筛选" },
	"/": {
		kind: "command",
		title: "Pi 命令",
		hint: "Extensions · Prompts · Skills",
	},
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
	if (token.slice(1).includes(" ")) return null;
	return {
		trigger,
		query: token.slice(1),
		start: tokenStart,
		end: caret,
	};
}

function SuggestionIcon({ kind }: { kind: ComposerSuggestionKind }) {
	if (kind === "file") return <FileCode2 className="size-3" />;
	return <TerminalSquare className="size-3" />;
}

type ComposerSuggestionMenuProps = {
	activeQuery: ActiveSuggestionQuery;
	title: string;
	hint: string;
	suggestions: readonly ComposerSuggestion[];
	highlightedIndex: number;
	onHighlight: (index: number) => void;
	onSelect: (suggestion: ComposerSuggestion) => void;
};

export function ComposerSuggestionMenu({
	activeQuery,
	title,
	hint,
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
				"absolute bottom-[calc(100%+6px)] left-0 z-40 w-full overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-md",
				activeQuery.trigger === "/" ? "max-w-[520px]" : "max-w-[600px]",
			)}
		>
			<div className="flex h-7 items-center gap-1.5 border-b border-border/70 px-2 text-[10px] text-muted-foreground">
				<span className="flex size-4.5 items-center justify-center rounded bg-muted font-mono text-foreground">
					{activeQuery.trigger}
				</span>
				<span className="font-medium text-foreground/85">{title}</span>
				<span className="truncate">{hint}</span>
				<span className="ml-auto hidden @min-[40rem]:inline">
					↑↓ 选择 · Tab / Enter 补全 · Esc 关闭
				</span>
			</div>
			<div
				ref={listRef}
				className={cn(
					"scrollbar-pro overflow-y-auto p-1",
					activeQuery.trigger === "/" ? "max-h-44" : "max-h-52",
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
								"flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs outline-hidden transition-colors",
								index === highlightedIndex
									? "bg-hover text-hover-foreground"
									: "text-popover-foreground hover:bg-hover/70",
							)}
							onMouseDown={(event) => event.preventDefault()}
							onPointerMove={() => onHighlight(index)}
							onClick={() => onSelect(suggestion)}
						>
							<span className="flex size-5 shrink-0 items-center justify-center rounded border border-border/60 bg-muted/35 text-muted-foreground">
								<SuggestionIcon kind={suggestion.kind} />
							</span>
							<span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-5">
								{suggestion.label}
							</span>
							{suggestion.detail ? (
								<span className="max-w-40 shrink-0 truncate text-[10px] text-muted-foreground">
									{suggestion.detail}
								</span>
							) : null}
						</button>
					))
				) : (
					<div className="px-3 py-4 text-center text-xs text-muted-foreground">
						{activeQuery.query
							? `没有匹配“${activeQuery.query}”的${title}`
							: `没有匹配的${title}`}
					</div>
				)}
			</div>
		</div>
	);
}

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
	if (kind === "file") return <FileCode2 className="size-3.5" />;
	return <TerminalSquare className="size-3.5" />;
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
	return (
		<div
			role="menu"
			aria-label={`${title}建议`}
			className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-full max-w-[640px] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
		>
			<div className="flex h-8 items-center gap-2 border-b border-border/70 px-2.5 text-[11px] text-muted-foreground">
				<span className="flex size-5 items-center justify-center rounded bg-muted font-mono text-foreground">
					{activeQuery.trigger}
				</span>
				<span className="font-medium text-foreground/85">{title}</span>
				<span className="truncate">{hint}</span>
				<span className="ml-auto hidden sm:inline">
					↑↓ 选择 · Enter 插入 · Esc 关闭
				</span>
			</div>
			<div className="scrollbar-pro max-h-60 overflow-y-auto p-1">
				{suggestions.length > 0 ? (
					suggestions.map((suggestion, index) => (
						<button
							key={`${suggestion.kind}:${suggestion.value}`}
							type="button"
							role="menuitem"
							aria-current={index === highlightedIndex ? "true" : undefined}
							tabIndex={-1}
							className={cn(
								"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-hidden transition-colors",
								index === highlightedIndex
									? "bg-hover text-hover-foreground"
									: "text-popover-foreground hover:bg-hover/70",
							)}
							onMouseDown={(event) => event.preventDefault()}
							onPointerMove={() => onHighlight(index)}
							onClick={() => onSelect(suggestion)}
						>
							<span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/35 text-muted-foreground">
								<SuggestionIcon kind={suggestion.kind} />
							</span>
							<span className="min-w-0 flex-1 truncate font-mono text-[11px]">
								{suggestion.label}
							</span>
							{suggestion.detail ? (
								<span className="max-w-44 shrink-0 truncate text-[11px] text-muted-foreground">
									{suggestion.detail}
								</span>
							) : null}
						</button>
					))
				) : (
					<div className="px-3 py-5 text-center text-xs text-muted-foreground">
						没有匹配的{title}
					</div>
				)}
			</div>
		</div>
	);
}

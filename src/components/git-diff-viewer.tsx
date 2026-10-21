import { useMemo, type CSSProperties } from "react";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import {
	parsePatchFiles,
	DEFAULT_VIRTUAL_FILE_METRICS,
	EXTENSION_TO_FILE_FORMAT,
	setCustomExtension,
	type FileDiffMetadata,
} from "@pierre/diffs";
import { useTranslation } from "react-i18next";

import { bundledLanguages } from "@/lib/git-diff-shiki";
import { usePreferences } from "@/lib/preferences-provider";
import { useTheme } from "@/lib/theme-provider";
import { EmptyState } from "@/ui";

// Unsupported syntax stays a regular diff without loading removed grammars.
for (const [extension, language] of Object.entries(EXTENSION_TO_FILE_FORMAT)) {
	if (language == null || !Object.hasOwn(bundledLanguages, language)) {
		setCustomExtension(extension, extension === "h" ? "c" : "text");
	}
}

export function DiffViewer({
	diff,
	diffStyle,
	wrapLines,
}: {
	diff: string;
	diffStyle: "unified" | "split";
	wrapLines: boolean;
}) {
	const { t } = useTranslation();
	const { resolvedTheme } = useTheme();
	const { codeFontSize } = usePreferences();
	const files = useMemo((): FileDiffMetadata[] | null => {
		if (!diff.trim()) return [];
		try {
			return parsePatchFiles(diff, undefined, true).flatMap(
				(patch) => patch.files,
			);
		} catch {
			// Combined/conflicted or truncated patches must remain readable.
			return null;
		}
	}, [diff]);
	const lineHeight = Math.round(codeFontSize * 1.6);
	const metrics = useMemo(
		() => ({ ...DEFAULT_VIRTUAL_FILE_METRICS, lineHeight }),
		[lineHeight],
	);
	const options = useMemo(
		() => ({
			theme: { light: "github-light", dark: "github-dark" },
			themeType: resolvedTheme,
			diffStyle,
			overflow: wrapLines ? ("wrap" as const) : ("scroll" as const),
			lineDiffType: "word-alt" as const,
			hunkSeparators: "simple" as const,
			diffIndicators: "bars" as const,
			disableFileHeader: true,
		}),
		[resolvedTheme, diffStyle, wrapLines],
	);
	const style: CSSProperties & Record<`--diffs-${string}`, string> = {
		"--diffs-font-family": "var(--pilo-code-font-family)",
		"--diffs-header-font-family": "var(--pilo-page-font-family)",
		"--diffs-font-size": `${codeFontSize}px`,
		"--diffs-line-height": `${lineHeight}px`,
		"--diffs-bg": "hsl(var(--background))",
		"--diffs-fg": "hsl(var(--foreground))",
		"--diffs-fg-number-override": "hsl(var(--muted-foreground))",
		"--diffs-bg-context-override": "hsl(var(--muted) / 0.35)",
		"--diffs-bg-separator-override": "hsl(var(--muted) / 0.5)",
		"--diffs-addition-color-override": "hsl(var(--status-success))",
		"--diffs-deletion-color-override": "hsl(var(--status-danger))",
	};

	if (!diff.trim()) {
		return (
			<EmptyState
				className="flex-1"
				title={t("file.noDiff")}
				description={t("file.noDiffDescription")}
			/>
		);
	}
	if (!files?.length || files.every((file) => file.hunks.length === 0)) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<p className="shrink-0 border-b border-border/60 bg-muted/20 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
					{files?.length
						? t("file.noTextDiffDescription")
						: t("file.rawDiffFallback")}
				</p>
				<pre
					className="scrollbar-pro min-h-0 flex-1 overflow-auto p-4 font-mono leading-relaxed"
					style={{
						fontSize: codeFontSize,
						whiteSpace: wrapLines ? "pre-wrap" : "pre",
						overflowWrap: "anywhere",
					}}
				>
					{diff}
				</pre>
			</div>
		);
	}
	return (
		<Virtualizer className="scrollbar-pro min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
			{files.map((file) => (
				<FileDiff
					// The React wrapper only reads metrics when creating the instance.
					key={`${file.prevName ?? ""}:${file.name}:${lineHeight}`}
					fileDiff={file}
					options={options}
					metrics={metrics}
					style={style}
				/>
			))}
		</Virtualizer>
	);
}

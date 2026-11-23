import { computed, Scroll, Text, View } from "nsh";
import { DiffView } from "nsh/base";

import { fileBasename } from "@shared/chat/chat-tool-result";
import { getMonospaceFontFamilyStack } from "@shared/font-settings";
import type { HostPreferenceValues } from "@shared/host-preferences-types";

import { scrollbarLook } from "../ui/scrollbar";
import { EmptyState } from "../ui/state-view";
import { t } from "./i18n";

const DEFAULT_CODE_FONT_SIZE = 12;
const MAX_DIFF_PREVIEW_CHARS = 256 * 1024;
const MAX_DIFF_PREVIEW_LINES = 4_000;

function diffPreview(diff: string) {
	let end = Math.min(diff.length, MAX_DIFF_PREVIEW_CHARS);
	let lines = 1;
	for (let index = 0; index < end; index++) {
		const ch = diff.charCodeAt(index);
		if (ch === 10 || (ch === 13 && diff.charCodeAt(index + 1) !== 10)) {
			if (++lines > MAX_DIFF_PREVIEW_LINES) {
				end = index;
				break;
			}
		}
	}
	const next = diff.charCodeAt(end);
	if (end > 0 && next >= 0xdc00 && next <= 0xdfff) end--;
	return { text: diff.slice(0, end), truncated: end < diff.length };
}

export type GitDiffKind = "empty" | "patch" | "metadata" | "raw";

const UNIFIED_HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const HAS_UNIFIED_HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
const COMBINED_DIFF_RE = /^(?:diff --(?:cc|combined) |@@@ )/m;
const GIT_METADATA_RE =
	/^(?:diff --git |Binary files |GIT binary patch$|old mode |new mode |new file mode |deleted file mode |rename from |rename to |copy from |copy to |similarity index |dissimilarity index )/m;

function hasValidUnifiedHunks(diff: string): boolean {
	const lines = diff.split(/\r\n|\r|\n/);
	let hunks = 0;
	let index = 0;
	while (index < lines.length) {
		const match = UNIFIED_HUNK_HEADER_RE.exec(lines[index] ?? "");
		if (!match) {
			index += 1;
			continue;
		}
		hunks += 1;
		const oldExpected = match[2] === undefined ? 1 : Number(match[2]);
		const newExpected = match[4] === undefined ? 1 : Number(match[4]);
		let oldSeen = 0;
		let newSeen = 0;
		index += 1;
		while (oldSeen < oldExpected || newSeen < newExpected) {
			if (index >= lines.length) return false;
			const line = lines[index] ?? "";
			if (line.startsWith("\\")) {
				index += 1;
				continue;
			}
			if (line.startsWith(" ")) {
				oldSeen += 1;
				newSeen += 1;
			} else if (line.startsWith("-")) {
				oldSeen += 1;
			} else if (line.startsWith("+")) {
				newSeen += 1;
			} else {
				return false;
			}
			if (oldSeen > oldExpected || newSeen > newExpected) return false;
			index += 1;
		}
	}
	return hunks > 0;
}

/** Classifies raw `git diff` output so binary/metadata, combined, and truncated patches stay readable. */
export function classifyGitDiff(diff: string): GitDiffKind {
	if (!diff.trim()) return "empty";
	if (COMBINED_DIFF_RE.test(diff)) return "raw";
	if (HAS_UNIFIED_HUNK_RE.test(diff)) {
		return hasValidUnifiedHunks(diff) ? "patch" : "raw";
	}
	if (GIT_METADATA_RE.test(diff)) return "metadata";
	return "raw";
}

function resolveCodeFontSize(
	preferences: HostPreferenceValues | undefined,
): number {
	const value = preferences?.codeFontSize;
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: DEFAULT_CODE_FONT_SIZE;
}

/**
 * Renders a unified Git diff using nsh's native virtualized `DiffView`,
 * falling back to inert monospaced text for binary/metadata-only or
 * unsupported combined patches, and an empty state when there is no diff.
 */
export function GitDiffViewer(props: {
	diff: () => string;
	path: () => string;
	diffStyle: () => "unified" | "split";
	wrapLines: () => boolean;
	preferences: () => HostPreferenceValues | undefined;
}) {
	const preview = computed(() => diffPreview(props.diff()));
	const kind = computed(() =>
		preview().truncated ? "raw" : classifyGitDiff(preview().text),
	);
	const fontFamily = computed(() =>
		getMonospaceFontFamilyStack(
			props.preferences()?.codeFontFamily ?? "system-mono",
		),
	);
	const fontSize = computed(() => resolveCodeFontSize(props.preferences()));
	const lineHeight = computed(() => Math.round(fontSize() * 1.6));
	const language = computed(() => {
		const path = props.path();
		return fileBasename(path) || path;
	});

	return () => {
		const currentKind = kind();
		if (currentKind === "empty") {
			return (
				<EmptyState
					testID="git-diff-empty"
					class="flex-1"
					title={() => t("file.noDiff")}
					description={() => t("file.noDiffDescription")}
				/>
			);
		}
		if (currentKind === "metadata" || currentKind === "raw") {
			const noticeKey = preview().truncated
				? "file.diffTruncated"
				: currentKind === "metadata"
					? "file.noTextDiffDescription"
					: "file.rawDiffFallback";
			return (
				<View
					testID={
						currentKind === "metadata"
							? "git-diff-metadata"
							: "git-diff-raw-fallback"
					}
					class="min-h-0 min-w-0 flex-1 flex-col"
				>
					<View class="shrink-0 border-b border-border/60 bg-muted/20 px-4 py-3">
						<Text class="font-sans text-xs leading-relaxed text-muted-foreground">
							{() => t(noticeKey)}
						</Text>
					</View>
					<Scroll
						class="min-h-0 min-w-0 flex-1"
						contentClass="p-4"
						bounces={false}
						horizontal={!props.wrapLines()}
						scrollbar={{
							vertical: scrollbarLook(),
							horizontal: !props.wrapLines() ? scrollbarLook() : undefined,
						}}
					>
						<View selectable>
							<Text
								testID="git-diff-raw-text"
								class="font-mono text-foreground"
								style={{
									fontFamily: fontFamily(),
									fontSize: fontSize(),
									lineHeight: lineHeight(),
								}}
							>
								{() => preview().text}
							</Text>
						</View>
					</Scroll>
				</View>
			);
		}
		return (
			<DiffView
				testID="git-diff-view"
				class="min-h-0 min-w-0 flex-1 bg-background"
				patch={preview().text}
				language={language()}
				layout={props.diffStyle()}
				inline="wordAlt"
				indicators="bars"
				softWrap={props.wrapLines()}
				lineNumbers
				background
				fontFamily={fontFamily()}
				fontSize={fontSize()}
				lineHeight={lineHeight()}
				renderSeparator={() => <View class="h-2 bg-muted/50" />}
				classes={{
					side: "bg-background",
					gutter: "bg-background",
					lineNumber: "text-muted-foreground",
					lineNumberAdded: "text-status-success",
					lineNumberDeleted: "text-status-danger",
					lineAdded: "bg-status-success/10",
					lineDeleted: "bg-status-danger/10",
					wordAdded: "bg-status-success/25",
					wordDeleted: "bg-status-danger/25",
					indicatorAdded: "bg-status-success",
					indicatorDeleted: "bg-status-danger",
					filler: "bg-muted/35",
					separator: "bg-muted/50",
				}}
			/>
		);
	};
}

import { computed, Image, Scroll, Text, token, View } from "nsh";

import type { ToolCallActivity } from "@/lib/chat/chat-activity-types";
import {
	diffLineStyle,
	flattenToolResult,
	formatUnknown,
	resultContent,
	toolEditDiff,
	toolPreview,
	toolResultImageUrl,
} from "@/lib/chat/chat-tool-result";
import type { ChatTodoItem } from "@/lib/chat/chat-todos";

import { appLocale, t } from "../app/i18n";
import { scrollbarLook } from "../ui/scrollbar";
import { ChatTodoList } from "./chat-todo-list";

const codeText = "font-mono leading-[1.4] text-muted-foreground";
const codeSize = () => ({ fontSize: token("pilo-code-font-size") });

/** A block of code-like text that scrolls past `maxHeight`, as the WebUI's `pre`. */
function ToolText(props: { text: () => string; maxHeight: string }) {
	return (
		<Scroll
			class={`${props.maxHeight} py-0.5 pr-1`}
			scrollbar={{ vertical: scrollbarLook() }}
		>
			<View selectable>
				<Text class={codeText} style={codeSize()}>
					{props.text}
				</Text>
			</View>
		</Scroll>
	);
}

/** An edit's diff, a line per row: added and removed lines marked and tinted. */
function ToolDiff(props: { diff: () => string }) {
	const lines = computed(() =>
		props
			.diff()
			.split("\n")
			.map((line) => diffLineStyle(line)),
	);
	return (
		<Scroll
			testID="chat-tool-diff"
			class="max-h-64 py-1"
			scrollbar={{ vertical: scrollbarLook() }}
		>
			<View selectable>
				<Each of={lines()} key="index">
					{(line) => (
						<View
							class={
								line().marker === "+"
									? "flex-row bg-code-added/[0.07]"
									: line().marker === "−"
										? "flex-row bg-destructive/[0.06]"
										: "flex-row"
							}
						>
							<Text
								accessibilityElementsHidden
								class={
									line().marker === "+"
										? "w-3 text-center font-mono leading-[1.4] text-code-added"
										: "w-3 text-center font-mono leading-[1.4] text-destructive"
								}
								style={codeSize()}
							>
								{() => line().marker}
							</Text>
							<Text
								class={
									line().marker
										? "min-w-0 flex-1 font-mono leading-[1.4] text-foreground/80"
										: "min-w-0 flex-1 font-mono leading-[1.4] text-muted-foreground"
								}
								style={codeSize()}
							>
								{() => line().content || " "}
							</Text>
						</View>
					)}
				</Each>
			</View>
		</Scroll>
	);
}

/**
 * What a tool call's row opens to, as the WebUI shows it: a task list; or
 * how a command ended, what a write wrote, an edit's diff or the call's
 * input and output as text, and the images it returned.
 */
export function ChatToolDetail(props: {
	activity: () => ToolCallActivity;
	writeContent: () => string | null;
	todos: () => ChatTodoItem[] | null;
}) {
	const { activity } = props;
	const diff = computed(() => {
		const current = activity();
		return current.toolName.toLowerCase() === "edit" && !current.isError
			? toolEditDiff(current.result)
			: null;
	});
	const argsText = computed(() => {
		const current = activity();
		const hasArgs = current.args !== undefined && current.args !== null;
		return hasArgs && toolPreview(current) === null
			? formatUnknown(current.args)
			: null;
	});
	const flattened = computed(() => {
		const { result } = activity();
		if (result === undefined || result === null) return null;
		const flat = flattenToolResult(resultContent(result));
		return {
			...flat,
			text: flat.needsRawFallback ? formatUnknown(result) : flat.text,
		};
	});
	const detailText = computed(() =>
		[argsText(), flattened()?.text || null]
			.filter((value): value is string => Boolean(value))
			.join("\n"),
	);
	const exitCode = computed(() => flattened()?.exitCode ?? null);
	const wallTimeSeconds = computed(() => flattened()?.wallTimeSeconds ?? null);
	const truncated = computed(() => flattened()?.truncated === true);
	const hasSummary = computed(
		() => exitCode() !== null || wallTimeSeconds() !== null || truncated(),
	);
	const images = computed(() => (diff() ? [] : (flattened()?.images ?? [])));
	// What shows changes far less often than the text it shows.
	const hasTodos = computed(() => props.todos() !== null);
	const hasWrite = computed(() => props.writeContent() !== null);
	const body = computed(() => (diff() ? "diff" : detailText() ? "text" : null));
	return () => {
		if (hasTodos()) {
			return (
				<View class="w-full pt-0.5 pb-1">
					<ChatTodoList items={() => props.todos() ?? []} class="py-1" />
				</View>
			);
		}
		return (
			<View testID="chat-tool-detail" class="w-full pt-0.5 pb-1">
				{() =>
					hasSummary() ? (
						<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1 py-1">
							{() =>
								exitCode() !== null ? (
									<Text
										class={
											exitCode() === 0
												? "font-sans text-xs text-muted-foreground"
												: "font-sans text-xs text-destructive"
										}
									>
										{() => t("chat.toolExitCode", { code: exitCode() ?? 0 })}
									</Text>
								) : null
							}
							{() =>
								wallTimeSeconds() !== null ? (
									<Text class="font-sans text-xs text-muted-foreground">
										{() =>
											t("chat.toolDuration", {
												duration: (wallTimeSeconds() ?? 0).toLocaleString(
													appLocale(),
													{ maximumFractionDigits: 2 },
												),
											})
										}
									</Text>
								) : null
							}
							{() =>
								truncated() ? (
									<Text class="font-sans text-xs text-muted-foreground">
										{() => t("chat.toolOutputTruncated")}
									</Text>
								) : null
							}
						</View>
					) : null
				}
				{() =>
					hasWrite() ? (
						<ToolText
							text={() => props.writeContent() ?? ""}
							maxHeight="max-h-56"
						/>
					) : null
				}
				{() =>
					body() === "diff" ? (
						<ToolDiff diff={() => diff() ?? ""} />
					) : body() === "text" ? (
						<ToolText text={detailText} maxHeight="max-h-56" />
					) : null
				}
				<Each of={images()} key={(image) => image.key}>
					{(image) => (
						<Image
							src={toolResultImageUrl(image())}
							accessibilityLabel={t("chat.toolResultImage")}
							class="mt-1 max-h-80 max-w-full rounded-(--pilo-radius-md)"
							style={{ objectFit: "contain" }}
						/>
					)}
				</Each>
			</View>
		);
	};
}

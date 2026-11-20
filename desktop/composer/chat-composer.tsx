import {
	type Bounds,
	type InputRef,
	Overlay,
	Text,
	View,
	type ViewRef,
	cleanup,
	effect,
	keymap,
	signal,
	token,
} from "nsh";
import { Picker } from "nsh";
import { Input as BaseInput } from "nsh/base";

import {
	DEFAULT_SUGGESTIONS,
	activeSuggestionQuery,
	type ComposerSuggestion,
} from "@/lib/chat/composer-suggestions";
import { formatChatImageSize } from "@/lib/chat/chat-submission";
import { sessionMentionValue } from "@/lib/chat/session-mentions";
import { DEFAULT_READING_FONT_SIZE } from "@/lib/font-settings";
import type { SendMessageShortcut } from "@/lib/host-preferences-types";

import { t } from "../app/i18n";
import { DEFAULT_CHAT_REM } from "../chat/layout";
import { APP_SHORTCUTS } from "../shortcuts";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { styleVar } from "../ui/theme-style";
import { Tooltip } from "../ui/tooltip";
import { ComposerActions } from "./composer-actions";
import { ComposerContextUsage } from "./composer-context-usage";
import {
	ComposerRunConfig,
	type ComposerRunConfigProps,
} from "./composer-run-config";
import type { ComposerStore } from "./composer-store";

/** The React composer grows to 12 lines, then scrolls. */
const MAX_ROWS = 12;
/** The input keeps its native leading with a small inset above and below. */
const INPUT_PADDING = 4;
const CHAT_SCALE = DEFAULT_CHAT_REM / 16;

const composerShadow = () => {
	const shadow = styleVar("pilo-shadow-composer");
	// The default Lody composer is flat on the web. Give the native card elevation.
	return shadow && shadow !== "0 0 #0000" ? shadow : styleVar("pilo-shadow-sm");
};

/** The focused surface's shadow; only some theme families define one. */
const focusShadow = () =>
	(styleVar as (name: string) => string | undefined)(
		"pilo-shadow-composer-focus",
	) ?? composerShadow();

export interface ChatComposerProps {
	/** The open chat's composer state and actions. */
	store: ComposerStore;
	/** The configured submit shortcut; Enter submits by default. */
	sendShortcut?: () => SendMessageShortcut | undefined;
	/** The reading font size the messages use, in points. */
	readingFontSize?: () => number | undefined;
	/** The model · thinking control; the toolbar leaves it out without one. */
	runConfig?: ComposerRunConfigProps;
}

/**
 * The prompt bar under a chat: a growing multiline input with `@` file and
 * session mentions, `/` commands, picked, pasted and dropped attachments,
 * per-session drafts and per-project input history, and send or stop.
 */
export function ChatComposer(props: ChatComposerProps) {
	const store = props.store;
	const anchor = signal<Bounds | null>(null);
	const index = signal(0);
	const dismissed = signal(false);
	const contentHeight = signal(0);
	const focused = signal(false);
	const surface = signal<ViewRef | undefined>(undefined);
	let input: InputRef | undefined;

	const state = () => store.state();
	const running = () => store.running();
	const modEnter = () => (props.sendShortcut?.() ?? "enter") === "mod-enter";
	const hasContent = () =>
		state().value.trim().length > 0 || state().images.length > 0;

	const query = () => activeSuggestionQuery(state().value, state().caret);

	const items = (): readonly ComposerSuggestion[] => {
		const active = query();
		if (!active) return [];
		const needle = active.query.toLowerCase();
		if (active.trigger === "/") {
			return [...DEFAULT_SUGGESTIONS, ...(store.commands() ?? [])]
				.filter(
					(suggestion) =>
						!needle || suggestion.label.toLowerCase().includes(needle),
				)
				.slice(0, 8);
		}
		const sessions = store
			.sessionMentions()
			.filter(
				(mention) =>
					!needle ||
					mention.title.toLowerCase().includes(needle) ||
					mention.projectName.toLowerCase().includes(needle),
			)
			.slice(0, 5)
			.map((mention): ComposerSuggestion => ({
				kind: "session",
				value: sessionMentionValue(mention.path),
				label: mention.title,
				detail: mention.projectName,
			}));
		return [...sessions, ...store.fileSuggestions()].slice(0, 10);
	};

	const menuOpen = () => focused() && items().length > 0 && !dismissed();

	// While the menu shows, its keys are bound over the input's own
	// (`when: "always"`): a native input keeps its arrows from `onKeyPress`.
	effect(() => {
		if (!focused()) return;
		const list = items();
		index.set(0);
		if (!list.length) {
			dismissed.set(false);
			return;
		}
		if (dismissed()) return;
		const move = (by: number) =>
			index.update((i) => (i + by + list.length) % list.length);
		cleanup(
			keymap.bind(
				{
					down: () => move(1),
					up: () => move(-1),
					tab: () => pick(items()[index()]),
					enter: () => pick(items()[index()]),
					escape: () => dismissed.set(true),
				},
				{ when: "always", repeat: true },
			),
		);
	});

	// "mod+enter" submits when the preference says so; Return stays a newline.
	effect(() => {
		if (!focused() || !modEnter()) return;
		cleanup(
			keymap.bind(APP_SHORTCUTS.sendMessage, () => submit(), {
				when: "always",
			}),
		);
	});

	// File suggestions follow the `@` query, debounced.
	effect(() => {
		const active = query();
		if (active?.trigger !== "@") {
			store.clearFileSuggestions();
			return;
		}
		const timer = setTimeout(() => {
			void store.searchFileSuggestions(active.query);
		}, 150);
		cleanup(() => clearTimeout(timer));
	});

	// `/` asks the chat for its commands once.
	effect(() => {
		if (query()?.trigger === "/") void store.loadCommands();
	});

	const pick = (suggestion: ComposerSuggestion | undefined) => {
		const active = query();
		if (!suggestion || !active || !input) return;
		const inserted = `${suggestion.value} `;
		const value = state().value;
		const next =
			value.slice(0, active.start) + inserted + value.slice(state().caret);
		store.setValue(next, active.start + inserted.length);
		dismissed.set(true);
		// `insertText` is not carried out on macOS in nsh 0.6.0, so the pick
		// writes the controlled value and restores the caret itself.
		input.setSelection(active.start + inserted.length);
		input.focus();
	};

	const submit = () => {
		if (menuOpen()) return;
		void store.submit();
	};

	const pickFiles = () => {
		const target = store.target();
		if (!target) return;
		void Picker.pickFiles({ multiple: true })
			.then((picked) =>
				store.addFiles(
					picked.flatMap((entry) => (entry.file ? [entry.file] : [])),
					target,
				),
			)
			.catch((error: unknown) =>
				store.setStatus(
					error instanceof Error ? error.message : String(error),
					target.sessionKey,
				),
			);
	};

	const arrowKeys = (direction: "older" | "newer") => {
		void store.navigateHistory(direction);
	};

	effect(() => {
		if (!focused() || menuOpen()) return;
		cleanup(
			keymap.bind(
				{
					up: () => arrowKeys("older"),
					down: () => arrowKeys("newer"),
				},
				{ when: "always" },
			),
		);
	});

	const attachments = () => {
		const draft = store.mentionDraft();
		return {
			images: state().images,
			references: draft.references,
		};
	};

	const fontSize = () => props.readingFontSize?.() ?? DEFAULT_READING_FONT_SIZE;
	const lineHeight = () => Math.max(20, fontSize() * 1.25);
	// Keep the theme minimum or two rows, whichever is taller, as in Tauri.
	const inputHeight = () => {
		const min = Math.max(
			token("pilo-composer-input-height") * CHAT_SCALE,
			lineHeight() * 2 + INPUT_PADDING,
		);
		const max = lineHeight() * MAX_ROWS + INPUT_PADDING;
		return Math.max(
			min,
			Math.min(Math.ceil(contentHeight()) + INPUT_PADDING, max),
		);
	};
	const disabled = () => store.target() === null;
	const blocked = () =>
		disabled() || state().sending || (running() && store.compacting());
	const config = () => props.runConfig?.config() ?? null;

	return (
		<View
			testID="chat-composer"
			class="relative w-full"
			onFileDragEnter={() => store.setDragging(true)}
			onFileDragLeave={() => store.setDragging(false)}
			onFileDrop={({ uris }) => {
				store.setDragging(false);
				void store.addUris(uris);
			}}
		>
			{() =>
				state().status ? (
					<View
						testID="chat-composer-status"
						role="alert"
						class="mb-2 min-w-0 rounded-xl border border-border/60 bg-muted px-3 py-2"
					>
						<View selectable>
							<Text class="font-sans text-xs leading-5 text-destructive">
								{() => state().status ?? ""}
							</Text>
						</View>
					</View>
				) : null
			}
			<View
				ref={(ref) => surface.set(ref)}
				testID="chat-composer-surface"
				class="relative w-full rounded-(--pilo-composer-radius) border border-(--pilo-composer-border) bg-(--pilo-composer-background)"
				style={{
					borderColor: focused()
						? token("pilo-composer-focus-border")
						: undefined,
					boxShadow: focused() ? focusShadow() : composerShadow(),
					gap: token("pilo-composer-gap") * CHAT_SCALE,
					paddingHorizontal: DEFAULT_CHAT_REM * 0.5,
					paddingVertical: DEFAULT_CHAT_REM * 0.375,
				}}
			>
				{() =>
					attachments().images.length > 0 ||
					attachments().references.length > 0 ? (
						<View class="mb-1 min-w-0 flex-row flex-wrap items-center gap-1.5 p-1">
							{attachments().images.map((image) => (
								<AttachmentChip
									label={`${image.name} (${formatChatImageSize(image.size)})`}
									removeLabel={t("chat.removeAttachment", { name: image.name })}
									icon="File"
									onRemove={() => store.removeImage(image.id)}
								/>
							))}
							{attachments().references.map((reference, i) => {
								const name = reference.path.split("/").pop() ?? reference.path;
								return (
									<AttachmentChip
										label={name}
										removeLabel={t("chat.removeAttachment", { name })}
										icon={
											reference.kind === "session" ? "MessageSquare" : "File"
										}
										onRemove={() => store.removeReference(i)}
									/>
								);
							})}
						</View>
					) : null
				}
				<BaseInput
					ref={(ref) => {
						input = ref;
					}}
					testID="chat-composer-input"
					multiline
					autoCorrect={false}
					autoCapitalize="none"
					disabled={disabled()}
					readonly={disabled()}
					submitBehavior={modEnter() ? "newline" : "submit"}
					pasteBehavior="insert"
					value={state().value}
					accessibilityLabel={t("chat.composerPlaceholder")}
					placeholder={
						attachments().images.length === 0 &&
						attachments().references.length === 0
							? t("chat.composerPlaceholder")
							: undefined
					}
					// The size goes in the class: an inline `fontSize` reaches the typed
					// text but not the placeholder, which then sits larger and lower.
					class={`w-full min-w-0 border-0 bg-transparent px-1 font-sans text-[${fontSize()}px] text-input-foreground placeholder:text-input-placeholder`}
					style={{
						height: inputHeight(),
						minHeight: 0,
						paddingTop: INPUT_PADDING / 2,
						paddingBottom: INPUT_PADDING / 2,
					}}
					onContentSizeChange={({ size }) => contentHeight.set(size.height)}
					onFocus={() => focused.set(true)}
					onBlur={() => focused.set(false)}
					onChange={({ value }) => store.setValue(value)}
					onSelectionChange={({ end }) => store.setCaret(end)}
					onCaretMove={({ pageBounds }) => anchor.set(pageBounds)}
					onCompositionChange={({ composing }) => store.setComposing(composing)}
					onSubmit={() => submit()}
					onPaste={({ files, uris }) => {
						if (files.length) void store.addFiles(files);
						if (uris.length) void store.addUris(uris);
					}}
				/>
				<View
					testID="chat-composer-toolbar"
					class="-ml-1 min-w-0 flex-row items-center gap-(--pilo-composer-toolbar-gap)"
					style={{
						minHeight:
							token("pilo-composer-control-size") * CHAT_SCALE +
							DEFAULT_CHAT_REM / 8,
						paddingTop: DEFAULT_CHAT_REM / 8,
					}}
				>
					<Button
						testID="chat-composer-attach"
						variant="ghost"
						size="icon"
						class="h-(--pilo-composer-control-size) w-(--pilo-composer-attachment-width) rounded-(--pilo-radius-md)"
						disabled={blocked()}
						accessibilityLabel={t("chat.addAttachment")}
						tooltip={
							<Tooltip>
								<Text class="font-sans">{() => t("chat.addAttachment")}</Text>
							</Tooltip>
						}
						onPress={pickFiles}
					>
						<Icon name="Plus" size={16} color={token("muted-foreground")} />
					</Button>
					{props.runConfig ? <ComposerRunConfig {...props.runConfig} /> : null}
					{props.runConfig ? (
						<ComposerContextUsage
							usage={() => config()?.session ?? null}
							contextWindow={() => config()?.model?.contextWindow}
						/>
					) : null}
					<ComposerActions
						sendMode={() => state().sendMode}
						onSendModeChange={(mode) => store.setSendMode(mode)}
						running={running}
						hasContent={hasContent}
						blocked={blocked}
						sending={() => state().sending}
						sendShortcut={() => (modEnter() ? "mod-enter" : "enter")}
						onSend={submit}
						onStop={() => void store.stop()}
					/>
				</View>
				{() =>
					state().dragging ? (
						<View
							testID="chat-composer-drop"
							class="absolute inset-0 z-20 items-center justify-center rounded-(--pilo-composer-radius) bg-background/90 px-3"
						>
							<Text class="font-sans text-sm text-foreground">
								{() => t("chat.dropFiles")}
							</Text>
						</View>
					) : null
				}
			</View>
			{() => {
				if (!focused()) return null;
				// A click on a non-focusable view doesn't blur native inputs on Windows.
				return (
					<Overlay
						anchor={surface()}
						style={{ width: 0, height: 0, pointerEvents: "box-none" }}
						onPressOutside={() => input?.blur()}
					>
						{() =>
							menuOpen() ? (
								<Overlay
									anchor={anchor()}
									placement="top"
									align="start"
									offset={4}
									onCancel={() => dismissed.set(true)}
								>
									<View class="w-80 overflow-hidden rounded-(--pilo-radius-md) border border-border bg-popover shadow-md">
										{items().map((suggestion, i) => (
											<View
												class={[
													"flex-row items-center gap-2 px-3 py-2",
													i === index() ? "bg-hover" : "",
												].join(" ")}
											>
												<View class="min-w-0 flex-1">
													<Text class="font-sans truncate text-sm text-foreground">
														{() => suggestion.label}
													</Text>
													{suggestion.detail ? (
														<Text class="font-sans truncate text-xs text-muted-foreground">
															{() => suggestion.detail ?? ""}
														</Text>
													) : null}
												</View>
											</View>
										))}
									</View>
								</Overlay>
							) : null
						}
					</Overlay>
				);
			}}
		</View>
	);
}

function AttachmentChip(props: {
	label: string;
	removeLabel: string;
	icon: "File" | "MessageSquare";
	onRemove: () => void;
}) {
	return (
		<View class="h-7 flex-row items-center gap-1 rounded-(--pilo-radius-sm) border border-border bg-muted px-2">
			<Icon name={props.icon} size={12} color={token("muted-foreground")} />
			<Text class="max-w-48 truncate font-sans text-xs text-foreground">
				{() => props.label}
			</Text>
			<Button
				variant="ghost"
				size="icon"
				class="h-4 w-4"
				accessibilityLabel={props.removeLabel}
				onPress={props.onRemove}
			>
				<Icon name="X" size={12} color={token("muted-foreground")} />
			</Button>
		</View>
	);
}

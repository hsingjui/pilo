import {
	type Bounds,
	type InputRef,
	Overlay,
	Text,
	View,
	cleanup,
	computed,
	effect,
	keymap,
	signal,
} from "nsh";
import { Picker } from "nsh";

import {
	DEFAULT_SUGGESTIONS,
	activeSuggestionQuery,
	type ComposerSuggestion,
} from "@/lib/chat/composer-suggestions";
import { formatChatImageSize } from "@/lib/chat/chat-submission";
import { sessionMentionValue } from "@/lib/chat/session-mentions";
import type { ComposerSendMode } from "@/lib/chat/send-mode";
import type { SendMessageShortcut } from "@/lib/host-preferences-types";

import { APP_SHORTCUTS } from "../shortcuts";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import type { ComposerStore } from "./composer-store";

const SEND_MODES: { value: ComposerSendMode; title: string }[] = [
	{ value: "steer", title: "Steer" },
	{ value: "follow_up", title: "Follow up" },
	{ value: "send_now", title: "Send now" },
];

export interface ChatComposerProps {
	/** The open chat's composer state and actions. */
	store: ComposerStore;
	/** The configured submit shortcut; Enter submits by default. */
	sendShortcut?: () => SendMessageShortcut | undefined;
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
	const debounce = signal<ReturnType<typeof setTimeout> | null>(null);
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

	const menuOpen = () => items().length > 0 && !dismissed();

	// While the menu shows, its keys are bound over the input's own
	// (`when: "always"`): a native input keeps its arrows from `onKeyPress`.
	effect(() => {
		const list = items();
		index.set(0);
		if (!list.length) {
			dismissed.set(false);
			return;
		}
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
		if (!modEnter()) return;
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
		void Picker.pickFiles({ multiple: true })
			.then((picked) =>
				store.addFiles(
					picked.flatMap((entry) => (entry.file ? [entry.file] : [])),
				),
			)
			.catch((error: unknown) =>
				store.setStatus(
					`无法选择文件：${error instanceof Error ? error.message : String(error)}`,
				),
			);
	};

	const arrowKeys = (direction: "older" | "newer") => {
		void store.navigateHistory(direction);
	};

	effect(() => {
		cleanup(
			keymap.bind(
				{
					up: () => {
						if (!menuOpen()) arrowKeys("older");
					},
					down: () => {
						if (!menuOpen()) arrowKeys("newer");
					},
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

	return (
		<View
			testID="chat-composer"
			class="relative border-t border-border bg-background px-3 pb-3 pt-2"
			onFileDragEnter={() => store.setDragging(true)}
			onFileDragLeave={() => store.setDragging(false)}
			onFileDrop={({ uris }) => {
				store.setDragging(false);
				void store.addUris(uris);
			}}
		>
			{() => (
				<View
					class={[
						"rounded-(--pilo-radius-md) border bg-input-field",
						state().dragging ? "border-primary" : "border-input-border",
					].join(" ")}
				>
					{attachments().images.length > 0 ||
					attachments().references.length > 0 ? (
						<View class="flex-row flex-wrap gap-2 px-2 pt-2">
							{attachments().images.map((image) => (
								<AttachmentChip
									label={`${image.name} (${formatChatImageSize(image.size)})`}
									icon="File"
									onRemove={() => store.removeImage(image.id)}
								/>
							))}
							{attachments().references.map((reference, i) => (
								<AttachmentChip
									label={reference.path.split("/").pop() ?? reference.path}
									icon={reference.kind === "session" ? "MessageSquare" : "File"}
									onRemove={() => store.removeReference(i)}
								/>
							))}
						</View>
					) : null}
					<Input
						ref={(ref) => {
							input = ref;
						}}
						testID="chat-composer-input"
						multiline
						autoCorrect={false}
						autoCapitalize="none"
						submitBehavior={modEnter() ? "newline" : "submit"}
						pasteBehavior="insert"
						value={state().value}
						placeholder="发送消息，@ 提及文件或会话，/ 命令"
						class="max-h-40 border-0 bg-transparent px-3 py-2 text-sm"
						onChange={({ value }) => store.setValue(value)}
						onSelectionChange={({ end }) => store.setCaret(end)}
						onCaretMove={({ pageBounds }) => anchor.set(pageBounds)}
						onCompositionChange={({ composing }) =>
							store.setComposing(composing)
						}
						onSubmit={() => submit()}
						onPaste={({ files, uris }) => {
							if (files.length) void store.addFiles(files);
							if (uris.length) void store.addUris(uris);
						}}
					/>
					<View class="flex-row items-center gap-2 px-2 pb-2">
						<Button
							variant="ghost"
							size="icon"
							accessibilityLabel="添加附件"
							onPress={pickFiles}
						>
							<Icon name="Plus" size={16} />
						</Button>
						{running() ? (
							<Select
								items={SEND_MODES}
								value={state().sendMode}
								onChange={({ value }) =>
									value && store.setSendMode(value as ComposerSendMode)
								}
								class="h-7 w-32"
							/>
						) : null}
						{state().status ? (
							<Text class="flex-1 truncate text-xs text-destructive">
								{() => state().status ?? ""}
							</Text>
						) : (
							<View class="flex-1" />
						)}
						<Button
							size="icon"
							accessibilityLabel={running() ? "停止" : "发送"}
							disabled={running() ? false : !hasContent()}
							onPress={() => (running() ? void store.stop() : submit())}
						>
							<Icon name={running() ? "Square" : "Send"} size={16} />
						</Button>
					</View>
				</View>
			)}
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
										<Text class="truncate text-sm text-foreground">
											{() => suggestion.label}
										</Text>
										{suggestion.detail ? (
											<Text class="truncate text-xs text-muted-foreground">
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
		</View>
	);
}

function AttachmentChip(props: {
	label: string;
	icon: "File" | "MessageSquare";
	onRemove: () => void;
}) {
	return (
		<View class="h-7 flex-row items-center gap-1 rounded-(--pilo-radius-sm) border border-border bg-muted px-2">
			<Icon name={props.icon} size={12} />
			<Text class="max-w-48 truncate text-xs text-foreground">
				{() => props.label}
			</Text>
			<Button
				variant="ghost"
				size="icon"
				class="h-4 w-4"
				accessibilityLabel="移除附件"
				onPress={props.onRemove}
			>
				<Icon name="X" size={12} />
			</Button>
		</View>
	);
}

import {
	cleanup,
	computed,
	effect,
	signal,
	token,
	View,
	untracked,
	type Accessor,
} from "nsh";
import {
	createRichEditor,
	defineExtension,
	Document,
	focus,
	HardBreak,
	History,
	insertContentAt,
	Paragraph,
	RichEditor,
	RichEditorPlugin,
	richExtension,
	type RichEditorRef,
	type RichEditorSession,
	type RichNodeJSON,
	type RichRange,
} from "nsh/base";

import type { ChatMention } from "@shared/chat/chat-mentions";
import {
	chatImageReferences,
	type ChatImageAttachment,
} from "@shared/chat/chat-submission";
import type { SessionMention } from "@shared/chat/session-mentions";
import { t } from "../shell/i18n";
import {
	ChatMediaActions,
	chatAttachmentImage,
} from "../chat/chat-media-actions";
import {
	ChatMentionInline,
	type InlineMentionKind,
} from "../chat/chat-mention-inline";
import type { ChatReadingFont } from "../chat/chat-reading-font";
import { chatPx } from "../chat/layout";
import {
	activeRichSuggestion,
	buildRichImageInsertNodes,
	CHAT_MENTION_NODE_TYPE,
	createMentionNode,
	findRichImageRemovalRanges,
	richDocEndPos,
	richDocImageIds,
	richDocImageOffsets,
	remapRichImageOffsets,
	sliceToPlainText,
	richDocToValue,
	valueToRichDoc,
	type RichSuggestionMatch,
} from "./composer-rich-doc";

export interface ComposerRichInputHandle {
	focus: () => void;
	blur: () => void;
	focusEnd: () => void;
	insertMentionAt: (range: RichRange, mention: ChatMention) => void;
	insertTextAt: (range: RichRange, text: string) => void;
	insertText: (text: string) => void;
	/** 替换整篇草稿并保留原生 Cmd/Ctrl+Z 撤销栈（用于草稿优化、采纳输入建议）。 */
	replaceValueWithHistory: (value: string) => void;
	submissionText: () => string | undefined;
}

export interface ComposerRichInputProps {
	testID?: string;
	sessionKey: Accessor<string | null>;
	projectId: Accessor<string | null>;
	value: Accessor<string>;
	images: Accessor<readonly ChatImageAttachment[]>;
	sessionsByValue: Accessor<ReadonlyMap<string, SessionMention>>;
	readingFont: Accessor<ChatReadingFont>;
	disabled: Accessor<boolean>;
	placeholder: Accessor<string | undefined>;
	accessibilityLabel: Accessor<string>;
	height: Accessor<number>;
	paddingVertical: Accessor<number>;
	paddingRight: Accessor<number>;
	modEnter: Accessor<boolean>;
	menuOpen: Accessor<boolean>;
	canPickSuggestion: Accessor<boolean>;
	canAdoptGhost: Accessor<boolean>;
	canNavigateHistory: Accessor<boolean>;
	onHandle?: (handle: ComposerRichInputHandle) => () => void;
	onValueChange: (value: string) => void;
	onRemoveImage: (id: string) => void;
	onSuggestionChange: (match: RichSuggestionMatch | null) => void;
	onContentHeightChange: (height: number) => void;
	onFocusChange: (focused: boolean) => void;
	onCompositionChange: (composing: boolean) => void;
	onSubmit: () => void;
	onMenuKey: (
		key: "ArrowUp" | "ArrowDown" | "Tab" | "Enter" | "Escape",
	) => void;
	onHistoryKey: (direction: "older" | "newer") => void;
	onGhostKey: (key: "Tab" | "Escape") => void;
	onPasteFiles: (files: readonly File[], uris: readonly string[]) => void;
}

function resolveMentionKind(raw: unknown): InlineMentionKind {
	if (raw === "session" || raw === "image") return raw;
	return "file";
}

/**
 * 基于 nsh 原生 `RichEditor` 的聊天输入框：
 * - 仅启用纯文本段落与内联原子 mention 节点（关闭所有 Markdown 富文本格式）；
 * - 上传图片、`@文件` 和 `@会话` 在输入框内均以「图标/小缩略图 + 名称 + 悬停完整路径/详情 + 可点击态」内联渲染；
 * - 向上仍同步现有的纯文本草稿协议（`@"path"` / `@sessionPath`）与独立图片列表 `images`。
 */
const emptySessions: ReadonlyMap<string, SessionMention> = new Map();

type ImageLayout = { value: string; offsets: Map<string, number> };

export function ComposerRichInput(props: ComposerRichInputProps) {
	const keys = computed(() => [props.sessionKey()]);
	const imageLayouts = new Map<string | null, ImageLayout>();
	return (
		<Each of={keys()} key={(key) => key ?? ""}>
			{(key) => (
				<SessionRichInput
					input={props}
					sessionKey={untracked(key)}
					projectId={untracked(props.projectId)}
					imageLayouts={imageLayouts}
				/>
			)}
		</Each>
	);
}

function SessionRichInput(session: {
	input: ComposerRichInputProps;
	sessionKey: string | null;
	projectId: string | null;
	imageLayouts: Map<string | null, ImageLayout>;
}) {
	const props = session.input;
	const media = ChatMediaActions();
	const { sessionKey, imageLayouts } = session;
	const isCurrent = () => props.sessionKey() === sessionKey;
	const focused = signal(false);
	const composing = signal(false);
	const imageUrls = new WeakMap<ChatImageAttachment, string>();
	const imageUrlById = computed(
		() =>
			new Map(
				props.images().map((image) => {
					let url = imageUrls.get(image);
					if (!url) {
						url = `data:${image.mimeType};base64,${image.data}`;
						imageUrls.set(image, url);
					}
					return [image.id, url];
				}),
			),
	);

	// 1) 回车优先选中补全项；没有候选时按发送偏好处理，Shift-Enter 保持原生换行。
	const handleEnter = () => {
		if (!isCurrent() || props.disabled() || composing() || editor.composing)
			return;
		if (props.canPickSuggestion()) props.onMenuKey("Enter");
		else props.onSubmit();
	};
	const enterSubmitPlugin = new RichEditorPlugin("composer-enter-submit");
	enterSubmitPlugin.captureKeys(["Enter"], handleEnter);

	const modEnterSubmitPlugin = new RichEditorPlugin(
		"composer-mod-enter-submit",
	);
	modEnterSubmitPlugin.captureKeys(["Mod-Enter"], handleEnter);

	// 2) 补全菜单打开时接管 Tab/Escape。
	const menuPlugin = new RichEditorPlugin("composer-suggestion-menu");
	menuPlugin.captureKeys(["Tab", "Escape"], (key) => {
		if (!isCurrent() || props.disabled()) return;
		if (key === "Tab" || key === "Escape") props.onMenuKey(key);
	});

	// 3) 回填的历史可能是多行或以 / 开头，仍要能继续用上下键翻阅。
	const arrowPlugin = new RichEditorPlugin("composer-arrows");
	arrowPlugin.captureKeys(["ArrowUp", "ArrowDown"], (key) => {
		if (!isCurrent() || props.disabled() || composing() || editor.composing)
			return;
		if (key !== "ArrowUp" && key !== "ArrowDown") return;
		if (props.canNavigateHistory()) {
			props.onHistoryKey(key === "ArrowUp" ? "older" : "newer");
		} else if (props.menuOpen()) {
			props.onMenuKey(key);
		}
	});

	// 4) 预测提示插件：仅可按 Tab 采纳预测时接管 Tab / Escape。
	const ghostPlugin = new RichEditorPlugin("composer-ghost");
	ghostPlugin.captureKeys(["Tab", "Escape"], (key) => {
		if (!isCurrent() || props.disabled()) return;
		if (key === "Tab" || key === "Escape") props.onGhostKey(key);
	});

	// 5) 纯文本粘贴净化插件：避免网页 HTML/Markdown 样式混入聊天框，并自动还原已有的 @ 引用。
	const pastePlugin = new RichEditorPlugin("composer-plain-paste");
	pastePlugin.transformPasted((slice) => {
		const text = sliceToPlainText(slice);
		const doc = valueToRichDoc(text, props.sessionsByValue());
		return {
			content: doc.content ?? [],
			openStart: 1,
			openEnd: 1,
		};
	});

	const chatMentionExtension = defineExtension({
		name: CHAT_MENTION_NODE_TYPE,
		priority: 200,
		node: {
			inline: true,
			group: "inline",
			atom: true,
			selectable: true,
			attrs: {
				kind: { default: "file" },
				path: { default: "" },
				label: { default: "" },
				detail: { default: "" },
				raw: { default: "" },
			},
			renderText: "{raw}",
		},
		addNodeView: () => (nodeProps) => (
			<View style={{ verticalAlign: "middle" }}>
				{() => {
					const attrs = nodeProps.node.attrs;
					const kind = resolveMentionKind(attrs.kind);
					const path = String(attrs.path ?? "");
					const label = String(attrs.label ?? "");
					return (
						<ChatMentionInline
							testID={`chat-composer-mention:${kind}`}
							kind={kind}
							label={label}
							path={path}
							detail={String(attrs.detail ?? "") || undefined}
							imageUrl={kind === "image" ? imageUrlById().get(path) : undefined}
							fontSize={props.readingFont().fontSize}
							fontFamily={props.readingFont().fontFamily}
							selected={nodeProps.selected}
							accessibilityLabel={
								kind === "image"
									? t("chat.viewImage", { name: label })
									: kind === "file"
										? t("chat.openFile", { path })
										: undefined
							}
							onPress={
								kind === "session"
									? undefined
									: () => {
											if (!isCurrent()) return;
											if (kind === "file") {
												media.openFile?.(path);
											} else if (media.openImage) {
												const image = props
													.images()
													.find((entry) => entry.id === path);
												if (image) media.openImage(chatAttachmentImage(image));
											}
										}
							}
						/>
					);
				}}
			</View>
		),
	});

	// 高优先级扩展：让按键拦截与纯文本粘贴插件排在 core keymap 之前，确保 Enter / Mod-Enter 可被接管。
	const composerBehaviorExtension = defineExtension({
		name: "composerBehavior",
		priority: 1000,
		addProseMirrorPlugins: () => [
			menuPlugin,
			enterSubmitPlugin,
			modEnterSubmitPlugin,
			arrowPlugin,
			ghostPlugin,
			pastePlugin,
		],
	});

	const initialValue = props.value();
	const initialImages = props.images();
	const makeDoc = (
		value: string,
		sessions: ReadonlyMap<string, SessionMention>,
		images: readonly ChatImageAttachment[],
	) => {
		const layout = imageLayouts.get(sessionKey);
		return valueToRichDoc(
			value,
			sessions,
			images,
			layout && remapRichImageOffsets(layout.value, value, layout.offsets),
		);
	};
	let lastSyncedValue = initialValue;
	let lastSessions = initialValue.includes("@")
		? props.sessionsByValue()
		: undefined;
	const initialDoc = makeDoc(
		initialValue,
		lastSessions ?? emptySessions,
		initialImages,
	);
	let knownDocImageIds = new Set(richDocImageIds(initialDoc));
	const end = richDocEndPos(initialDoc);

	const editor: RichEditorSession = createRichEditor({
		extensions: [
			composerBehaviorExtension,
			Document,
			Paragraph,
			richExtension("text"),
			HardBreak,
			History,
			chatMentionExtension,
		],
		doc: initialDoc,
		selection: { type: "text", anchor: end, head: end },
		editable: !props.disabled(),
	});

	let syncedRevision = editor.revision;
	const rememberLayout = (doc: RichNodeJSON, value: string) => {
		if (knownDocImageIds.size) {
			imageLayouts.set(sessionKey, {
				value,
				offsets: richDocImageOffsets(doc),
			});
		} else imageLayouts.delete(sessionKey);
	};
	let suggestionRevision = -1;
	let suggestionDisabled = false;
	const syncSuggestion = (doc?: RichNodeJSON) => {
		if (!isCurrent()) return;
		const revision = editor.revision;
		const disabled = props.disabled();
		// A document edit can emit both update and selectionUpdate.
		if (revision === suggestionRevision && disabled === suggestionDisabled)
			return;
		suggestionRevision = revision;
		suggestionDisabled = disabled;
		const noTrigger =
			revision === syncedRevision &&
			!lastSyncedValue.includes("@") &&
			!lastSyncedValue.trimStart().startsWith("/");
		props.onSuggestionChange(
			disabled || noTrigger
				? null
				: activeRichSuggestion(doc ?? editor.doc, editor.selection),
		);
	};

	const removeImageNodes = (doc: RichNodeJSON, ids: ReadonlySet<string>) => {
		const ranges = findRichImageRemovalRanges(doc, ids);
		if (!ranges.length) return;
		editor.dispatch({
			steps: ranges
				.reverse()
				.map(({ from, to }) => ({ stepType: "replace", from, to })),
			meta: { addToHistory: false },
		});
	};

	const syncFromEditor = () => {
		if (!isCurrent() || props.disabled() || editor.revision === syncedRevision)
			return;
		let doc = editor.doc;
		const docIds = new Set(richDocImageIds(doc));
		const attachedIds = new Set(props.images().map((image) => image.id));
		// Undo may restore a node whose attachment was already discarded.
		const missing = new Set([...docIds].filter((id) => !attachedIds.has(id)));
		if (missing.size) {
			removeImageNodes(doc, missing);
			for (const id of missing) docIds.delete(id);
			doc = editor.doc;
		}
		const removedIds = [...knownDocImageIds].filter(
			(id) => !docIds.has(id) && attachedIds.has(id),
		);
		knownDocImageIds = docIds;
		syncedRevision = editor.revision;
		const nextValue = richDocToValue(doc);
		rememberLayout(doc, nextValue);
		if (nextValue !== lastSyncedValue) {
			lastSyncedValue = nextValue;
			props.onValueChange(nextValue);
		}
		// A file read may finish before its new image has been inserted into the document.
		for (const id of removedIds) props.onRemoveImage(id);
		syncSuggestion();
	};

	const stopUpdate = editor.on("update", syncFromEditor);
	const stopSelection = editor.on("selectionUpdate", () => syncSuggestion());
	const stopFocus = editor.on("focus", () => {
		if (!isCurrent()) return;
		focused.set(true);
		props.onFocusChange(true);
		syncSuggestion();
	});
	const stopBlur = editor.on("blur", () => {
		if (!isCurrent()) return;
		focused.set(false);
		props.onFocusChange(false);
	});

	// 动态同步各个按键拦截插件的启用状态。
	effect(() => {
		const active = focused() && !props.disabled() && !composing();
		const menu = props.menuOpen();
		menuPlugin.capturing = active && menu;
		enterSubmitPlugin.capturing =
			active && (!props.modEnter() || props.canPickSuggestion());
		modEnterSubmitPlugin.capturing = active && props.modEnter();
		arrowPlugin.capturing = active && (menu || props.canNavigateHistory());
		ghostPlugin.capturing = active && !menu && props.canAdoptGhost();
	});

	// 同步可编辑态。
	effect(() => {
		editor.setEditable(!props.disabled());
	});

	// Sync external draft changes without adding them to native undo history.
	effect(() => {
		const nextValue = props.value();
		props.images();
		const sessions = nextValue.includes("@")
			? props.sessionsByValue()
			: undefined;
		const disabled = props.disabled();
		untracked(() => {
			if (!isCurrent()) return;
			if (
				nextValue === lastSyncedValue &&
				sessions === lastSessions &&
				!disabled
			) {
				syncFromEditor();
				// A native edit can change the store while the effect is running.
				if (props.value() !== nextValue) return;
			}
			const nextImages = props.images();
			if (nextValue !== lastSyncedValue || sessions !== lastSessions) {
				const doc = editor.doc;
				const nextDoc = makeDoc(
					nextValue,
					sessions ?? emptySessions,
					nextImages,
				);
				lastSyncedValue = nextValue;
				lastSessions = sessions;
				if (JSON.stringify(doc) !== JSON.stringify(nextDoc)) {
					const end = richDocEndPos(nextDoc);
					editor.dispatch({
						steps: [
							{
								stepType: "replace",
								from: 0,
								to: richDocEndPos(doc) + 1,
								slice: { content: nextDoc.content },
							},
						],
						selection: { type: "text", anchor: end, head: end },
						meta: { addToHistory: false },
					});
				}
			} else {
				const doc = editor.doc;
				const docIds = new Set(richDocImageIds(doc));
				const nextIds = new Set(nextImages.map((image) => image.id));
				const removedIds = new Set(
					[...docIds].filter((id) => !nextIds.has(id)),
				);
				const addedImages = nextImages.filter((image) => !docIds.has(image.id));
				if (removedIds.size === 0 && addedImages.length === 0) {
					syncSuggestion();
					return;
				}
				removeImageNodes(doc, removedIds);
				if (addedImages.length) {
					const selection = editor.selection;
					const pos =
						selection.type === "text"
							? (selection.head ?? selection.anchor)
							: undefined;
					const insertPos = pos ?? richDocEndPos(editor.doc);
					editor.run(
						insertContentAt(
							insertPos,
							buildRichImageInsertNodes(editor.doc, insertPos, addedImages),
							{ updateSelection: true },
						),
					);
				}
			}
			const doc = editor.doc;
			syncedRevision = editor.revision;
			knownDocImageIds = new Set(richDocImageIds(doc));
			const docValue = richDocToValue(doc);
			if (docValue !== lastSyncedValue) {
				lastSyncedValue = docValue;
				if (!disabled) props.onValueChange(docValue);
			}
			if (!disabled) rememberLayout(doc, lastSyncedValue);
			syncSuggestion(doc);
		});
	});

	let editorRef: RichEditorRef | undefined;
	const handle: ComposerRichInputHandle = {
		focus: () => {
			// Focus the mounted view directly instead of queuing a session request.
			if (isCurrent() && !props.disabled()) editorRef?.focus();
		},
		blur: () => {
			if (isCurrent()) editorRef?.blur();
		},
		focusEnd: () => {
			editor.run(focus("end"));
		},
		insertMentionAt: (range, mention) => {
			editor.run(
				insertContentAt(
					range,
					[createMentionNode(mention), { type: "text", text: " " }],
					{ updateSelection: true },
				),
			);
			syncFromEditor();
			editor.focus();
		},
		insertTextAt: (range, text) => {
			editor.run(
				insertContentAt(
					range,
					{ type: "text", text },
					{ updateSelection: true },
				),
			);
			syncFromEditor();
			editor.focus();
		},
		insertText: (text) => {
			editor.insertContent(text, "text");
			syncFromEditor();
		},
		replaceValueWithHistory: (value) => {
			if (!isCurrent() || props.disabled()) return;
			const doc = editor.doc;
			const sessions = value.includes("@")
				? props.sessionsByValue()
				: emptySessions;
			const nextDoc = makeDoc(value, sessions, props.images());
			const nextEnd = richDocEndPos(nextDoc);
			editor.dispatch({
				steps: [
					{
						stepType: "replace",
						from: 0,
						to: richDocEndPos(doc) + 1,
						slice: { content: nextDoc.content },
					},
				],
				selection: { type: "text", anchor: nextEnd, head: nextEnd },
			});
			syncFromEditor();
		},
		submissionText: () => {
			const images = props.images();
			if (images.length === 0) return;
			const value = props.value();
			const references = chatImageReferences(images, (reference) =>
				t("chat.imageReference", reference),
			);
			// Keep slash commands at the beginning, and never read a stale editor.
			if (
				value.trimStart().startsWith("/") ||
				!isCurrent() ||
				value !== lastSyncedValue
			) {
				return [value.trimEnd(), ...references.values()].join("\n");
			}
			const text = richDocToValue(editor.doc, (id) => {
				const reference = references.get(id);
				references.delete(id);
				return reference ?? "";
			});
			return [text.trimEnd(), ...references.values()].join("\n");
		},
	};
	const releaseHandle = props.onHandle?.(handle);

	cleanup(() => {
		stopUpdate();
		stopSelection();
		stopFocus();
		stopBlur();
		releaseHandle?.();
		menuPlugin.dispose();
		enterSubmitPlugin.dispose();
		modEnterSubmitPlugin.dispose();
		arrowPlugin.dispose();
		ghostPlugin.dispose();
		pastePlugin.dispose();
		editor.dispose();
	});

	const textStyle = () => ({
		fontFamily: props.readingFont().fontFamily,
		fontSize: props.readingFont().fontSize,
		lineHeight: Math.max(
			chatPx(20),
			Math.round(props.readingFont().fontSize * 1.35),
		),
		color: token("input-foreground"),
	});

	return (
		<RichEditor
			ref={(ref) => {
				editorRef = ref;
			}}
			testID={props.testID}
			editor={editor}
			editable={!props.disabled()}
			placeholder={props.placeholder() ?? null}
			showOnlyWhenEditable={false}
			accessibilityLabel={props.accessibilityLabel()}
			class="min-w-0 flex-1 border-0 bg-transparent"
			style={{
				height: props.height(),
				minHeight: 0,
			}}
			styles={{
				root: {
					backgroundColor: "transparent",
					borderWidth: 0,
				},
				content: {
					paddingTop: props.paddingVertical(),
					paddingBottom: props.paddingVertical(),
					paddingLeft: chatPx(4),
					paddingRight: chatPx(props.paddingRight()),
				},
				placeholder: {
					color: token("input-placeholder"),
					fontFamily: props.readingFont().fontFamily,
					fontSize: props.readingFont().fontSize,
				},
				caret: {
					backgroundColor: token("input-foreground"),
				},
				nodes: {
					paragraph: {
						...textStyle(),
						marginTop: 0,
						marginBottom: 0,
						paddingTop: 0,
						paddingBottom: 0,
					},
				},
			}}
			onContentSizeChange={({ contentSize }) => {
				props.onContentHeightChange(contentSize.height);
			}}
			onCompositionChange={({ composing: isComposing }) => {
				if (!isCurrent()) return;
				composing.set(isComposing);
				props.onCompositionChange(isComposing);
			}}
			onPasteFiles={({ paste }) => {
				if (!isCurrent() || props.disabled()) return;
				const files = paste.files.map(
					(entry) =>
						new File([entry.data], entry.name || "file", {
							type: entry.mime || "application/octet-stream",
						}),
				);
				if (files.length || paste.uris.length) {
					props.onPasteFiles(files, paste.uris);
				}
			}}
		/>
	);
}

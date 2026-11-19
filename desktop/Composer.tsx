// M0 spike 3: the chat composer two ways, side by side, with the events each
// reports: a multiline `Input` (plain text) and a `RichEditor` (a document
// with mention nodes). Run with `nsh run Composer.tsx`.
import type { Bounds, InputRef, JSX } from "nsh";
import {
	cleanup,
	computed,
	effect,
	keymap,
	mount,
	Overlay,
	signal,
	Text,
	View,
} from "nsh";
import {
	Button,
	createRichEditor,
	Input,
	insertMention,
	RichEditor,
	RichEditorPlugin,
	setSuggestionOpen,
	starterKit,
	starterSchema,
	suggestion,
	withMention,
} from "nsh/base";

const FILES = [
	"src/App.tsx",
	"src/lib/chat/conversation-reducer.ts",
	"src-tauri/src/lib.rs",
	"README.md",
	"中文文档.md",
];

function matching(query: string): string[] {
	const needle = query.toLowerCase();
	return FILES.filter((file) => file.toLowerCase().includes(needle));
}

/** What the composers reported, newest first. */
const log = signal<string[]>([]);
function report(source: string, line: string) {
	log.update((lines) => [`${source}: ${line}`, ...lines].slice(0, 14));
}

function Candidates(props: {
	files: string[];
	index: number;
	onPick: (file: string) => void;
}) {
	return (
		<View
			role="listbox"
			class="w-80 rounded-(--radius) border border-border bg-popover p-1 shadow-lg"
		>
			<Each of={props.files}>
				{(file, i) => (
					<Button
						role="option"
						onPress={() => props.onPick(file())}
						class="rounded-(--radius) px-2 py-1 hover:bg-accent"
						classList={{ "bg-accent": i() === props.index }}
					>
						<Text class="text-sm text-popover-foreground">{file()}</Text>
					</Button>
				)}
			</Each>
		</View>
	);
}

function Attachments(props: { names: string[] }) {
	return (
		<View class="flex-row flex-wrap gap-1">
			<Each of={props.names}>
				{(name) => (
					<View class="rounded-(--radius) bg-muted px-2 py-1">
						<Text class="text-xs text-muted-foreground">{name()}</Text>
					</View>
				)}
			</Each>
		</View>
	);
}

function Panel(props: { title: string; children?: JSX.Element }) {
	return (
		<View class="flex-1 gap-2 rounded-(--radius) border border-border bg-card p-3">
			<Text class="text-sm font-semibold text-foreground">{props.title}</Text>
			{props.children}
		</View>
	);
}

function InputComposer() {
	const value = signal("");
	const caret = signal(0);
	const anchor = signal<Bounds | null>(null);
	const attachments = signal<string[]>([]);
	const dragging = signal(false);
	let input: InputRef | undefined;

	// The `@query` the caret is at the end of.
	const mention = computed(() => {
		const before = value().slice(0, caret());
		const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
		return match
			? {
					start: before.length - match[1].length - 1,
					files: matching(match[1]),
				}
			: null;
	});
	const candidates = () => mention()?.files ?? [];
	const index = signal(0);
	const dismissed = signal(false);
	const open = () => candidates().length > 0 && !dismissed();
	// While the list shows, its keys are bound over the input's own
	// (`when: "always"`): a native input keeps its arrows from `onKeyPress`
	// and from a view's `captureKeys`.
	effect(() => {
		const count = candidates().length;
		index.set(0);
		dismissed.set(false);
		if (!count) return;
		const move = (by: number) => index.update((i) => (i + by + count) % count);
		cleanup(
			keymap.bind(
				{
					down: () => move(1),
					up: () => move(-1),
					tab: () => pick(candidates()[index()]),
					escape: () => dismissed.set(true),
				},
				{ when: "always", repeat: true },
			),
		);
	});
	const pick = (file: string) => {
		const open = mention();
		if (!open || !input) return;
		// `insertText` is not carried out on macOS and Windows in nsh 0.6.0
		// (it only logs), so the mention is a write of the controlled value.
		const inserted = `@${file} `;
		value.set(value().slice(0, open.start) + inserted + value().slice(caret()));
		input.setSelection(open.start + inserted.length);
		input.focus();
		report("Input", `mention ${file}`);
	};

	return (
		<Panel title="Input (multiline, plain text)">
			<View
				onFileDrop={({ uris }) => {
					dragging.set(false);
					attachments.update((names) => [...names, ...uris]);
					report("Input", `file drop ${uris.join(", ")}`);
				}}
				onFileDragEnter={() => dragging.set(true)}
				onFileDragLeave={() => dragging.set(false)}
				class="gap-2 rounded-(--radius) border border-input p-2"
				classList={{ "border-primary": dragging() }}
			>
				<Attachments names={attachments()} />
				<Input
					ref={input}
					testID="input-composer"
					multiline
					autoCorrect={false}
					autoCapitalize="none"
					submitBehavior="submit"
					value={value()}
					placeholder="Message Pi, @ mentions files"
					class="max-h-40 text-sm text-foreground"
					onChange={(e) => value.set(e.value)}
					onSelectionChange={({ end }) => caret.set(end)}
					onCaretMove={({ pageBounds }) => anchor.set(pageBounds)}
					onCompositionChange={({ composing, text }) =>
						report("Input", `composition ${composing ? "on" : "off"} "${text}"`)
					}
					onKeyPress={({ key }) => report("Input", `key ${key}`)}
					onPaste={({ files, uris, text }) => {
						if (!files.length && !uris.length)
							return report("Input", `paste text ${text.length} chars`);
						attachments.update((names) => [
							...names,
							...files.map(
								(file) => `${file.name} (${file.type}, ${file.size} B)`,
							),
							...uris,
						]);
						report("Input", `paste ${files.length} files, ${uris.length} uris`);
					}}
					onSubmit={({ text }) => {
						// Return picks the first candidate while the list is open.
						if (open()) return pick(candidates()[index()]);
						report("Input", `SEND ${JSON.stringify(text)}`);
						value.set("");
					}}
				/>
			</View>
			<If when={open() && anchor()}>
				<Overlay anchor={anchor()} placement="top" align="start" offset={4}>
					<Candidates files={candidates()} index={index()} onPick={pick} />
				</Overlay>
			</If>
		</Panel>
	);
}

function RichComposer() {
	const attachments = signal<string[]>([]);
	const dragging = signal(false);
	const files = signal<string[]>([]);
	const index = signal(0);

	// Return sends, unless the mention list (earlier in the plugins) took it.
	const send = new RichEditorPlugin("send").captureKeys(["Enter"], () => {
		report(
			"RichEditor",
			`SEND ${JSON.stringify(editor.getText())} mentions=${JSON.stringify(mentions())}`,
		);
		editor.setContent("");
	});
	send.capturing = true;
	const editor = createRichEditor({
		schema: withMention(starterSchema()),
		plugins: [
			suggestion({
				key: "mention",
				char: "@",
				decorationClass: "text-primary",
				captureKeys: ["ArrowUp", "ArrowDown", "Enter", "Tab"],
			}),
			send,
			starterKit(),
		],
	});
	const mentions = () => {
		const found: string[] = [];
		const walk = (node: {
			type?: string;
			attrs?: { id?: string };
			content?: unknown[];
		}) => {
			if (node.type === "mention" && node.attrs?.id) found.push(node.attrs.id);
			for (const child of node.content ?? []) walk(child as typeof node);
		};
		walk(editor.getJSON() as never);
		return found;
	};
	const pick = (file: string) => {
		const state = editor.suggestion("mention");
		if (!state?.active) return;
		editor.run(insertMention(state.range, file, file));
		editor.focus();
		report("RichEditor", `mention ${file}`);
	};

	let keyCount = 0;
	editor.on("transaction", () => {
		const state = editor.suggestion("mention");
		if (!state?.active) return files.set([]);
		const found = matching(state.query ?? "");
		editor.run(setSuggestionOpen(found.length > 0, "mention"));
		files.set(found);
		if (state.keyCount === keyCount) return index.set(0);
		keyCount = state.keyCount;
		if (state.lastKey === "ArrowDown")
			index.update((i) => (i + 1) % found.length);
		else if (state.lastKey === "ArrowUp")
			index.update((i) => (i + found.length - 1) % found.length);
		else if (state.lastKey === "Enter" || state.lastKey === "Tab")
			pick(found[Math.min(index(), found.length - 1)]);
	});

	return (
		<Panel title="RichEditor (document, mention nodes)">
			<View
				class="gap-2 rounded-(--radius) border border-input p-2"
				classList={{ "border-primary": dragging() }}
			>
				<Attachments names={attachments()} />
				<RichEditor
					editor={editor}
					testID="rich-composer"
					placeholder="Message Pi, @ mentions files"
					class="max-h-40 text-sm text-foreground"
					classes={{
						placeholder: "text-muted-foreground",
						nodes: { mention: "text-primary" },
					}}
					bubbleMenu={
						files().length ? (
							<Candidates files={files()} index={index()} onPick={pick} />
						) : undefined
					}
					bubbleMenuPlacement="top"
					onCompositionChange={({ composing }) =>
						report("RichEditor", `composition ${composing ? "on" : "off"}`)
					}
					onPasteFiles={({ paste }) => {
						attachments.update((names) => [
							...names,
							...paste.files.map(
								(file) => `${file.name} (${file.mime}, ${file.data.length} B)`,
							),
							...paste.uris,
						]);
						report(
							"RichEditor",
							`paste ${paste.files.length} files, ${paste.uris.length} uris`,
						);
					}}
					onFileDrop={({ uris }) => {
						dragging.set(false);
						attachments.update((names) => [...names, ...uris]);
						report("RichEditor", `file drop ${uris.join(", ")}`);
					}}
					onFileDragEnter={() => dragging.set(true)}
					onFileDragLeave={() => dragging.set(false)}
				/>
			</View>
		</Panel>
	);
}

function App() {
	return (
		<View class="flex-1 gap-3 bg-background p-4 pt-[env(safe-area-inset-top)]">
			<View class="flex-1 rounded-(--radius) border border-border p-3">
				<Text class="pb-1 text-xs font-semibold text-muted-foreground">
					EVENTS (newest first)
				</Text>
				<Each of={log()}>
					{(line) => (
						<Text class="text-xs text-foreground select-text">{line()}</Text>
					)}
				</Each>
			</View>
			<View class="flex-row gap-3">
				<InputComposer />
				<RichComposer />
			</View>
		</View>
	);
}

mount(App);

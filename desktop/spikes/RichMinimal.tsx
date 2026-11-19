// M0 spike 3 control: `RichEditor`s that add the composer's pieces one at a
// time, to find which one stops an input method from composing.
import { mount, signal, Text, View } from "nsh";
import {
	createRichEditor,
	RichEditor,
	RichEditorPlugin,
	type RichEditorSession,
	starterKit,
	starterSchema,
	suggestion,
	withMention,
} from "nsh/base";

const mention = () =>
	suggestion({
		key: "mention",
		char: "@",
		captureKeys: ["ArrowUp", "ArrowDown", "Enter", "Tab"],
	});
const send = () => {
	const plugin = new RichEditorPlugin("send").captureKeys(["Enter"], () => {});
	plugin.capturing = true;
	return plugin;
};

const VARIANTS: {
	name: string;
	editor?: () => RichEditorSession;
	class?: string;
}[] = [
	{ name: "A built-in plugin names" },
	{
		name: "B session, starterKit",
		editor: () => createRichEditor({ plugins: [starterKit()] }),
	},
	{
		name: "C + mention schema, suggestion",
		editor: () =>
			createRichEditor({
				schema: withMention(starterSchema()),
				plugins: [mention(), starterKit()],
			}),
	},
	{
		name: "D + Enter capture plugin",
		editor: () =>
			createRichEditor({
				schema: withMention(starterSchema()),
				plugins: [mention(), send(), starterKit()],
			}),
	},
	{
		name: "E as D, max-h-40 without a height",
		editor: () =>
			createRichEditor({
				schema: withMention(starterSchema()),
				plugins: [mention(), send(), starterKit()],
			}),
		class: "max-h-40",
	},
];

function Variant(props: {
	name: string;
	editor?: () => RichEditorSession;
	class?: string;
}) {
	const composing = signal("-");
	const editor = props.editor?.();
	return (
		<View class="gap-1">
			<Text class="text-xs text-muted-foreground">
				{props.name}: {composing()}
			</Text>
			<RichEditor
				editor={editor}
				plugins={editor ? undefined : ["starter", "history", "baseKeymap"]}
				placeholder="Type with an input method"
				class={`${props.class ?? "h-12"} rounded-(--radius) border border-input p-2 text-sm text-foreground`}
				classes={{ placeholder: "text-muted-foreground" }}
				onCompositionChange={({ composing: on }) =>
					composing.set(`composition ${on ? "on" : "off"}`)
				}
			/>
		</View>
	);
}

function App() {
	return (
		<View class="flex-1 gap-2 bg-background p-4 pt-[env(safe-area-inset-top)]">
			<Each of={VARIANTS}>{(variant) => <Variant {...variant()} />}</Each>
		</View>
	);
}

mount(App);

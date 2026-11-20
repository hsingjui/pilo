import {
	List,
	mount,
	openUrl,
	signal,
	Storage,
	Text,
	untracked,
	View,
} from "nsh";
import { TextView, type TextViewRef } from "nsh/base";

import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { Button } from "../ui/button";

// A 60-block reply cycling through every part the parity list names.
function block(index: number): string {
	switch (index % 10) {
		case 0:
			return `## Heading ${index}\n`;
		case 1:
			return `Paragraph ${index} with **strong**, *emphasis*, ~~strike~~ and \`inline ${index}\`.\n`;
		case 2:
			return `- item ${index}a\n- item ${index}b with a [link](https://example.com/${index})\n`;
		case 3:
			return `1. first ${index}\n2. second ${index}\n`;
		case 4:
			return `\`\`\`ts\nexport const value${index}: number = ${index};\n// comment ${index}\n\`\`\`\n`;
		case 5:
			return `| name ${index} | size |\n|---|---:|\n| a${index} | ${index} |\n| b${index} | ${index + 1} |\n`;
		case 6:
			return `> quote ${index}\n> over two lines\n`;
		case 7:
			return `Inline math $x_{${index}} + y$ and a block:\n\n$$\\sum_{i=0}^{${index}} i = \\frac{${index}(${index}+1)}{2}$$\n`;
		case 8:
			return `A [file link](file:///tmp/report-${index}.md) and a [project link](src/file-${index}.ts#L${index}) here.\n`;
		default:
			return `- [x] task ${index} done\n- [ ] task ${index + 1} open\n`;
	}
}

function doc(blocks: number): string {
	let out = "";
	for (let index = 0; index < blocks; index++) out += `${block(index)}\n`;
	return out;
}

// A reply streamed in chunks that cut syntax open mid-flight.
const streamedSource = [
	"First paragraph arrives whole, then a **bo",
	"ld phrase** that opened mid-chunk and an *ita",
	"lic tail*.\n\nA [link that was still forming](",
	"https://example.com/streamed) and `inli",
	"ne code`.\n\n",
	"| a | b |\n|---|---|\n| 1 ",
	"| 2 |\n| 3 | 4 |\n\n",
	"```ts\nconst growing: number = ",
	"42;\n```\n\n",
	"The end.",
];

const png =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAATSURBVBhXY/iPA4S4uDgYGBgYAAAA//8DAI34Uw8AAAAASUVORK5CYII=";

async function run() {
	const rows = Number(await Storage.getItem("fixture.rows")) || 10;
	const blocks = Number(await Storage.getItem("fixture.blocks")) || 60;
	const streamed = signal(0);
	const text = signal("");
	const linked = signal("linked:none");
	const selected = signal("selected:none");
	const eventMs = signal(0);
	const imageKind = signal<"none" | "data" | "remote">("none");
	let view: TextViewRef | undefined;

	// One chunk per press: the test watches the reply take shape between them.
	const stream = () => {
		if (streamed() >= streamedSource.length) return;
		const t0 = performance.now();
		text.set(text() + streamedSource[streamed()]);
		streamed.set(streamed() + 1);
		requestAnimationFrame(() => {
			eventMs.set(Math.max(eventMs(), Math.round(performance.now() - t0)));
		});
	};

	const controls: Record<string, () => void> = {
		stream,
		async select() {
			const markdown = await view?.selectedText({ format: "markdown" });
			const plain = await view?.selectedText();
			selected.set(`sel:md=${markdown ?? "null"}|plain=${plain ?? "null"}`);
		},
		async open() {
			const result = await openUrl("https://example.com/outside");
			selected.set(`opened:${result.opened}`);
		},
		imgdata: () => imageKind.set("data"),
		imgremote: () => imageKind.set("remote"),
	};

	const streamingDoc = (
		<TextView
			testID="probe-stream"
			ref={(node) => (view = node)}
			selectable
			links="report"
			codeBlockActions={[{ id: "copy" }]}
			markdown={text()}
			options={{ streaming: true }}
			onLinkPress={(event) => linked.set(`linked:${event.url}`)}
			onSelectionChange={(event) => selected.set(`selected:${event.text}`)}
		/>
	);

	mount(() => (
		<View class="flex-1 bg-background">
			<View class="flex-row items-center gap-2 px-2">
				<Each of={Object.entries(controls)}>
					{(control) => (
						<Button testID={control()[0]} size="sm" onPress={control()[1]}>
							<Text>{control()[0]}</Text>
						</Button>
					)}
				</Each>
				<Text class="font-mono text-xs text-foreground">
					{() => `streamed ${streamed()}`}
				</Text>
				<Text class="font-mono text-xs text-foreground">
					{() => `event at most ${eventMs()} ms`}
				</Text>
				<Text class="font-mono text-xs text-foreground">{linked}</Text>
				<Text class="font-mono text-xs text-foreground">{selected}</Text>
				<Text class="font-mono text-xs text-foreground">
					{() => `image ${imageKind()}`}
				</Text>
			</View>
			<TextView
				testID="probe-solo"
				selectable
				links="report"
				codeBlockActions={[{ id: "copy" }]}
				markdown={
					"Select this sentence for the probe.\n\n```ts\nexport const solo: number = 1;\n```\n\nA [stand link](https://stand.dev/x) here.\n"
				}
				onLinkPress={(event) => linked.set(`linked:${event.url}`)}
				onSelectionChange={(event) => selected.set(`selected:${event.text}`)}
			/>
			<List
				testID="probe-list"
				class="min-h-0 flex-1"
				each={Array.from({ length: rows + 1 }, (_, index) => index)}
				estimatedItemSize={96}
				initialScrollAtEnd
				maintainVisibleContentPosition={{
					autoscrollToBottomThreshold: 4,
				}}
			>
				{(index) =>
					index() === rows ? (
						streamingDoc
					) : (
						<TextView
							testID={`probe-doc-${index()}`}
							selectable
							links="report"
							codeBlockActions={[{ id: "copy" }]}
							markdown={doc(blocks)}
							options={{ streaming: index() === rows - 1 }}
							onLinkPress={(event) => linked.set(`linked:${event.url}`)}
						/>
					)
				}
			</List>
			{() =>
				imageKind() === "none" ? null : (
					<TextView
						testID="probe-image"
						markdown={`Above the image\n\n![tiny](${
							imageKind() === "data" ? png : "https://example.com/pic.png"
						})\n\nBelow the image\n`}
					/>
				)
			}
		</View>
	));
}

initializeI18n();
void run();

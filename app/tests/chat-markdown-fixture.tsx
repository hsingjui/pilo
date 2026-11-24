import { mount, signal, Storage, Text, View } from "nsh";

import { replayConversationEvents } from "@shared/chat/conversation-replay";
import { AppToaster, AppToasts, AppToastStack } from "../shell/app-toasts";
import { initializeI18n } from "../shell/i18n";
import { ChatMarkdown, type ChatMarkdownFileLink } from "../chat/chat-markdown";
import { ChatMessageList } from "../chat/chat-message-list";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { context, turn } from "./chat-conversation-fixture";

/**
 * The message list over a reply of Markdown (`fixture.scenario` `reply`, or
 * `streaming` for a reply still coming), plus the `ChatMarkdown` the shell
 * wires up — its project, image reader and link handler — under texts that
 * show what presses reported: `file:` the project file link a press
 * resolved to, `image:` the path the reader was asked for or `failed` when
 * the read threw. `plain` keeps the message's default body.
 */
const doc = [
	"## Reply heading",
	"",
	"A paragraph with **bold words** and `inline code`.",
	"",
	"- one",
	"- two",
	"",
	"| name | value |",
	"| --- | --- |",
	"| a | 1 |",
	"",
	"> a quote",
	"",
	"```ts",
	"const answer: number = 42;",
	"```",
	"",
	"Above the image",
	"",
	"![shot](./shot.png)",
	"",
	"Below the image",
	"",
	"[the project file](./src/main.ts#L10) and [`src/coded.ts:14`](src/coded.ts)",
	"",
	"Inline code `src/other.ts:20-25` and `src/prose.ts`（第 7 行）and plain text app/plain.ts:3.",
	"",
	"Non-file `console.log` stays code.",
	"",
	"[the site](https://example.com/docs)",
	"",
].join("\n");

const png =
	"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAATSURBVBhXY/iPA4S4uDgYGBgYAAAA//8DAI34Uw8AAAAASUVORK5CYII=";

function pngBytes(): Uint8Array {
	const binary = atob(png);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

async function run() {
	await initializeI18n();
	const scenario = (await Storage.getItem("fixture.scenario")) ?? "reply";
	const events =
		scenario === "streaming"
			? turn(0, "Show me Markdown.", doc).slice(0, 3)
			: turn(0, "Show me Markdown.", doc);
	const state: ChatTranscriptState = {
		sessionKey: "chat-fixture",
		status: "ready",
		conversation: replayConversationEvents(events, context()),
		historyPrefix: [],
		source: "history",
	};
	const file = signal("file:none");
	const image = signal("image:none");
	const toasts = new AppToasts();
	mount(() => (
		<AppToaster.Provider value={toasts}>
			<View class="flex-1">
				<ChatMessageList
					transcript={() => state}
					messages={() => state.conversation?.messages ?? []}
					{...(scenario === "plain"
						? {}
						: {
								assistantBody: (message) => (
									<ChatMarkdown
										text={() => message().text}
										project={() => ({ id: "p1", path: "/work/demo" })}
										readProjectImage={async (_projectId, path) => {
											if (scenario === "readerror") {
												image.set("image:failed");
												throw new Error("no file");
											}
											image.set(`image:read ${path}`);
											return pngBytes();
										}}
										onFileLink={(link: ChatMarkdownFileLink) =>
											file.set(
												`file:${link.url}#${link.lineRange ? `${link.lineRange.start}-${link.lineRange.end}` : "none"}`,
											)
										}
									/>
								),
							})}
				/>
				<View class="flex-row gap-2 p-2">
					<Text testID="file" class="text-xs">
						{() => file()}
					</Text>
					<Text testID="image-state" class="text-xs">
						{() => image()}
					</Text>
				</View>
				<AppToastStack toasts={toasts} />
			</View>
		</AppToaster.Provider>
	));
}

await run();

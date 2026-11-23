import { mount, signal, Storage, Text, View } from "nsh";

import { replayConversationEvents } from "@shared/chat/conversation-replay";
import "../shell/fonts";
import { AppToaster, AppToasts, AppToastStack } from "../shell/app-toasts";
import { initializeI18n } from "../shell/i18n";
import { ChatImageLightbox } from "../chat/chat-image-lightbox";
import { ChatMarkdown } from "../chat/chat-markdown";
import {
	ChatMediaActions,
	type ChatImagePreview,
} from "../chat/chat-media-actions";
import { ChatMessageList } from "../chat/chat-message-list";
import type { ChatTranscriptState } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { context, turn } from "./chat-conversation-fixture";

const png =
	"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAATSURBVBhXY/iPA4S4uDgYGBgYAAAA//8DAI34Uw8AAAAASUVORK5CYII=";

function pngBytes(): Uint8Array {
	const binary = atob(png);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

const markdownDoc = [
	"Above the image",
	"",
	"![shot](./shot.png)",
	"",
	"Below the image",
].join("\n");

async function run() {
	await initializeI18n();
	const scenario = (await Storage.getItem("fixture.scenario")) ?? "project";
	const preview = signal<ChatImagePreview | null>(null);
	const saved = signal("saved:none");
	const attempts = signal(0);
	const toasts = new AppToasts();

	const events = turn(0, "Show image.", markdownDoc);
	const state: ChatTranscriptState = {
		sessionKey: "lightbox-fixture",
		status: "ready",
		conversation: replayConversationEvents(events, context()),
		historyPrefix: [],
		source: "history",
	};

	const media = {
		openImage: (image: ChatImagePreview) => preview.set(image),
	};

	mount(() => (
		<AppToaster.Provider value={toasts}>
			<ChatMediaActions.Provider value={media}>
				<View class="flex-1 bg-background">
					<View class="flex-row gap-2 p-2">
						<Button
							testID="open-external"
							size="sm"
							onPress={() =>
								preview.set({
									url: "https://example.com/photo.png",
									name: "photo.png",
								})
							}
						>
							<Text class="font-sans text-xs">Open external</Text>
						</Button>
						<Text testID="saved-state" class="font-mono text-xs">
							{() => saved()}
						</Text>
						<Text testID="attempt-count" class="font-mono text-xs">
							{() => `attempts:${attempts()}`}
						</Text>
					</View>
					<ChatMessageList
						transcript={() => state}
						messages={() => state.conversation?.messages ?? []}
						assistantBody={(message) => (
							<ChatMarkdown
								text={() => message().text}
								project={() => ({ id: "p1", path: "/work/demo" })}
								readProjectImage={async () => {
									const next = attempts() + 1;
									attempts.set(next);
									if (scenario === "retry" && next === 1) {
										throw new Error("temporary failure");
									}
									return pngBytes();
								}}
							/>
						)}
					/>
					<ChatImageLightbox
						image={preview}
						onClose={() => preview.set(null)}
						onSaveImage={async (name, bytes) => {
							if (scenario === "saveerror") {
								throw new Error("disk full");
							}
							saved.set(`saved:${name}:${bytes.length}`);
							return true;
						}}
					/>
					<AppToastStack toasts={toasts} />
				</View>
			</ChatMediaActions.Provider>
		</AppToaster.Provider>
	));
}

await run();

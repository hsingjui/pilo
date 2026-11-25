import { cleanup, computed, signal } from "nsh";

import { t } from "../shell/i18n";
import { writeClipboardText } from "../ui/clipboard";
import { CopyStatusIcon } from "../ui/copy-status-icon";
import { ChatMessageAction } from "./chat-message-action";
import { chatPx } from "./layout";

export function ChatCopyButton(props: {
	text: () => string;
	compact?: boolean;
	visible?: boolean;
	testID?: string;
}) {
	type Status = "chat.copied" | "chat.copyFailed";
	const feedback = signal<{ text: string; status: Status } | null>(null);
	const status = computed(() => {
		const result = feedback();
		return result && result.text === props.text() ? result.status : undefined;
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let mounted = true;
	cleanup(() => {
		mounted = false;
		clearTimeout(timer);
	});

	async function copy() {
		const text = props.text();
		let status: Status;
		try {
			await writeClipboardText(text);
			status = "chat.copied";
		} catch {
			status = "chat.copyFailed";
		}
		if (!mounted || text !== props.text()) return;
		clearTimeout(timer);
		feedback.set({ text, status });
		timer = setTimeout(() => feedback.set(null), 1_600);
	}

	return (
		<ChatMessageAction
			compact={props.compact}
			testID={props.testID ?? "chat-copy-message"}
			label={t(status() ?? "chat.copy")}
			visible={props.visible}
			onPress={() => void copy()}
		>
			<CopyStatusIcon
				copied={() => status() === "chat.copied"}
				size={chatPx(14)}
			/>
		</ChatMessageAction>
	);
}

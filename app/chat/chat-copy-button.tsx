import {
	cleanup,
	Clipboard,
	computed,
	createMotion,
	reduceMotion,
	signal,
	View,
} from "nsh";

import { t } from "../shell/i18n";
import { Icon } from "../ui/icon";
import { ChatMessageAction } from "./chat-message-action";
import { chatPx } from "./layout";

function CopiedIcon() {
	// Same keyframes as React's chat-copy-success-pop.
	const motion = createMotion({
		enter: {
			keyframes: [
				{ offset: 0, opacity: 0, scale: 0.7 },
				{ offset: 0.55, opacity: 1, scale: 1.08 },
				{ offset: 1, opacity: 1, scale: 1 },
			],
			duration: 180,
			easing: [0.2, 0, 0, 1],
		},
	});
	cleanup(() => motion.stop());
	return (
		<View style={motion.style}>
			<Icon name="Check" size={chatPx(14)} />
		</View>
	);
}

export function ChatCopyButton(props: {
	text: () => string;
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
			await Clipboard.writeText(text);
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
			testID={props.testID ?? "chat-copy-message"}
			label={t(status() ?? "chat.copy")}
			visible={props.visible}
			onPress={() => void copy()}
		>
			{() =>
				status() === "chat.copied" ? (
					reduceMotion() ? (
						<Icon name="Check" size={chatPx(14)} />
					) : (
						<CopiedIcon />
					)
				) : (
					<Icon name="Copy" size={chatPx(14)} />
				)
			}
		</ChatMessageAction>
	);
}

import {
	computed,
	effect,
	Image,
	signal,
	Text,
	token,
	untracked,
	View,
} from "nsh";
import { Button as BaseButton } from "nsh/base";

import type { ChatConversationImage } from "@shared/chat/conversation-types";
import { t } from "../shell/i18n";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
import { Tooltip } from "../ui/tooltip";
import { ChatMediaActions } from "./chat-media-actions";

type ImageState =
	| { type: "loading" }
	| { type: "ready"; url: string }
	| { type: "error" };

/** The images a user message carries, as thumbnails that open the lightbox. */
export function ChatUserImages(props: {
	images: () => readonly ChatConversationImage[];
}) {
	return (
		<View class="max-w-full flex-row flex-wrap justify-end gap-1.5">
			<Each of={props.images()} key={(image) => image.id}>
				{(image) => <ChatUserImage image={image} />}
			</Each>
		</View>
	);
}

function ChatUserImage(props: { image: () => ChatConversationImage }) {
	const media = ChatMediaActions();
	const state = signal<ImageState>({ type: "loading" });
	const attempt = signal(0);
	const identity = computed(() => {
		const image = props.image();
		return `${image.source ?? "history"}\0${image.id}\0${image.mimeType}`;
	});
	const label = () => props.image().name || t("chat.image");
	effect(() => {
		identity();
		attempt();
		const image = untracked(props.image);
		const read = media.readUserImage;
		if (!read) {
			state.set({ type: "error" });
			return;
		}
		let live = true;
		state.set({ type: "loading" });
		read(image).then(
			(url) => live && state.set({ type: "ready", url }),
			() => live && state.set({ type: "error" }),
		);
		return () => {
			live = false;
		};
	});
	const press = () => {
		const current = state();
		if (current.type === "ready") {
			media.openImage?.({
				url: current.url,
				name: label(),
				size: props.image().size,
			});
		} else if (current.type === "error") {
			attempt.set(attempt() + 1);
		}
	};
	const pointerBlur = blurOnPointerPress();
	return (
		<BaseButton
			testID="chat-user-image"
			ref={pointerBlur.ref}
			onMouseUp={pointerBlur.onMouseUp}
			class="size-20 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-foreground/10 bg-muted/40 focus-visible:outline-hidden"
			focusVisibleStyle={focusRingStyle(token("ring"))}
			accessibilityLabel={
				state().type === "error"
					? t("chat.loadImageFailedRetry")
					: t("chat.viewImage", { name: label() })
			}
			tooltip={
				state().type === "error" ? (
					<Tooltip>
						<Text class="font-sans">
							{() => t("chat.loadImageFailedRetry")}
						</Text>
					</Tooltip>
				) : undefined
			}
			onPress={press}
		>
			{() => {
				const current = state();
				return current.type === "ready" ? (
					<Image
						src={current.url}
						accessibilityLabel={label()}
						class="size-full"
						style={{ objectFit: "cover" }}
						onError={() => state.set({ type: "error" })}
					/>
				) : current.type === "error" ? (
					<Icon name="ImageOff" size={16} color={token("muted-foreground")} />
				) : null;
			}}
		</BaseButton>
	);
}

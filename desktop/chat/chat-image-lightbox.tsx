import {
	computed,
	effect,
	Image,
	openUrl,
	Scroll,
	signal,
	Text,
	token,
	View,
	windowSize,
} from "nsh";
import { Button as BaseButton, Dialog as BaseDialog } from "nsh/base";

import { lightboxDownloadName } from "@shared/chat/chat-markdown-images";
import { formatChatImageSize } from "@shared/chat/chat-submission";

import { AppToaster } from "../app/app-toasts";
import { t } from "../app/i18n";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { Tooltip } from "../ui/tooltip";
import type { ChatImagePreview } from "./chat-media-actions";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
const ZOOM_STEP = 1.5;

function decodeBase64DataUrl(url: string): Uint8Array | null {
	const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/i.exec(url);
	if (!match) return null;
	try {
		const binary = atob(match[1]);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	} catch {
		return null;
	}
}

function clampScale(value: number): number {
	return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function LightboxIconButton(props: {
	testID?: string;
	label: () => string;
	disabled?: () => boolean;
	onPress: () => void;
	icon: Parameters<typeof Icon>[0]["name"];
}) {
	return (
		<BaseButton
			testID={props.testID}
			disabled={props.disabled?.()}
			accessibilityLabel={props.label()}
			class="size-9 items-center justify-center rounded-(--pilo-radius-md) hover:bg-white/15 disabled:opacity-40 focus-visible:outline-hidden"
			focusVisibleStyle={focusRingStyle(token("ring"))}
			tooltip={
				<Tooltip>
					<Text class="font-sans">{props.label}</Text>
				</Tooltip>
			}
			onPress={props.onPress}
		>
			<Icon name={props.icon} size={16} color="#ffffffe6" />
		</BaseButton>
	);
}

export interface ChatImageLightboxProps {
	image: () => ChatImagePreview | null;
	onClose: () => void;
	onSaveImage?: (suggestedName: string, bytes: Uint8Array) => Promise<boolean>;
}

/**
 * Full-screen image preview dialog matching the WebUI lightbox:
 * zoom controls, pan via scroll when zoomed, save for inline images and
 * external open for remote URLs.
 */
export function ChatImageLightbox(props: ChatImageLightboxProps) {
	const toasts = AppToaster();
	const scale = signal(MIN_SCALE);
	const saving = signal(false);
	const viewport = signal({ width: 0, height: 0 });

	effect(() => {
		props.image()?.url;
		scale.set(MIN_SCALE);
	});

	const downloadName = computed(() => {
		const current = props.image();
		return current ? lightboxDownloadName(current) : undefined;
	});
	const isExternal = computed(() => {
		const url = props.image()?.url;
		return Boolean(url && /^https?:\/\//i.test(url));
	});
	const canSave = computed(() => {
		const current = props.image();
		return Boolean(
			current &&
			downloadName() &&
			current.url.startsWith("data:") &&
			props.onSaveImage,
		);
	});
	const percent = computed(() => Math.round(scale() * 100));

	const zoomBy = (factor: number) => {
		scale.set(clampScale(scale() * factor));
	};
	const resetZoom = () => {
		scale.set(MIN_SCALE);
	};

	const saveCurrent = () => {
		const current = props.image();
		const fileName = downloadName();
		const save = props.onSaveImage;
		if (!current || !fileName || !save || saving()) return;
		const bytes = decodeBase64DataUrl(current.url);
		if (!bytes) {
			toasts?.show({ variant: "error", title: t("chat.imageUnavailable") });
			return;
		}
		saving.set(true);
		void save(fileName, bytes)
			.catch((error: unknown) => {
				toasts?.show({
					variant: "error",
					title: t("chat.saveImage"),
					description: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				saving.set(false);
			});
	};

	const openExternal = () => {
		const current = props.image();
		if (current && /^https?:\/\//i.test(current.url)) {
			void openUrl(current.url);
		}
	};

	const imageBox = computed(() => {
		const size = viewport();
		const fallbackWidth = Math.max(240, windowSize().width - 64);
		const fallbackHeight = Math.max(200, windowSize().height - 148);
		const baseWidth = size.width > 0 ? size.width : fallbackWidth;
		const baseHeight = size.height > 0 ? size.height : fallbackHeight;
		const currentScale = scale();
		return {
			width: Math.max(1, Math.round(baseWidth * currentScale)),
			height: Math.max(1, Math.round(baseHeight * currentScale)),
		};
	});

	return (
		<BaseDialog
			testID="chat-image-lightbox"
			open={props.image() !== null}
			animation="fade"
			accessibilityLabel={props.image()?.name || t("chat.image")}
			onOpenChange={({ open }) => {
				if (!open) props.onClose();
			}}
			backdropClass="bg-black/80"
			backdropStyle={{ zIndex: token("z-dialog-overlay") }}
			class="h-full w-full flex-col bg-transparent p-4"
			style={{
				width: windowSize().width,
				height: windowSize().height,
				zIndex: token("z-dialog"),
			}}
		>
			{() => {
				const current = props.image();
				if (!current) return null;
				const label = current.name || t("chat.image");
				return (
					<View class="min-h-0 flex-1 flex-col">
						<View class="flex-row items-center justify-between gap-3 py-1">
							<Text
								testID="lightbox-title"
								class="min-w-0 flex-1 truncate font-sans text-sm text-white/90"
							>
								{label}
							</Text>
							<View class="shrink-0 flex-row items-center gap-1">
								{current.size ? (
									<Text class="mr-1 font-sans text-xs tabular-nums text-white/70">
										{formatChatImageSize(current.size)}
									</Text>
								) : null}
								{() =>
									canSave() ? (
										<LightboxIconButton
											testID="lightbox-save"
											icon="Download"
											label={() => t("chat.saveImage")}
											disabled={saving}
											onPress={saveCurrent}
										/>
									) : isExternal() ? (
										<LightboxIconButton
											testID="lightbox-open-external"
											icon="ExternalLink"
											label={() => t("chat.openOriginalImage")}
											onPress={openExternal}
										/>
									) : null
								}
								<LightboxIconButton
									testID="lightbox-close"
									icon="X"
									label={() => t("chat.closeImage")}
									onPress={props.onClose}
								/>
							</View>
						</View>
						<View
							testID="lightbox-viewport"
							class="min-h-0 flex-1 overflow-hidden"
							onLayout={({ bounds }) =>
								viewport.set({
									width: bounds.size.width,
									height: bounds.size.height,
								})
							}
						>
							<Scroll
								class="min-h-0 flex-1"
								contentClass="min-h-full min-w-full items-center justify-center"
								horizontal={scale() > MIN_SCALE}
								bounces={false}
								scrollbar={{
									vertical: scrollbarLook(),
									horizontal: scrollbarLook(),
								}}
							>
								<View
									class="items-center justify-center"
									style={imageBox()}
									onPress={() => {
										if (scale() <= MIN_SCALE) props.onClose();
									}}
								>
									<Image
										testID="lightbox-image"
										src={current.url}
										accessibilityLabel={label}
										style={{
											width: imageBox().width,
											height: imageBox().height,
											objectFit: "contain",
										}}
									/>
								</View>
							</Scroll>
						</View>
						<View class="shrink-0 flex-row items-center justify-center gap-1 pt-2">
							<LightboxIconButton
								testID="lightbox-zoom-out"
								icon="Minus"
								label={() => t("chat.zoomOutImage")}
								disabled={() => scale() <= MIN_SCALE}
								onPress={() => zoomBy(1 / ZOOM_STEP)}
							/>
							<BaseButton
								testID="lightbox-zoom-reset"
								accessibilityLabel={t("chat.resetImageZoom", {
									percent: percent(),
								})}
								class="min-h-9 min-w-14 items-center justify-center rounded-(--pilo-radius-md) px-3 hover:bg-white/15 focus-visible:outline-hidden"
								focusVisibleStyle={focusRingStyle(token("ring"))}
								onPress={resetZoom}
							>
								<Text class="font-sans text-xs tabular-nums text-white/85">
									{() => `${percent()}%`}
								</Text>
							</BaseButton>
							<LightboxIconButton
								testID="lightbox-zoom-in"
								icon="Plus"
								label={() => t("chat.zoomInImage")}
								disabled={() => scale() >= MAX_SCALE}
								onPress={() => zoomBy(ZOOM_STEP)}
							/>
						</View>
					</View>
				);
			}}
		</BaseDialog>
	);
}

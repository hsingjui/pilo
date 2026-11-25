import {
	createAnimatedValue,
	effect,
	Image,
	reduceMotion,
	Scroll,
	Text,
	token,
	View,
	windowSize,
} from "nsh";
import { Dialog as BaseDialog } from "nsh/base";

import appIcon from "../assets/app-icon.png";
import { ChatMarkdown } from "../chat/chat-markdown";
import { ChatReadingFont, chatReadingFont } from "../chat/chat-reading-font";
import { Button } from "../ui/button";
import { DialogClose } from "../ui/dialog-close";
import { DialogDescription } from "../ui/dialog-description";
import { DialogTitle } from "../ui/dialog-title";
import { Icon } from "../ui/icon";
import { MOTION, useMountedDialog } from "../ui/motion";
import { scrollbarLook } from "../ui/scrollbar";
import { Spinner } from "../ui/spinner";
import { styleVar } from "../ui/theme-style";
import { AppToasts, AppToastStack } from "./app-toasts";
import {
	createReleaseNotes,
	type DesktopUpdate,
	formatUpdateMegabytes,
} from "./desktop-update";
import { appLocale, t } from "./i18n";

const DIALOG_MAX_WIDTH = 560;
const DIALOG_MAX_HEIGHT = 600;
const RELEASE_NOTES_FONT = chatReadingFont({ readingFontSize: 14 });
const releaseNotesFont = () => RELEASE_NOTES_FONT;

/**
 * Desktop update dialog matching the Tauri `UpdateDialog`: app icon and
 * version header, scrollable Markdown release notes fetched from GitHub
 * Releases, download/install progress bar, and close/install actions.
 */
export function UpdateDialog(props: { update: DesktopUpdate }) {
	const { update } = props;
	const toasts = new AppToasts();
	const releaseNotes = createReleaseNotes(
		update.availableVersion,
		update.releaseNotes,
		() => update.dialogOpen() && !update.previewMode(),
		{
			fetchReleaseNotes: update.fetchReleaseNotes,
			openUrl: update.openUrl,
		},
	);

	const downloading = () => update.status() === "downloading";
	const installing = () => update.status() === "installing";
	const busy = () => downloading() || installing();
	const progress = () => update.downloadProgress();
	const showDownloadSize = () =>
		downloading() && (progress() !== null || update.downloadedBytes() > 0);

	const downloadedSize = () =>
		formatUpdateMegabytes(update.downloadedBytes(), appLocale());
	const totalSize = () => {
		const total = update.downloadTotalBytes();
		return total ? formatUpdateMegabytes(total, appLocale()) : null;
	};

	const dialog = useMountedDialog(update.dialogOpen);
	const progressRatio = createAnimatedValue(0);
	effect(() => {
		const pct = progress();
		const next = pct === null ? 0 : Math.min(1, Math.max(0, pct / 100));
		if (reduceMotion()) {
			progressRatio.set(next);
		} else {
			void progressRatio.timing(next, {
				duration: MOTION.duration.calm,
				easing: MOTION.easing.standardTuple,
			});
		}
	});

	const size = () => {
		const win = windowSize();
		return {
			width: Math.min(DIALOG_MAX_WIDTH, Math.max(280, win.width - 32)),
			height: Math.min(DIALOG_MAX_HEIGHT, Math.max(320, win.height - 32)),
		};
	};

	return (
		<BaseDialog
			testID="update-dialog"
			open={update.dialogOpen()}
			animation="fade"
			accessibilityLabel={t("settings.updateDialogTitle")}
			onOpenChange={({ open }) => update.setDialogOpen(open)}
			onClose={dialog.onClose}
			class="overflow-hidden rounded-(--pilo-radius-lg) border border-border bg-background text-foreground font-sans self-center my-auto"
			style={[
				{
					...size(),
					boxShadow: styleVar("pilo-shadow-popover"),
					// Stack above SettingsDialog when opened from About.
					zIndex: token("z-dialog") + 1,
				},
			]}
			backdropClass="bg-black/40"
			backdropStyle={{ zIndex: token("z-dialog") }}
		>
			{() =>
				dialog.mounted() ? (
					<View class="relative min-h-0 flex-1">
						<View class="shrink-0 flex-row items-center gap-3 px-6 pb-5 pr-12 pt-5">
							<Image
								src={appIcon}
								testID="update-dialog-icon"
								class="size-10 shrink-0 rounded-lg"
								style={{ objectFit: "contain" }}
							/>
							<View class="min-w-0 flex-1 gap-1">
								<DialogTitle class="text-sm font-semibold leading-5">
									{() => t("settings.updateDialogTitle")}
								</DialogTitle>
								<DialogDescription class="text-xs leading-relaxed">
									{() =>
										t("settings.updateDialogDescription", {
											version: update.availableVersion() ?? "",
										})
									}
								</DialogDescription>
							</View>
						</View>

						<View class="min-h-11 shrink-0 flex-row items-center justify-between gap-3 border-y border-border/60 bg-muted/40 px-6 py-2">
							<Text class="font-sans text-xs font-medium text-muted-foreground">
								{() => t("settings.releaseNotes")}
							</Text>
							{() =>
								!update.previewMode() ? (
									<Button
										testID="update-dialog-github-releases"
										variant="ghost"
										size="sm"
										class="-mr-2 h-7 gap-1.5 px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
										onPress={() => releaseNotes.openRelease()}
									>
										<Text class="font-sans text-xs text-muted-foreground">
											GitHub Releases
										</Text>
										<Icon
											name="ExternalLink"
											size={14}
											color={token("muted-foreground")}
										/>
									</Button>
								) : null
							}
						</View>

						<Scroll
							testID="update-dialog-notes"
							class="min-h-0 flex-1"
							contentClass="px-6 py-5"
							bounces={false}
							scrollbar={{ mode: "always", vertical: scrollbarLook() }}
						>
							{() => {
								if (update.previewMode()) {
									return (
										<Text class="font-sans text-xs leading-relaxed text-muted-foreground">
											{() => t("settings.updatePreviewOnly")}
										</Text>
									);
								}
								const notes = releaseNotes.notes();
								const isLoading = releaseNotes.loading();
								const isFailed = releaseNotes.failed();
								return (
									<View class="min-w-0">
										{isLoading ? (
											<View class="mb-3 flex-row items-center gap-2">
												<Spinner size={14} color={token("muted-foreground")} />
												<Text class="font-sans text-xs text-muted-foreground">
													{() => t("settings.releaseNotesLoading")}
												</Text>
											</View>
										) : null}
										{isFailed ? (
											<Text class="mb-3 font-sans text-xs leading-relaxed text-muted-foreground">
												{() => t("settings.releaseNotesUnavailable")}
											</Text>
										) : null}
										{notes ? (
											<ChatReadingFont.Provider value={releaseNotesFont}>
												<ChatMarkdown text={() => notes} />
											</ChatReadingFont.Provider>
										) : !isLoading && !isFailed ? (
											<Text class="font-sans text-xs leading-relaxed text-muted-foreground">
												{() => t("settings.releaseNotesEmpty")}
											</Text>
										) : null}
									</View>
								);
							}}
						</Scroll>

						<View class="shrink-0 gap-3 border-t border-border/60 px-6 py-4">
							{() =>
								busy() ? (
									<View testID="update-dialog-progress" class="gap-2">
										<View class="flex-row items-center justify-between gap-3">
											<Text class="font-sans text-xs text-muted-foreground">
												{() =>
													t(
														installing()
															? "settings.installing"
															: "settings.downloading",
													)
												}
											</Text>
											{downloading() && progress() !== null ? (
												<Text
													testID="update-dialog-percent"
													class="font-mono text-xs tabular-nums text-foreground"
												>
													{() => `${progress()}%`}
												</Text>
											) : null}
										</View>
										{() => {
											const pct = progress();
											return downloading() && pct !== null ? (
												<View
													role="progressbar"
													accessibilityLabel={`${t("settings.downloading")} ${pct}%`}
													class="h-1 w-full overflow-hidden rounded-full bg-muted"
												>
													<View
														class="h-full w-full rounded-full bg-primary"
														style={{
															transformOrigin: "left center",
															transform: [{ scaleX: progressRatio }],
														}}
													/>
												</View>
											) : null;
										}}
										{showDownloadSize() ? (
											<Text
												testID="update-dialog-size"
												class="font-mono text-xs tabular-nums text-muted-foreground"
											>
												{() => {
													const total = totalSize();
													return `${downloadedSize()}${total ? ` / ${total}` : ""}`;
												}}
											</Text>
										) : null}
										<Text class="font-sans text-xs text-muted-foreground">
											{() => t("settings.updateBackgroundHint")}
										</Text>
									</View>
								) : null
							}
							{() =>
								update.error() ? (
									<Text
										testID="update-dialog-error"
										role="alert"
										class="font-sans text-xs leading-relaxed text-status-danger"
									>
										{() => update.error() ?? ""}
									</Text>
								) : null
							}
							<View class="flex-row flex-wrap justify-end gap-2">
								<Button
									testID="update-dialog-close-action"
									variant="ghost"
									size="sm"
									class="text-muted-foreground"
									onPress={() => update.setDialogOpen(false)}
								>
									<Text class="font-sans text-xs text-muted-foreground">
										{() => t("common.close")}
									</Text>
								</Button>
								<Button
									testID="update-dialog-install"
									size="sm"
									disabled={busy()}
									onPress={() =>
										void update.installUpdate((title) =>
											toasts.show({ variant: "info", title }),
										)
									}
								>
									{() =>
										busy() ? (
											<Spinner size={14} />
										) : (
											<Icon name="Download" size={14} />
										)
									}
									<Text class="font-sans text-xs text-primary-foreground">
										{() =>
											busy()
												? t(
														installing()
															? "settings.installing"
															: "settings.downloading",
													)
												: update.status() === "error"
													? t("common.retry")
													: t("settings.downloadInstall")
										}
									</Text>
								</Button>
							</View>
						</View>

						<DialogClose
							testID="update-dialog-close"
							accessibilityLabel={t("common.close")}
							onPress={() => update.setDialogOpen(false)}
						/>
						{/* Mount inside the native dialog so preview toasts render above it. */}
						<AppToastStack toasts={toasts} />
					</View>
				) : null
			}
		</BaseDialog>
	);
}

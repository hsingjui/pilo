import { type Accessor, computed, effect, signal, View } from "nsh";
import { currentWindow } from "nsh/desktop";
import {
	ConversationColumn,
	ConversationColumnLayout,
} from "../chat/conversation-column";
import { DEFAULT_CHAT_REM } from "../chat/layout";
import { ChatComposerSkeleton } from "../composer/chat-composer";
import { ErrorState } from "../ui/state-view";
import { t } from "./i18n";
import { SessionLanding } from "./landing";
import {
	sidebarSurface,
	StartupSidebar,
	TITLE_BAR_HEIGHT,
	windowTitleBarOptions,
} from "./sidebar-panel";

/** The first frame, before the Host theme is available to mount AppShell. */
export function StartupFrame(props: {
	/** The saved theme is Claude's, whose conversation column is wider. */
	claude?: boolean;
	/** The saved sidebar width; the default one without it. */
	sidebarWidth?: Accessor<number>;
}) {
	const window = currentWindow();
	const sidebarCard = computed(sidebarSurface);
	const titleBarOptions = computed(() => windowTitleBarOptions(sidebarCard()));
	effect(() => {
		window.set({ titleBar: titleBarOptions() });
	});
	const titleBar = () => ({
		height:
			window.titleBar().height || titleBarOptions().height || TITLE_BAR_HEIGHT,
		left: window.titleBar().left,
	});
	const narrow = signal(false);
	const columnLayout = computed(() => ({
		claude: props.claude ?? false,
		narrow: narrow(),
	}));
	return (
		<View class="flex-1 flex-row bg-background">
			<StartupSidebar titleBar={titleBar} width={props.sidebarWidth} />
			<View
				class="min-w-0 flex-1"
				onLayout={({ bounds }) =>
					narrow.set(bounds.size.width < 40 * DEFAULT_CHAT_REM)
				}
			>
				<View
					desktop={{ windowDrag: true }}
					style={{ height: titleBar().height }}
				/>
				<View testID="workspace" class="min-h-0 flex-1">
					<ConversationColumnLayout.Provider value={columnLayout}>
						<StartupLoading />
					</ConversationColumnLayout.Provider>
				</View>
			</View>
		</View>
	);
}

/**
 * The workspace before the Host answers: the landing and composer the chat
 * page opens with, in their loading forms, as React's loading fallback.
 */
export function StartupLoading() {
	return (
		<View
			testID="startup-loading"
			role="progressbar"
			accessible
			accessibilityLabel={t("common.loading")}
			class="min-h-0 min-w-0 flex-1"
		>
			<View class="min-h-0 flex-1 justify-center">
				<ConversationColumn>
					<SessionLanding loading />
				</ConversationColumn>
			</View>
			<View class="relative z-20 -mt-4 w-full shrink-0 pb-4">
				<ConversationColumn class="relative">
					<ChatComposerSkeleton showModel />
				</ConversationColumn>
			</View>
		</View>
	);
}

/** The runtime shut down under the app; only a new launch starts another. */
export function RuntimeStopped() {
	return (
		<ErrorState
			testID="runtime-stopped"
			title={() => t("app.runtimeStopped")}
			description={() => t("app.runtimeStoppedDescription")}
		/>
	);
}

/** Startup did not finish; with `onRetry` the user can run it again. */
export function StartupFailure(props: {
	message: () => string;
	onRetry: () => Promise<void>;
}) {
	return (
		<ErrorState
			testID="startup-failed"
			title={() => t("common.loadFailed")}
			description={props.message}
			onRetry={props.onRetry}
			retryLabel={() => t("common.retry")}
			retryTestID="startup-retry"
		/>
	);
}

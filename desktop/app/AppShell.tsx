import { type Accessor, computed, type JSX, signal, Text, View } from "nsh";
import { currentWindow, titleBar } from "nsh/desktop";

import type { Project } from "@/lib/api/projects-types";
import { ChatMessageList } from "../chat/chat-message-list";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import type { ChatTranscriptStore } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { followSavedAppearance } from "./appearance";
import { t } from "./i18n";
import { Sidebar } from "./Sidebar";
import { SidebarSettingsStore } from "./sidebar-settings";

/** The sidebar's width until the user resizes it, as in the Tauri app. */
const SIDEBAR_WIDTH = 292;
/** The title bar's height; the system centers its window controls in it. */
const TITLE_BAR_HEIGHT = 44;

export interface AppShellProps {
	/** The app state the shell shows; whoever mounts the shell starts it. */
	store: AppStore;
	/** The open session's transcript; whoever mounts the shell keeps it open. */
	chat: Pick<ChatTranscriptStore, "state" | "refresh">;
}

export function AppShell(props: AppShellProps) {
	const { store, chat } = props;
	const status = computed(() => store.state().status);
	const project = computed(() => activeProject(store.state()));
	const sessionOpen = computed(() => store.state().navigation.session !== null);
	const collapsed = signal(false);
	const sidebarSettings = new SidebarSettingsStore();
	void sidebarSettings.load();
	followSavedAppearance(store.state);
	// The app draws its own title bar: the sidebar and the main area reach
	// the window's top edge, beside the system's window controls.
	currentWindow().set({
		titleBar: { style: "hidden", height: TITLE_BAR_HEIGHT },
	});
	const barHeight = () => titleBar().height || TITLE_BAR_HEIGHT;
	const toggle = (testID: string, label: () => string) => (
		<Button
			testID={testID}
			variant="ghost"
			size="icon"
			accessibilityLabel={label()}
			onPress={() => collapsed.update((value) => !value)}
		>
			<Icon name="PanelLeft" />
		</Button>
	);
	/** A page of the workspace that is not a chat, in its middle. */
	const centered = (page: JSX.Element) => (
		<View class="flex-1 items-center justify-center gap-2 p-6">{page}</View>
	);
	return (
		<View testID="app" class="flex-1 flex-row bg-background">
			{() =>
				collapsed() ? null : (
					<View
						testID="sidebar"
						class="shrink-0 border-r border-sidebar-border bg-sidebar-background"
						style={{ width: SIDEBAR_WIDTH }}
					>
						<View
							testID="sidebar-title-bar"
							desktop={{ windowDrag: true }}
							class="flex-row items-center justify-end px-2"
							style={{ height: barHeight(), paddingLeft: titleBar().left }}
						>
							{toggle("sidebar-collapse", () => t("sidebar.collapseSidebar"))}
						</View>
						{() =>
							status().type === "ready" && sidebarSettings.loaded() ? (
								<Sidebar store={store} settings={sidebarSettings} />
							) : null
						}
					</View>
				)
			}
			<View testID="main" class="min-w-0 flex-1">
				<View
					testID="main-title-bar"
					desktop={{ windowDrag: true }}
					class="flex-row items-center px-2"
					style={{
						height: barHeight(),
						paddingLeft: collapsed() ? titleBar().left + 8 : 8,
					}}
				>
					{() =>
						collapsed()
							? toggle("sidebar-expand", () => t("sidebar.expandSidebar"))
							: null
					}
				</View>
				<View testID="workspace" class="min-h-0 min-w-0 flex-1">
					{() => {
						const current = status();
						switch (current.type) {
							case "starting":
								return centered(<StartupLoading />);
							case "failed":
								return centered(
									<StartupFailure
										message={() => current.message}
										onRetry={() => store.retry()}
									/>,
								);
							case "closed":
								return centered(<RuntimeStopped />);
							case "ready":
								return sessionOpen() ? (
									<ChatMessageList
										transcript={chat.state}
										onRetry={() => chat.refresh()}
										empty={() => <NewSession project={project} />}
									/>
								) : (
									centered(<ProjectPlaceholder project={project} />)
								);
						}
					}}
				</View>
			</View>
		</View>
	);
}

/** What a session without messages shows, until the new session view. */
function NewSession(props: { project: Accessor<Project | null> }) {
	return (
		<View class="max-w-full items-center gap-2">
			<Text
				testID="new-session-title"
				class="text-center font-sans text-xl font-semibold text-foreground"
			>
				{() => t("app.newChat")}
			</Text>
			<Text
				testID="new-session-project"
				class="text-center font-sans text-sm text-muted-foreground"
			>
				{() => props.project()?.name ?? ""}
			</Text>
		</View>
	);
}

function StartupLoading() {
	return (
		<Text
			testID="startup-loading"
			class="font-sans text-sm text-muted-foreground"
		>
			{() => t("common.loading")}
		</Text>
	);
}

/** Startup did not finish; with `onRetry` the user can run it again. */
/** The runtime shut down under the app; only a new launch starts another. */
function RuntimeStopped() {
	return (
		<View
			testID="runtime-stopped"
			role="alert"
			class="max-w-md items-center gap-4"
		>
			<Text class="text-center font-sans text-lg font-medium text-foreground">
				{() => t("app.runtimeStopped")}
			</Text>
			<Text class="text-center font-sans text-sm text-muted-foreground">
				{() => t("app.runtimeStoppedDescription")}
			</Text>
		</View>
	);
}

function StartupFailure(props: {
	message: () => string;
	onRetry: () => Promise<void>;
}) {
	const retrying = signal(false);
	return (
		<View
			testID="startup-failed"
			role="alert"
			class="max-w-md items-center gap-4"
		>
			<Text class="text-center font-sans text-lg font-medium text-foreground">
				{() => t("common.loadFailed")}
			</Text>
			<Text
				testID="startup-failed-message"
				class="text-center font-sans text-sm text-muted-foreground"
			>
				{props.message}
			</Text>
			<Button
				testID="startup-retry"
				variant="outline"
				disabled={retrying()}
				onPress={() => {
					retrying.set(true);
					void props.onRetry().finally(() => retrying.set(false));
				}}
			>
				<Text>{() => t("common.retry")}</Text>
			</Button>
		</View>
	);
}

/** Stands where the chat of the chosen project will be. */
function ProjectPlaceholder(props: { project: Accessor<Project | null> }) {
	return (
		<View class="max-w-full items-center gap-2">
			<Text
				testID="workspace-title"
				class="text-center font-sans text-xl font-semibold text-foreground"
			>
				{() => props.project()?.name ?? t("app.addProjectFirst")}
			</Text>
			<Text
				testID="workspace-path"
				class="text-center font-mono text-xs text-muted-foreground"
			>
				{() => props.project()?.path ?? ""}
			</Text>
		</View>
	);
}

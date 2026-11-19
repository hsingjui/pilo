import { type Accessor, computed, signal, Text, View } from "nsh";
import { currentWindow, titleBar } from "nsh/desktop";

import type { Project } from "@/lib/api/projects-types";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { followSavedAppearance } from "./appearance";
import { t } from "./i18n";

/** The sidebar's width until the user resizes it, as in the Tauri app. */
const SIDEBAR_WIDTH = 292;
/** The title bar's height; the system centers its window controls in it. */
const TITLE_BAR_HEIGHT = 44;

export interface AppShellProps {
	/** The app state the shell shows; whoever mounts the shell starts it. */
	store: AppStore;
}

export function AppShell(props: AppShellProps) {
	const { store } = props;
	const status = computed(() => store.state().status);
	const project = computed(() => activeProject(store.state()));
	const collapsed = signal(false);
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
						<View class="gap-2 px-4 py-2">
							<Text class="font-sans text-sm font-semibold text-sidebar-foreground">
								Pilo
							</Text>
						</View>
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
				<View
					testID="workspace"
					class="min-w-0 flex-1 items-center justify-center gap-2 p-6"
				>
					{() => {
						const current = status();
						switch (current.type) {
							case "starting":
								return <StartupLoading />;
							case "failed":
								return (
									<StartupFailure
										message={() => current.message}
										onRetry={() => store.retry()}
									/>
								);
							case "closed":
								return <RuntimeStopped />;
							case "ready":
								return <ProjectPlaceholder project={project} />;
						}
					}}
				</View>
			</View>
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

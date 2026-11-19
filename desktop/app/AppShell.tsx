import { type Accessor, computed, signal, Text, View } from "nsh";

import type { Project } from "@/lib/api/projects-types";
import { activeProject } from "../state/app-state";
import type { AppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { t } from "./i18n";

export interface AppShellProps {
	/** The app state the shell shows; whoever mounts the shell starts it. */
	store: AppStore;
}

export function AppShell(props: AppShellProps) {
	const { store } = props;
	const status = computed(() => store.state().status);
	const project = computed(() => activeProject(store.state()));
	return (
		<View
			testID="app"
			class="flex-1 flex-row bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
		>
			<View
				testID="sidebar"
				class="w-28 shrink-0 gap-2 border-r border-sidebar-border bg-sidebar-background p-4 sm:w-64"
			>
				<Text class="font-sans text-sm font-semibold text-sidebar-foreground">
					Pilo
				</Text>
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
							return (
								<StartupFailure message={() => t("app.unexpectedError")} />
							);
						case "ready":
							return <ProjectPlaceholder project={project} />;
					}
				}}
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
function StartupFailure(props: {
	message: () => string;
	onRetry?: () => Promise<void>;
}) {
	const retrying = signal(false);
	const retry = props.onRetry;
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
			{retry ? (
				<Button
					testID="startup-retry"
					variant="outline"
					disabled={retrying()}
					onPress={() => {
						retrying.set(true);
						void retry().finally(() => retrying.set(false));
					}}
				>
					<Text>{() => t("common.retry")}</Text>
				</Button>
			) : null}
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

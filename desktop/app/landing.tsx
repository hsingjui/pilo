import { type Accessor, Text, token, View } from "nsh";

import type { Project } from "@/lib/api/projects-types";
import type { AppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { Select } from "../ui/select";
import { t } from "./i18n";
import { PiLogo } from "./pi-logo";

/**
 * The new-session landing: Pi's hero with the project picker, like the Tauri
 * app's empty chat. Without projects it asks for one instead.
 */
export function SessionLanding(props: {
	store: AppStore;
	project: Accessor<Project | null>;
	onAddProject: () => void;
}) {
	const projects = () => props.store.state().projects;
	return (
		<View
			testID="landing"
			class="max-w-full items-center justify-center gap-3 py-4 text-center"
		>
			<PiLogo size={64} color={token("foreground")} />
			<Text
				testID="workspace-title"
				class="text-center font-sans text-2xl font-semibold tracking-tight text-foreground"
			>
				{() => t("chat.todayPrompt")}
			</Text>
			{() =>
				projects().length > 0 ? (
					<>
						<Select
							testID="landing-project-picker"
							class="max-w-72"
							items={projects().map((project) => ({
								value: project.id,
								title: project.name,
							}))}
							value={props.project()?.id ?? null}
							placeholder={t("app.selectProject")}
							onChange={(event) => {
								if (event.value !== null)
									props.store.selectProject(event.value);
							}}
						/>
						<Button
							testID="landing-add-project"
							variant="ghost"
							size="sm"
							onPress={props.onAddProject}
						>
							<Text>{() => t("project.addProject")}</Text>
						</Button>
					</>
				) : (
					<>
						<Text class="text-center text-sm text-muted-foreground">
							{() => t("app.addProjectFirst")}
						</Text>
						<Button testID="landing-add-project" onPress={props.onAddProject}>
							<Text>{() => t("project.addProject")}</Text>
						</Button>
					</>
				)
			}
		</View>
	);
}

import { type Accessor, computed, Text, token, View } from "nsh";
import { Button as BaseButton } from "nsh/base";

import { isDefaultWorkspace, type Project } from "@/lib/api/projects-types";
import { ConversationColumnLayout } from "../chat/conversation-column";
import type { AppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { t } from "./i18n";
import { PiLogo } from "./pi-logo";

function projectLabel(project: Project) {
	return isDefaultWorkspace(project)
		? t("sidebar.defaultWorkspace")
		: project.name;
}

function connectionLabel(project: Project) {
	return project.connection.kind.type === "local"
		? t("common.local")
		: project.connection.name;
}

/**
 * The new-session landing: Pi's hero with the project picker, like the Tauri
 * app's empty chat. Without projects it asks for one instead.
 */
export function SessionLanding(props: {
	store: AppStore;
	project: Accessor<Project | null>;
	onAddProject: () => void;
}) {
	const projects = computed(() => props.store.state().projects);
	const layout = ConversationColumnLayout();
	return (
		<View
			testID="landing"
			class="w-full min-w-0 items-center justify-center gap-3 py-4"
		>
			<PiLogo size={64} color={token("foreground")} />
			<Text
				testID="workspace-title"
				class={`text-center font-semibold tracking-tight text-foreground ${
					layout().narrow ? "text-2xl" : "text-3xl"
				}`}
				style={{ fontFamily: token("font-display") }}
			>
				{() => t("chat.todayPrompt")}
			</Text>
			{() =>
				projects().length > 0 ? (
					<LandingProjectPicker
						projects={projects}
						project={props.project}
						onSelect={(projectId) => props.store.selectProject(projectId)}
					/>
				) : (
					<>
						<Text class="font-sans text-center text-sm text-muted-foreground">
							{() => t("app.addProjectFirst")}
						</Text>
						<Button testID="landing-add-project" onPress={props.onAddProject}>
							<Text class="font-sans">{() => t("project.addProject")}</Text>
						</Button>
					</>
				)
			}
		</View>
	);
}

/**
 * The Tauri landing's `DraftProjectPicker`: a borderless trigger with the
 * project and its connection, and a menu of every project.
 */
function LandingProjectPicker(props: {
	projects: Accessor<Project[]>;
	project: Accessor<Project | null>;
	onSelect: (projectId: string) => void;
}) {
	const accessibilityLabel = () => {
		const project = props.project();
		return project
			? `${t("app.selectProject")}: ${projectLabel(project)} · ${connectionLabel(project)}`
			: t("app.selectProject");
	};
	return (
		<Menu
			align="center"
			popupClass="max-w-80"
			popupStyle={{ minWidth: 0 }}
			trigger={
				// A plain press target, as the Tauri trigger is: no `Button` press
				// scale, which would shrink the text while it is held.
				<BaseButton
					testID="landing-project-picker"
					class="min-h-(--pilo-button-sm-height) max-w-full flex-row items-center gap-1.5 rounded-lg px-2 hover:bg-hover focus-visible:outline-hidden"
					focusVisibleStyle={focusRingStyle(token("ring"))}
					accessibilityLabel={accessibilityLabel()}
				>
					{() => {
						const project = props.project();
						return (
							<>
								<Text class="min-w-0 shrink truncate font-sans text-sm font-medium text-foreground">
									{project ? projectLabel(project) : t("app.selectProject")}
								</Text>
								{project ? (
									<>
										<Text class="shrink-0 font-sans text-sm text-muted-foreground">
											·
										</Text>
										<Text class="min-w-0 shrink truncate font-sans text-xs text-muted-foreground">
											{connectionLabel(project)}
										</Text>
									</>
								) : null}
							</>
						);
					}}
					<Icon
						name="ChevronDown"
						size={14}
						color={token("muted-foreground")}
					/>
				</BaseButton>
			}
		>
			<View class="gap-1">
				{props.projects().map((candidate) => (
					<MenuItem
						testID={`landing-project:${candidate.id}`}
						indicatorClass="hidden"
						icon={
							<Icon name="Folder" size={14} color={token("muted-foreground")} />
						}
						class={
							props.project()?.id === candidate.id ? "bg-hover" : undefined
						}
						onSelect={() => props.onSelect(candidate.id)}
					>
						<Text class="min-w-0 flex-1 truncate font-sans font-medium">
							{projectLabel(candidate)}
						</Text>
						<Text class="min-w-0 max-w-[50%] shrink truncate font-sans text-xs text-muted-foreground">
							{connectionLabel(candidate)}
						</Text>
					</MenuItem>
				))}
			</View>
		</Menu>
	);
}

import {
	type Accessor,
	computed,
	signal,
	Text,
	token,
	View,
	windowSize,
} from "nsh";
import { Button as BaseButton } from "nsh/base";

import { isDefaultWorkspace, type Project } from "@shared/api/projects-types";
import { ConversationColumnLayout } from "../chat/conversation-column";
import type { AppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { Skeleton } from "../ui/skeleton";
import { displayFontFamily } from "./appearance";
import { connectionLabel } from "./connection-label";
import { t } from "./i18n";
import { PiLogo } from "./pi-logo";

function projectLabel(project: Project) {
	return isDefaultWorkspace(project)
		? t("sidebar.defaultWorkspace")
		: project.name;
}

/**
 * The new-session landing: Pi's hero with the project picker, like the WebUI
 * app's empty chat. Without projects it asks for one instead.
 */
export function SessionLanding(
	props:
		| { loading: true }
		| {
				store: AppStore;
				project: Accessor<Project | null>;
				onAddProject: () => void;
		  },
) {
	const loading = "loading" in props;
	const projects = computed(() =>
		"store" in props ? props.store.state().projects : [],
	);
	const layout = ConversationColumnLayout();
	return (
		<View
			testID={loading ? undefined : "landing"}
			class="w-full min-w-0 items-center justify-center gap-3 py-4"
		>
			<PiLogo
				size={64}
				color={token(loading ? "skeleton-line-strong" : "foreground")}
			/>
			<View class="relative max-w-full">
				<Text
					testID={loading ? undefined : "workspace-title"}
					accessible={!loading}
					accessibilityElementsHidden={loading}
					class={`text-center font-semibold tracking-tight text-foreground ${
						layout().narrow ? "text-2xl" : "text-3xl"
					}`}
					style={{
						fontFamily: displayFontFamily(),
						opacity: loading ? 0 : 1,
					}}
				>
					{() => t("chat.todayPrompt")}
				</Text>
				{loading ? <Skeleton class="absolute inset-x-0 inset-y-1" /> : null}
			</View>
			{() =>
				"loading" in props ? (
					// The project picker's outline: name, connection and chevron.
					<View class="min-h-(--pilo-button-sm-height) flex-row items-center justify-center gap-1.5 px-2">
						<Skeleton class="h-3.5 w-20" />
						<Skeleton class="h-3 w-12" />
						<Skeleton class="size-3.5" />
					</View>
				) : projects().length > 0 ? (
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
 * The WebUI landing's `DraftProjectPicker`: a borderless trigger with the
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
			? `${t("app.selectProject")}: ${projectLabel(project)} · ${connectionLabel(project.connection)}`
			: t("app.selectProject");
	};
	const open = signal(false);
	const pointerBlur = blurOnPointerPress();
	return (
		<Menu
			align="center"
			open={open()}
			onOpenChange={(event) => open.set(event.open)}
			// React's `min-w-48 max-w-[calc(100vw-2rem)]`.
			popupStyle={{ minWidth: 192, maxWidth: windowSize().width - 32 }}
			trigger={
				// A plain press target, as the WebUI trigger is: no `Button` press
				// scale, which would shrink the text while it is held.
				<BaseButton
					testID="landing-project-picker"
					ref={pointerBlur.ref}
					onMouseUp={pointerBlur.onMouseUp}
					class={`min-h-(--pilo-button-sm-height) max-w-full flex-row items-center gap-1.5 rounded-lg px-2 hover:bg-hover focus-visible:outline-hidden ${
						open() ? "bg-hover" : ""
					}`}
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
											{connectionLabel(project.connection)}
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
						icon={<Icon name="Folder" size={14} />}
						class={
							props.project()?.id === candidate.id ? "bg-hover" : undefined
						}
						onSelect={() => props.onSelect(candidate.id)}
					>
						<Text
							class={`min-w-0 flex-1 truncate font-sans font-medium ${
								props.project()?.id === candidate.id
									? "text-hover-foreground"
									: ""
							}`}
						>
							{projectLabel(candidate)}
						</Text>
						<Text class="min-w-0 max-w-[50%] shrink truncate font-sans text-xs text-muted-foreground">
							{connectionLabel(candidate.connection)}
						</Text>
					</MenuItem>
				))}
			</View>
		</Menu>
	);
}

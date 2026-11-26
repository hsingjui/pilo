import { Text, token, View } from "nsh";

import type { Project } from "@shared/api/projects-types";
import type { ProjectNativeApp } from "../client/nsh-pilo-client";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Tooltip } from "../ui/tooltip";
import { t } from "./i18n";
import { ProjectOpenMenu } from "./project-open-menu";

/**
 * The title bar's project actions, as the WebUI header's: a new terminal
 * tab, a temporary chat, quick open, and Git changes.
 */
export function HeaderActions(props: {
	project: () => Project;
	/** Opens a terminal tab; omitted where the app holds no terminals. */
	onOpenTerminal?: () => void;
	/** The project has a shell that has not exited. */
	terminalRunning: () => boolean;
	/** A terminal tab is currently shown in place of chat. */
	terminalActive?: () => boolean;
	terminalOpening: () => boolean;
	onNewTemporaryChat: () => void;
	/** The open chat is temporary. */
	temporary: () => boolean;
	/** Opens the project in a desktop app; quick open shows only with it. */
	openInApp?: (
		projectId: string,
		app: ProjectNativeApp,
		path?: string,
	) => Promise<void>;
	/** Opens the project's Git changes tab; omitted when Git is unavailable. */
	onOpenGit?: () => void;
	/** The project's Git tab is currently active. */
	gitActive?: () => boolean;
	onError: (message: string) => void;
}) {
	const tooltip = (label: () => string) => (
		<Tooltip>
			<Text class="font-sans">{label}</Text>
		</Tooltip>
	);
	const terminalLabel = () =>
		props.terminalActive?.()
			? t("terminal.hide")
			: props.terminalRunning()
				? t("terminal.show")
				: t("terminal.new");
	return (
		<View class="shrink-0 flex-row items-center gap-1">
			{props.onOpenTerminal ? (
				<Button
					testID="header-open-terminal"
					variant="ghost"
					size="icon"
					class="size-7"
					selected={props.terminalActive?.() ?? false}
					disabled={props.terminalOpening()}
					accessibilityLabel={terminalLabel()}
					tooltip={tooltip(terminalLabel)}
					onPress={props.onOpenTerminal}
				>
					<Icon
						name="SquareTerminal"
						size={16}
						color={
							props.terminalActive?.() || props.terminalRunning()
								? token("primary")
								: undefined
						}
					/>
				</Button>
			) : null}
			<Button
				testID="header-temporary-chat"
				variant="ghost"
				size="icon"
				class="size-7"
				selected={props.temporary()}
				accessibilityLabel={t("app.temporaryChat")}
				tooltip={tooltip(() => t("app.temporaryChat"))}
				onPress={props.onNewTemporaryChat}
			>
				<Icon
					name="MessageSquareDashed"
					size={16}
					color={props.temporary() ? token("primary") : undefined}
				/>
			</Button>
			{props.openInApp ? (
				<ProjectOpenMenu
					project={props.project}
					openInApp={props.openInApp}
					onError={props.onError}
				/>
			) : null}
			{props.onOpenGit ? (
				<Button
					testID="header-open-git"
					variant="ghost"
					size="icon"
					class="size-7"
					selected={props.gitActive?.() ?? false}
					accessibilityLabel={t("file.viewChanges")}
					tooltip={tooltip(() => t("file.viewChanges"))}
					onPress={props.onOpenGit}
				>
					<Icon
						name="GitBranch"
						size={16}
						color={props.gitActive?.() ? token("primary") : undefined}
					/>
				</Button>
			) : null}
		</View>
	);
}

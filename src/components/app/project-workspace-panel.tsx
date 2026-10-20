import { lazy, Suspense, useContext, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";

import { ProjectWorkspaceContext } from "@/components/app/project-workspace-context";
import { GitWorkspaceSkeleton } from "@/components/git-workspace-skeleton";
import type { Project } from "@/lib/api/projects";
import type { ChatProjectImageScope } from "@/lib/chat/chat-image-media";
import { DEFAULT_GIT_WORKSPACE_VIEW } from "@/lib/project-workspace";
import { cn } from "@/lib/utils";

const ProjectViewer = lazy(() =>
	import("@/components/project-viewer").then((module) => ({
		default: module.ProjectViewer,
	})),
);

const GitWorkspace = lazy(() =>
	import("@/components/git-workspace").then((module) => ({
		default: module.GitWorkspace,
	})),
);

export function ProjectWorkspacePanel({
	project,
	active = true,
	headerOverlay = false,
	readImage,
	children,
}: {
	project?: Project | null;
	active?: boolean;
	headerOverlay?: boolean;
	readImage?: ChatProjectImageScope["readImage"];
	children: ReactNode;
}) {
	const workspace = useContext(ProjectWorkspaceContext);
	const state = project ? workspace?.state.get(project.id) : undefined;
	const workspaceActive = Boolean(state && state.activeTab.kind !== "chat");
	const gitActive = state?.activeTab.kind === "git";
	return (
		<div data-chat-panel="" className="relative flex min-h-0 flex-1 flex-col">
			{/* Keep chat geometry and DOM alive while a file or Git is selected. */}
			<div
				inert={workspaceActive}
				className={cn(
					"relative flex min-h-0 flex-1 flex-col",
					workspaceActive && "invisible",
				)}
			>
				{children}
			</div>
			{project && active && state?.files.length ? (
				<Suspense fallback={null}>
					<ProjectViewer
						project={project}
						headerOverlay={headerOverlay}
						readImage={readImage}
					/>
				</Suspense>
			) : null}
			{project && active && workspace && state?.gitOpen && isTauri() ? (
				<section
					role="tabpanel"
					aria-label="Git"
					inert={!gitActive}
					className={cn(
						"absolute inset-0 z-30 flex min-h-0 min-w-0 flex-col bg-background",
						headerOverlay && "top-11",
						!gitActive && "invisible",
					)}
				>
					<Suspense fallback={<GitWorkspaceSkeleton />}>
						<GitWorkspace
							key={project.id}
							projectId={project.id}
							active={gitActive}
							view={state.gitView ?? DEFAULT_GIT_WORKSPACE_VIEW}
							onViewChange={(view) => workspace.updateGitView(project.id, view)}
						/>
					</Suspense>
				</section>
			) : null}
		</div>
	);
}

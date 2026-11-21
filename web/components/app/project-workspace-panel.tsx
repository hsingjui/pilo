import { lazy, Suspense, useContext, type ReactNode } from "react";

import { ProjectWorkspaceContext } from "@/components/app/project-workspace-context";
import type { Project } from "@/lib/api/projects";
import type { ChatProjectImageScope } from "@/lib/chat/chat-image-media";
import { cn } from "@/lib/utils";

const ProjectViewer = lazy(() =>
	import("@/components/project-viewer").then((module) => ({
		default: module.ProjectViewer,
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
	return (
		<div data-chat-panel="" className="relative flex min-h-0 flex-1 flex-col">
			{/* Keep chat geometry and DOM alive while a file is selected. */}
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
		</div>
	);
}

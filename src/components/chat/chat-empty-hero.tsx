import { useEffect } from "react";

import { PiLogo } from "@/components/pi-logo";
import { DraftProjectPicker } from "@/components/chat/draft-project-picker";
import type { Project } from "@/lib/api/projects";

export function ChatEmptyHero({
	projects,
	project = null,
	onSwitchProject,
}: {
	projects?: readonly Project[];
	project?: Project | null;
	onSwitchProject?: (projectId: string) => void;
}) {
	const hasProjects = projects ? projects.length > 0 : undefined;
	useEffect(() => {
		if (hasProjects === undefined) return;
		try {
			localStorage.setItem("pilo.boot.hasProjects", hasProjects ? "1" : "0");
		} catch {
			// This is only a startup geometry hint, never project state.
		}
	}, [hasProjects]);
	return (
		<div className="flex w-full min-w-0 flex-col items-center justify-center gap-3 py-4 text-center">
			<PiLogo className="h-16 w-16 shrink-0 text-foreground" />
			<h1 className="font-display text-2xl font-semibold tracking-tight @min-[40rem]:text-3xl">
				今天要做点什么？
			</h1>
			{projects && projects.length > 0 ? (
				<DraftProjectPicker
					projects={projects}
					project={project}
					onSwitchProject={onSwitchProject}
				/>
			) : null}
		</div>
	);
}

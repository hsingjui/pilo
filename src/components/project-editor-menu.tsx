import { useRef, useSyncExternalStore } from "react";
import { ChevronDown, FolderOpen, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import vscodeIcon from "@/assets/editors/vscode.svg";
import wincIcon from "@/assets/editors/winc.svg";

import {
	getProjectOpeners,
	openProjectInEditor,
	readProjectEditor,
	subscribeProjectEditor,
	writeProjectEditor,
	type ProjectEditor,
	type ProjectOpener,
} from "@/lib/project-editor";
import type { Project } from "@/lib/api/projects";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

// Zed and Cursor retain their official black/white variants.
const editorIconPaths: Record<Exclude<ProjectEditor, "vscode">, string> = {
	zed: "M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z",
	cursor:
		"M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
};

function ProjectEditorIcon({ editor }: { editor: ProjectOpener }) {
	if (editor === "winc") {
		return <img src={wincIcon} alt="" className="size-4 shrink-0" />;
	}
	if (editor === "explorer" || editor === "finder") {
		return <FolderOpen aria-hidden="true" className="size-4 shrink-0" />;
	}
	if (editor === "powershell" || editor === "ghostty") {
		return <Terminal aria-hidden="true" className="size-4 shrink-0" />;
	}
	if (editor === "vscode") {
		return <img src={vscodeIcon} alt="" className="size-4 shrink-0" />;
	}
	return (
		<svg
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
			className="size-4 shrink-0 text-black dark:text-white"
		>
			<path d={editorIconPaths[editor]} />
		</svg>
	);
}

export function ProjectEditorMenu({
	project,
	filePath,
}: {
	project: Project;
	filePath?: string;
}) {
	const { t } = useTranslation();
	const storedEditor = useSyncExternalStore(
		subscribeProjectEditor,
		readProjectEditor,
	);
	const editors = getProjectOpeners(project).map((editor) => ({
		id: editor.id,
		name: editor.id === "explorer" ? t("chat.fileExplorer") : editor.name,
	}));
	const selectedEditor =
		editors.find((editor) => editor.id === storedEditor.id) ?? editors[0];
	const nativeApp =
		selectedEditor.id === "explorer" ||
		selectedEditor.id === "finder" ||
		selectedEditor.id === "powershell" ||
		selectedEditor.id === "ghostty";
	const pointerSelectionRef = useRef(false);
	const openLabel =
		filePath && nativeApp
			? t("chat.openFileDirectoryWithApp", { editor: selectedEditor.name })
			: filePath
				? t("chat.openFileWithEditor", {
						editor: selectedEditor.name,
						name: filePath.split(/[\\/]/).at(-1) ?? filePath,
					})
				: t("chat.openProjectWithEditor", { editor: selectedEditor.name });

	function handleOpen(editor: (typeof editors)[number]) {
		writeProjectEditor(editor.id);
		void openProjectInEditor(project, editor.id, filePath).catch(() => {
			toast.error(t("chat.openProjectInAppFailed", { editor: editor.name }));
		});
	}

	return (
		<fieldset
			aria-label={t("chat.quickOpen")}
			className="group/editor inline-flex shrink-0 items-center rounded-md transition-colors hover:bg-hover has-[[data-state=open]]:bg-hover"
		>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						className="size-7 [@media(pointer:coarse)]:size-11"
						aria-label={openLabel}
						onClick={() => handleOpen(selectedEditor)}
					>
						<ProjectEditorIcon editor={selectedEditor.id} />
					</Button>
				</TooltipTrigger>
				<TooltipContent className="max-w-80 break-words">
					{openLabel}
				</TooltipContent>
			</Tooltip>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-4 text-muted-foreground/60 group-hover/editor:text-muted-foreground data-[state=open]:text-foreground [@media(pointer:coarse)]:size-11"
						aria-label={t("chat.chooseProjectApp")}
					>
						<ChevronDown className="size-2.5" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent
					align="end"
					className="w-40 min-w-40"
					onPointerDownCapture={() => {
						pointerSelectionRef.current = true;
					}}
					onKeyDownCapture={() => {
						pointerSelectionRef.current = false;
					}}
					onCloseAutoFocus={(event) => {
						// Do not refocus the arrow after a pointer selection launches another app.
						if (pointerSelectionRef.current) event.preventDefault();
						pointerSelectionRef.current = false;
					}}
				>
					<DropdownMenuRadioGroup value={selectedEditor.id}>
						{editors.map((editor) => (
							<DropdownMenuRadioItem
								key={editor.id}
								value={editor.id}
								className="gap-2.5 [&_svg]:size-4 [@media(pointer:coarse)]:min-h-11"
								onSelect={() => handleOpen(editor)}
							>
								<ProjectEditorIcon editor={editor.id} />
								{editor.name}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</fieldset>
	);
}

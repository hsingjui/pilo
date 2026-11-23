import { colorScheme, token } from "nsh";

import {
	classifyFileType,
	type FileTypeKind,
} from "@shared/chat/file-type-icon";
import { Icon, type IconName } from "./icon";

type FileTypeVisual = {
	icon: IconName;
	light: string;
	dark: string;
};

const FILE_TYPE_VISUALS: Record<
	Exclude<FileTypeKind, "file">,
	FileTypeVisual
> = {
	react: { icon: "Atom", light: "#0e7490", dark: "#38bdf8" },
	typescript: { icon: "FileCode2", light: "#1d4ed8", dark: "#60a5fa" },
	javascript: { icon: "FileCode2", light: "#b45309", dark: "#fbbf24" },
	rust: { icon: "FileCode2", light: "#c2410c", dark: "#fb923c" },
	python: { icon: "FileCode2", light: "#047857", dark: "#34d399" },
	go: { icon: "FileCode2", light: "#0284c7", dark: "#38bdf8" },
	json: { icon: "FileJson", light: "#a16207", dark: "#facc15" },
	markdown: { icon: "FileText", light: "#4f46e5", dark: "#a5b4fc" },
	style: { icon: "FileCode2", light: "#be185d", dark: "#f472b6" },
	markup: { icon: "FileCode2", light: "#c2410c", dark: "#fb923c" },
	config: { icon: "FileCog", light: "#475569", dark: "#94a3b8" },
	shell: { icon: "FileTerminal", light: "#15803d", dark: "#4ade80" },
	database: { icon: "FileSpreadsheet", light: "#0f766e", dark: "#2dd4bf" },
	image: { icon: "FileImage", light: "#9333ea", dark: "#c084fc" },
	archive: { icon: "FileArchive", light: "#92400e", dark: "#d97706" },
	code: { icon: "Code2", light: "#4338ca", dark: "#818cf8" },
};

/** 解析文件对应的 Lucide 图标名与亮/暗自适应颜色，未知类型回退到通用 File 图标。 */
export function fileTypePresentation(pathOrName: string): {
	kind: FileTypeKind;
	icon: IconName;
	color: string;
} {
	const kind = classifyFileType(pathOrName);
	if (kind === "file") {
		return {
			kind,
			icon: "File",
			color: token("muted-foreground"),
		};
	}
	const visual = FILE_TYPE_VISUALS[kind];
	return {
		kind,
		icon: visual.icon,
		color: colorScheme() === "dark" ? visual.dark : visual.light,
	};
}

/** 按文件类型渲染区分图标，支持未知类型兜底。 */
export function FileTypeIcon(props: {
	path: string;
	size?: number;
	color?: string;
	class?: string;
}) {
	const visual = () => fileTypePresentation(props.path);
	return (
		<Icon
			name={visual().icon}
			size={props.size}
			color={props.color ?? visual().color}
			class={props.class}
		/>
	);
}

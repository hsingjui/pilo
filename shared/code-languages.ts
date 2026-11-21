export const CODE_LANGUAGES = [
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"json",
	"bash",
	"shellscript",
	"markdown",
	"python",
	"rust",
	"go",
	"yaml",
	"html",
	"css",
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

export const LANGUAGE_BY_EXTENSION: Record<string, CodeLanguage> = {
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	tsx: "tsx",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	jsx: "jsx",
	json: "json",
	sh: "bash",
	bash: "bash",
	zsh: "shellscript",
	md: "markdown",
	mdx: "markdown",
	py: "python",
	rs: "rust",
	go: "go",
	yml: "yaml",
	yaml: "yaml",
	html: "html",
	htm: "html",
	css: "css",
};

export function languageForPath(path: string): CodeLanguage | null {
	const extension = path.split(".").pop()?.toLowerCase();
	return extension ? (LANGUAGE_BY_EXTENSION[extension] ?? null) : null;
}

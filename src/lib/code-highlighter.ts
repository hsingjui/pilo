import type { BundledLanguage } from "shiki";

const CODE_THEME_NAME = "pilo-css-vars";

const LANGUAGE_BY_EXTENSION: Record<string, BundledLanguage> = {
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

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

let highlighterPromise: Promise<Highlighter> | null = null;

function languageForPath(path: string): BundledLanguage | null {
	const extension = path.split(".").pop()?.toLowerCase();
	return extension ? (LANGUAGE_BY_EXTENSION[extension] ?? null) : null;
}

async function createHighlighter() {
	const [
		{ createCssVariablesTheme, createHighlighterCore },
		{ createJavaScriptRegexEngine },
		typescript,
		tsx,
		javascript,
		jsx,
		json,
		bash,
		shellscript,
		markdown,
		python,
		rust,
		go,
		yaml,
		html,
		css,
	] = await Promise.all([
		import("shiki/core"),
		import("shiki/engine/javascript"),
		import("@shikijs/langs/typescript"),
		import("@shikijs/langs/tsx"),
		import("@shikijs/langs/javascript"),
		import("@shikijs/langs/jsx"),
		import("@shikijs/langs/json"),
		import("@shikijs/langs/bash"),
		import("@shikijs/langs/shellscript"),
		import("@shikijs/langs/markdown"),
		import("@shikijs/langs/python"),
		import("@shikijs/langs/rust"),
		import("@shikijs/langs/go"),
		import("@shikijs/langs/yaml"),
		import("@shikijs/langs/html"),
		import("@shikijs/langs/css"),
	]);

	return createHighlighterCore({
		engine: createJavaScriptRegexEngine(),
		langs: [
			...typescript.default,
			...tsx.default,
			...javascript.default,
			...jsx.default,
			...json.default,
			...bash.default,
			...shellscript.default,
			...markdown.default,
			...python.default,
			...rust.default,
			...go.default,
			...yaml.default,
			...html.default,
			...css.default,
		],
		themes: [
			createCssVariablesTheme({
				name: CODE_THEME_NAME,
				variablePrefix: "--pilo-shiki-",
			}),
		],
	});
}

async function getHighlighter() {
	highlighterPromise ??= createHighlighter().catch((error) => {
		highlighterPromise = null;
		throw error;
	});
	return highlighterPromise;
}

export async function highlightProjectFile(path: string, code: string) {
	const language = languageForPath(path);
	if (!language) return null;
	const highlighter = await getHighlighter();
	return highlighter.codeToHtml(code, {
		lang: language,
		theme: CODE_THEME_NAME,
	});
}

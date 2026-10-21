export const CODE_THEME_NAME = "pilo-css-vars";

export const CODE_LANGUAGE_LOADERS = {
	typescript: () => import("@shikijs/langs/typescript"),
	tsx: () => import("@shikijs/langs/tsx"),
	javascript: () => import("@shikijs/langs/javascript"),
	jsx: () => import("@shikijs/langs/jsx"),
	json: () => import("@shikijs/langs/json"),
	bash: () => import("@shikijs/langs/bash"),
	shellscript: () => import("@shikijs/langs/shellscript"),
	markdown: () => import("@shikijs/langs/markdown"),
	python: () => import("@shikijs/langs/python"),
	rust: () => import("@shikijs/langs/rust"),
	go: () => import("@shikijs/langs/go"),
	yaml: () => import("@shikijs/langs/yaml"),
	html: () => import("@shikijs/langs/html"),
	css: () => import("@shikijs/langs/css"),
};

export type CodeLanguage = keyof typeof CODE_LANGUAGE_LOADERS;

const LANGUAGE_BY_EXTENSION: Record<string, CodeLanguage> = {
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
const languagePromises = new Map<CodeLanguage, Promise<Highlighter>>();

export function languageForPath(path: string): CodeLanguage | null {
	const extension = path.split(".").pop()?.toLowerCase();
	return extension ? (LANGUAGE_BY_EXTENSION[extension] ?? null) : null;
}

async function createHighlighter() {
	const [
		{ createCssVariablesTheme, createHighlighterCore },
		{ createJavaScriptRegexEngine },
	] = await Promise.all([
		import("shiki/core"),
		import("shiki/engine/javascript"),
	]);

	return createHighlighterCore({
		engine: createJavaScriptRegexEngine(),
		langs: [],
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

// Share the engine across file previews and chat, loading only requested grammars.
export function getCodeHighlighter(
	language: CodeLanguage,
): Promise<Highlighter> {
	const cached = languagePromises.get(language);
	if (cached) return cached;
	const promise = Promise.all([
		getHighlighter(),
		CODE_LANGUAGE_LOADERS[language](),
	])
		.then(async ([highlighter, grammar]) => {
			if (!highlighter.getLoadedLanguages().includes(language)) {
				await highlighter.loadLanguage(...grammar.default);
			}
			return highlighter;
		})
		.catch((error) => {
			languagePromises.delete(language);
			throw error;
		});
	languagePromises.set(language, promise);
	return promise;
}

export async function highlightProjectFile(path: string, code: string) {
	const language = languageForPath(path);
	if (!language || code.length > 200_000) return null;
	let lines = 1;
	let lineLength = 0;
	for (const char of code) {
		if (char === "\n") {
			lines += 1;
			lineLength = 0;
		} else {
			lineLength += 1;
		}
		if (lines > 2_000 || lineLength > 2_000) return null;
	}
	const highlighter = await getCodeHighlighter(language);
	return highlighter.codeToHtml(code, {
		lang: language,
		theme: CODE_THEME_NAME,
	});
}

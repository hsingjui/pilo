import {
	createBundledHighlighter,
	createSingletonShorthands,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";

import { CODE_LANGUAGE_LOADERS } from "@/lib/code-highlighter";

export * from "shiki/core";
export { createJavaScriptRegexEngine };
export { createOnigurumaEngine } from "shiki/engine/oniguruma";

const languages = {
	...CODE_LANGUAGE_LOADERS,
	c: () => import("@shikijs/langs/c"),
	cpp: () => import("@shikijs/langs/cpp"),
	csharp: () => import("@shikijs/langs/csharp"),
	java: () => import("@shikijs/langs/java"),
	sql: () => import("@shikijs/langs/sql"),
	toml: () => import("@shikijs/langs/toml"),
	xml: () => import("@shikijs/langs/xml"),
	docker: () => import("@shikijs/langs/docker"),
	powershell: () => import("@shikijs/langs/powershell"),
};

// Keep Shiki aliases used by @pierre/diffs filename detection.
export const bundledLanguages = {
	...languages,
	"c++": languages.cpp,
	"c#": languages.csharp,
	cs: languages.csharp,
	dockerfile: languages.docker,
	js: languages.javascript,
	cjs: languages.javascript,
	mjs: languages.javascript,
	md: languages.markdown,
	ps: languages.powershell,
	ps1: languages.powershell,
	py: languages.python,
	rs: languages.rust,
	sh: languages.shellscript,
	shell: languages.shellscript,
	zsh: languages.shellscript,
	ts: languages.typescript,
	cts: languages.typescript,
	mts: languages.typescript,
	yml: languages.yaml,
};

// Diff themes are resolved and attached separately by @pierre/diffs.
export const createHighlighter = createBundledHighlighter({
	langs: bundledLanguages,
	themes: {},
	engine: () => createJavaScriptRegexEngine(),
});

export const { codeToHtml } = createSingletonShorthands(createHighlighter);

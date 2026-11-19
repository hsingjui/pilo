import { setTheme, Storage } from "nsh";

import claude from "../claude-theme.json";
import { setStyleTheme } from "../ui/theme-style";

/** Shows the theme the test chose with `open`'s `storage`; Lody without one. */
export async function applyFixtureTheme() {
	if ((await Storage.getItem("fixture.theme")) !== "claude") return;
	setTheme({ cssVars: claude.cssVars });
	setStyleTheme(claude.styleVars);
}

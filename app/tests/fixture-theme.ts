import { Storage } from "nsh";

import type { ThemeFamily } from "@shared/theme-settings-types";

/** The theme family the test chose with `open`'s `storage`; Lody without one. */
export async function fixtureThemeFamily(): Promise<ThemeFamily> {
	return (await Storage.getItem("fixture.theme")) === "claude"
		? "claude"
		: "lody";
}

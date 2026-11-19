import { BootstrapFixture, Pilo } from "app/native";

import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { launch } from "../app/launch";
import { applyFixtureTheme } from "./app-shell-theme";

/**
 * The app as `App.tsx` starts it, on the native runtime over a data
 * directory of its own.
 */
const fixture = new BootstrapFixture();

initializeI18n();
void applyFixtureTheme().then(() => launch(new Pilo(fixture.dataDir())));

import { DesktopNotifications, Pilo } from "app/native";
import process from "process";

import "./app/shell/fonts";
import { createDesktopNotifications } from "./app/shell/desktop-notifications";
import { initializeI18n } from "./app/shell/i18n";
import { launch } from "./app/shell/launch";

initializeI18n();
const pilo = new Pilo(null, process.logFile);
void launch(pilo, pilo, createDesktopNotifications(DesktopNotifications));

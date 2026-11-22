import { DesktopNotifications, Pilo } from "app/native";
import process from "process";

import "./app/fonts";
import { createDesktopNotifications } from "./app/desktop-notifications";
import { initializeI18n } from "./app/i18n";
import { launch } from "./app/launch";

initializeI18n();
const pilo = new Pilo(null, process.logFile);
void launch(pilo, pilo, createDesktopNotifications(DesktopNotifications));

import { mount } from "nsh";

import "./app/fonts";
import { AppShell } from "./app/AppShell";
import { initializeI18n } from "./app/i18n";

initializeI18n();
mount(AppShell);

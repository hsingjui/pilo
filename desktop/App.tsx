import { Pilo } from "app/native";

import "./app/fonts";
import { initializeI18n } from "./app/i18n";
import { launch } from "./app/launch";

initializeI18n();
const pilo = new Pilo();
void launch(pilo, pilo);

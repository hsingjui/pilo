import { mount, Scroll, View } from "nsh";

import "../app/fonts";
import { initializeI18n } from "../app/i18n";
import { AboutPane } from "../settings/about-pane";
import { scriptedClient } from "./scripted-app-client";

/** The about pane alone over a scripted client. */
const runtime = scriptedClient();

function run() {
	mount(() => (
		<Scroll class="flex-1 bg-background">
			<View class="p-3">
				<AboutPane client={runtime.client} />
			</View>
		</Scroll>
	));
}

initializeI18n();
void run();

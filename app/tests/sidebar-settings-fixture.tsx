import { mount, Text, View } from "nsh";
import { Button } from "nsh/base";

import { SidebarSettingsStore } from "../shell/sidebar-settings";

/** Shows the sidebar's stored settings and changes each of them. */
function Fixture() {
	const store = new SidebarSettingsStore();
	void store.load();
	const settings = store.settings;
	return (
		<View class="flex-1 gap-2 p-4">
			<Text>{() => `loaded: ${store.loaded()}`}</Text>
			<Text>{() => `view: ${settings().view}`}</Text>
			<Text>{() => `show projects: ${settings().showProjectsInRecents}`}</Text>
			<Text>
				{() => `sections: ${JSON.stringify(settings().collapsedSections)}`}
			</Text>
			<Button onPress={() => void store.setView("recent")}>
				<Text>Use recent</Text>
			</Button>
			<Button onPress={() => void store.setView("projects")}>
				<Text>Use projects</Text>
			</Button>
			<Button onPress={() => void store.setShowProjectsInRecents(true)}>
				<Text>Show projects</Text>
			</Button>
			<Button onPress={() => void store.setShowProjectsInRecents(false)}>
				<Text>Hide projects</Text>
			</Button>
			<Button onPress={() => void store.setSectionCollapsed("ws:p1", true)}>
				<Text>Collapse ws:p1</Text>
			</Button>
			<Button
				onPress={() => void store.setSectionCollapsed("env:local", false)}
			>
				<Text>Expand env:local</Text>
			</Button>
		</View>
	);
}

mount(Fixture);

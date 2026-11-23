import { ConnectionPromptSettingsPane } from "./connection-prompt-settings-pane";
import type { SettingsClient } from "./settings-dialog";

export function PromptEnhancementPane(props: { client: SettingsClient }) {
	return (
		<ConnectionPromptSettingsPane
			client={props.client}
			testID="settings-prompt-enhancement"
			labelPrefix="settings.promptEnhancement"
			load={(id) => props.client.loadPromptEnhancementSettings(id)}
			save={(id, enabled, model) =>
				props.client.savePromptEnhancementSettings(id, enabled, model)
			}
			readEvent={(event) =>
				event.type === "prompt_enhancement_settings_changed"
					? event.settings
					: undefined
			}
		/>
	);
}

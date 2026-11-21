import { ConnectionPromptSettingsPane } from "./connection-prompt-settings-pane";
import type { SettingsClient } from "./settings-dialog";

export function NextPromptPane(props: { client: SettingsClient }) {
	return (
		<ConnectionPromptSettingsPane
			client={props.client}
			testID="settings-next-prompt"
			labelPrefix="settings.nextPrompt"
			load={(id) => props.client.loadNextPromptSettings(id)}
			save={(id, enabled, model) =>
				props.client.saveNextPromptSettings(id, enabled, model)
			}
			readEvent={(event) =>
				event.type === "next_prompt_settings_changed"
					? event.settings
					: undefined
			}
		/>
	);
}

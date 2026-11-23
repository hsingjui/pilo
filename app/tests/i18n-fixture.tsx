import { locale, mount, Text, View } from "nsh";
import { Button } from "nsh/base";

import { appLocale, initializeI18n, setAppLocale, t } from "../shell/i18n";

initializeI18n();

mount(() => (
	<View class="gap-2 p-4" testID="fixture">
		<Text testID="locale">{() => `Locale: ${appLocale()} / ${locale()}`}</Text>
		<Text testID="plain">{() => t("app.selectProject")}</Text>
		<Text testID="interpolated">
			{() => t("project.added", { name: "<b>pilo</b>" })}
		</Text>
		<Text testID="multiple">
			{() =>
				t("project.addedDescription", { connection: "Local", path: "~/code" })
			}
		</Text>
		<Button onPress={() => setAppLocale("zh-CN")}>
			<Text>Use Chinese</Text>
		</Button>
		<Button onPress={() => setAppLocale("en-US")}>
			<Text>Use English</Text>
		</Button>
	</View>
));

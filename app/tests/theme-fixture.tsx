import { Text, View, mount, setTheme, signal, token, type Tokens } from "nsh";
import { Button } from "nsh/base";
import "../shell/fonts";
import claude from "../../theme/claude-theme.json";
import lody from "../../theme/theme.json";

const names = signal(themeNames(lody));

function themeNames(theme: typeof lody | typeof claude) {
	return [
		...new Set(Object.values(theme.cssVars).flatMap(Object.keys)),
	] as (keyof Tokens)[];
}

mount(() => (
	<View class="flex-1 bg-background" testID="surface">
		<Text>
			{() =>
				names()
					.filter((name) => token(name) === undefined)
					.join(", ") || "ready"
			}
		</Text>
		<Text>{() => `Sheet radius: ${token("pilo-sheet-item-radius")}`}</Text>
		<Text>{() => `Font: ${token("font-sans")}`}</Text>
		<Button
			onPress={() => {
				setTheme({ cssVars: claude.cssVars });
				names.set(themeNames(claude));
			}}
		>
			<Text>Apply Claude</Text>
		</Button>
		<Button
			onPress={() => {
				setTheme(null);
				names.set(themeNames(lody));
			}}
		>
			<Text>Restore Lody</Text>
		</Button>
	</View>
));

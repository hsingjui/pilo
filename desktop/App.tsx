import { mount, Text, View } from "nsh";

import "./app/fonts";

function App() {
	return (
		<View testID="app" class="flex-1 items-center justify-center bg-background">
			<Text>Pilo</Text>
		</View>
	);
}

mount(App);

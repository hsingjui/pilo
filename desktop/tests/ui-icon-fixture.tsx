import { Text, View, mount, signal, type ViewRef } from "nsh";
import { Button } from "nsh/base";
import { Icon, type IconName } from "../ui/icon";
import icons from "../app/lucide-icons.json";

const refs: ViewRef[] = [];
const result = signal("Not measured");

mount(() => (
	<View class="gap-2 p-4 bg-background">
		<View class="flex-row gap-2">
			{[undefined, 24, 32].map((size, index) => (
				<Icon
					name="CircleAlert"
					size={size}
					testID={`icon-${index}`}
					ref={(node) => {
						refs[index] = node;
					}}
				/>
			))}
			<Icon name="Palette" color="#ff0000" accessibilityLabel="Palette icon" />
		</View>
		<View class="flex-row flex-wrap gap-1">
			{(Object.keys(icons) as IconName[]).map((name) => (
				<Icon name={name} testID={`catalog-${name}`} />
			))}
		</View>
		<Button
			onPress={async () => {
				const sizes = await Promise.all(refs.map((ref) => ref.measure()));
				result.set(
					sizes
						.map(
							(size) =>
								`${size?.bounds.size.width}x${size?.bounds.size.height}`,
						)
						.join(", "),
				);
			}}
		>
			<Text>Measure icons</Text>
		</Button>
		<Text>{result}</Text>
	</View>
));

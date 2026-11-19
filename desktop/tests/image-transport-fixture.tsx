import { Image, mount, signal, Text, View } from "nsh";
import { ImageFixture } from "app/native";

const bytes = ImageFixture.bytes();
const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
const bytesStatus = signal("bytes: loading");
const pathStatus = signal("path: loading");

mount(() => (
	<View>
		<Text>
			{bytes instanceof Uint8Array
				? "native Uint8Array"
				: "invalid native bytes"}
		</Text>
		<Image
			src={url}
			style={{ width: 32, height: 32 }}
			onLoad={({ size }) => {
				URL.revokeObjectURL(url);
				bytesStatus.set(`bytes: ${size.width}x${size.height}`);
			}}
			onError={({ message }) => {
				URL.revokeObjectURL(url);
				bytesStatus.set(`bytes: ${message}`);
			}}
		/>
		<Text>{bytesStatus}</Text>
		<Image
			src={ImageFixture.path()}
			style={{ width: 32, height: 32 }}
			onLoad={({ size }) =>
				pathStatus.set(`path: ${size.width}x${size.height}`)
			}
			onError={({ message }) => pathStatus.set(`path: ${message}`)}
		/>
		<Text>{pathStatus}</Text>
	</View>
));

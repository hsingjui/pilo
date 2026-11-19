import { mount, Text } from "nsh";
import { AppInfo } from "app/native";

mount(() => <Text testID="version">{AppInfo.version()}</Text>);

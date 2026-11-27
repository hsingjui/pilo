import type { RemoteScopes } from "@shared/api/remote-types";
import { t } from "../shell/i18n";
import { Select } from "../ui/select";

export function remoteScopeLabel(scopes: RemoteScopes): string {
	return t(
		scopes === "chat"
			? "settings.remoteScopeChat"
			: "settings.remoteScopeWorkspace",
	);
}

export function RemoteScopeSelect(props: {
	testID: string;
	label: string;
	value: RemoteScopes;
	disabled: boolean;
	onChange: (scopes: RemoteScopes) => void;
}) {
	return (
		<Select
			testID={props.testID}
			accessibilityLabel={props.label}
			size="sm"
			class="w-[180px]"
			items={[
				{ value: "chat", title: remoteScopeLabel("chat") },
				{ value: "chat,workspace", title: remoteScopeLabel("chat,workspace") },
			]}
			value={props.value}
			disabled={props.disabled}
			onChange={({ value }) => {
				if (value === "chat" || value === "chat,workspace")
					props.onChange(value);
			}}
		/>
	);
}

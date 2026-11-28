import { type Accessor, type JSX, Text, token, View } from "nsh";

import type { Connection } from "@shared/api/pi-runtime-types";
import { t } from "../shell/i18n";
import { Icon } from "../ui/icon";
import { tactileTransition } from "../ui/motion";
import { Spinner } from "../ui/spinner";
import { SettingsIconButton } from "./layout";

type ConnectionRowKind = Connection["kind"]["type"] | "remote";

function connectionIcon(kind: ConnectionRowKind): JSX.Element {
	return (
		<Icon
			name={kind === "local" ? "Laptop" : kind === "wsl" ? "Monitor" : "Server"}
			size={14}
			color={token("muted-foreground")}
		/>
	);
}

function rowButton(button: {
	testID: string;
	label: string;
	icon: JSX.Element;
	disabled: boolean;
	destructive?: boolean;
	selected?: boolean;
	onPress: () => void;
}) {
	return (
		<SettingsIconButton
			testID={button.testID}
			disabled={button.disabled}
			selected={button.selected}
			destructive={button.destructive}
			accessibilityLabel={button.label}
			tooltip={button.label}
			onPress={button.onPress}
		>
			{button.icon}
		</SettingsIconButton>
	);
}

/** One connection list row: icon, name, description and actions. */
export function ConnectionRow(props: {
	id: string;
	kind: ConnectionRowKind;
	label: string;
	description: JSX.Element;
	projectCount?: number;
	shownInHome: boolean;
	testing: Accessor<boolean>;
	busy: Accessor<boolean>;
	actions?: JSX.Element;
	onToggleShown?: (shown: boolean) => void;
	onTest?: () => void;
	onConfigure?: () => void;
	onEdit?: () => void;
	onRemove?: () => void;
}) {
	const rowBusy = () => props.busy() || props.testing();
	return (
		<View
			class="border-b border-border/60 px-3 py-2.5 hover:bg-hover/30 last:border-b-0"
			style={tactileTransition("background-color")}
		>
			<View class="flex-row items-center gap-2.5">
				<View class="size-6 shrink-0 items-center justify-center">
					{connectionIcon(props.kind)}
				</View>
				<View class="min-w-0 flex-1">
					<Text class="font-sans truncate text-sm font-medium">
						{props.label}
					</Text>
					<View class="mt-0.5 flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
						{props.description}
						{props.projectCount === undefined ? null : (
							<Text class="font-sans text-[11px] text-muted-foreground">
								{props.projectCount > 0
									? t("connection.projectCount", { count: props.projectCount })
									: t("connection.unlinkedProjects")}
							</Text>
						)}
					</View>
				</View>
				<View class="shrink-0 flex-row items-center gap-1">
					{props.onToggleShown
						? rowButton({
								testID: `settings-conn-home-${props.id}`,
								label: t("connection.shownInHome"),
								icon: (
									<Icon name={props.shownInHome ? "Eye" : "EyeOff"} size={16} />
								),
								disabled: rowBusy(),
								selected: props.shownInHome,
								onPress: () => props.onToggleShown?.(!props.shownInHome),
							})
						: null}
					{props.onTest
						? rowButton({
								testID: `settings-conn-test-${props.id}`,
								label: t("connection.test"),
								icon: props.testing() ? (
									<Spinner size={16} />
								) : (
									<Icon name="Wifi" size={16} />
								),
								disabled: rowBusy(),
								onPress: props.onTest,
							})
						: null}
					{props.onConfigure
						? rowButton({
								testID: `settings-conn-configure-${props.id}`,
								label: t("connection.configure"),
								icon: <Icon name="Settings2" size={16} />,
								disabled: rowBusy(),
								onPress: props.onConfigure,
							})
						: null}
					{props.onEdit
						? rowButton({
								testID: `settings-conn-edit-${props.id}`,
								label: t(
									props.kind === "remote"
										? "hosts.editConnection"
										: "connection.editSsh",
								),
								icon: <Icon name="Pencil" size={16} />,
								disabled: rowBusy(),
								onPress: props.onEdit,
							})
						: null}
					{props.actions}
					{props.onRemove
						? rowButton({
								testID: `settings-conn-remove-${props.id}`,
								label: t("connection.remove"),
								icon: <Icon name="Trash2" size={16} />,
								disabled: rowBusy(),
								destructive: true,
								onPress: props.onRemove,
							})
						: null}
				</View>
			</View>
		</View>
	);
}

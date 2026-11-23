import { type Accessor, type JSX, Text, token, View } from "nsh";

import type { Connection } from "@shared/api/pi-runtime-types";
import { t } from "../app/i18n";
import { Icon } from "../ui/icon";
import { Spinner } from "../ui/spinner";
import { SettingsIconButton } from "./layout";

function connectionIcon(connection: Connection): JSX.Element {
	return (
		<Icon
			name={
				connection.kind.type === "local"
					? "Laptop"
					: connection.kind.type === "wsl"
						? "Monitor"
						: "Server"
			}
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

/** One connection list row: icon, name, description, actions, result line. */
export function ConnectionRow(props: {
	connection: Connection;
	label: string;
	description: JSX.Element;
	projectCount: number;
	shownInHome: boolean;
	testing: Accessor<boolean>;
	busy: Accessor<boolean>;
	result: Accessor<string | undefined>;
	onToggleShown: (shown: boolean) => void;
	onTest: () => void;
	onConfigure: () => void;
	onEdit?: () => void;
	onRemove?: () => void;
}) {
	const connection = props.connection;
	const rowBusy = () => props.busy() || props.testing();
	return (
		<View class="border-b border-border/60 px-3 py-2.5 hover:bg-hover/30 last:border-b-0">
			<View class="flex-row items-center gap-2.5">
				<View class="size-6 shrink-0 items-center justify-center">
					{connectionIcon(connection)}
				</View>
				<View class="min-w-0 flex-1">
					<Text class="font-sans truncate text-sm font-medium">
						{props.label}
					</Text>
					<View class="mt-0.5 flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
						{props.description}
						<Text class="font-sans text-[11px] text-muted-foreground">
							{props.projectCount > 0
								? t("connection.projectCount", {
										count: props.projectCount,
									})
								: t("connection.unlinkedProjects")}
						</Text>
					</View>
				</View>
				<View class="shrink-0 flex-row items-center gap-1">
					{rowButton({
						testID: `settings-conn-home-${connection.id}`,
						label: t("connection.shownInHome"),
						icon: (
							<Icon name={props.shownInHome ? "Eye" : "EyeOff"} size={16} />
						),
						disabled: rowBusy(),
						selected: props.shownInHome,
						onPress: () => props.onToggleShown(!props.shownInHome),
					})}
					{rowButton({
						testID: `settings-conn-test-${connection.id}`,
						label: t("connection.test"),
						icon: props.testing() ? (
							<Spinner size={16} />
						) : (
							<Icon name="Wifi" size={16} />
						),
						disabled: rowBusy(),
						onPress: props.onTest,
					})}
					{rowButton({
						testID: `settings-conn-configure-${connection.id}`,
						label: t("connection.configure"),
						icon: <Icon name="Settings2" size={16} />,
						disabled: rowBusy(),
						onPress: props.onConfigure,
					})}
					{props.onEdit
						? rowButton({
								testID: `settings-conn-edit-${connection.id}`,
								label: t("connection.editSsh"),
								icon: <Icon name="Pencil" size={16} />,
								disabled: rowBusy(),
								onPress: props.onEdit,
							})
						: null}
					{props.onRemove
						? rowButton({
								testID: `settings-conn-remove-${connection.id}`,
								label: t("connection.remove"),
								icon: <Icon name="Trash2" size={16} />,
								disabled: rowBusy(),
								destructive: true,
								onPress: props.onRemove,
							})
						: null}
				</View>
			</View>
			{() =>
				props.result() ? (
					<Text
						testID={`settings-conn-result-${connection.id}`}
						class="font-sans mt-1.5 text-[11px] text-muted-foreground"
					>
						{props.result()}
					</Text>
				) : null
			}
		</View>
	);
}

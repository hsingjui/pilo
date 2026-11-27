import { Text, token, View } from "nsh";

import { t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import type { HostEntry, HostEntryStatus, HostRegistry } from "./host-registry";

const STATUS_KEYS = {
	connected: "hosts.connected",
	connecting: "hosts.connecting",
	offline: "hosts.offline",
	disconnected: "hosts.disconnected",
	unauthorized: "hosts.unauthorized",
	incompatible: "hosts.incompatible",
	rateLimited: "hosts.rateLimited",
} as const satisfies Record<HostEntryStatus, string>;

function statusColor(status: HostEntryStatus) {
	switch (status) {
		case "connected":
			return token("status-success");
		case "connecting":
		case "rateLimited":
			return token("status-warning");
		case "unauthorized":
		case "incompatible":
			return token("status-danger");
		default:
			return token("muted-foreground");
	}
}

/** The sidebar's top level: this machine and every paired remote Host. */
export function HostList(props: {
	registry: HostRegistry;
	onAddRemote: () => void;
	onRemove: (entry: HostEntry) => void;
}) {
	const { registry } = props;
	return (
		<View testID="sidebar-hosts" class="gap-0.5 px-1.5 pt-1">
			<Each of={registry.entries()} key={(entry: HostEntry) => entry.hostId}>
				{(entry: () => HostEntry) => {
					const active = () => registry.activeHostId() === entry().hostId;
					const remote = () => entry().kind === "remote";
					return (
						<View class="group flex-row items-center gap-0.5">
							<Button
								testID={`sidebar-host-${entry().hostId}`}
								variant="ghost"
								size="sm"
								class={`min-w-0 flex-1 justify-start gap-2 ${active() ? "bg-sidebar-accent" : ""}`}
								accessibilityLabel={
									remote() ? entry().name : t("hosts.thisMachine")
								}
								onPress={() => registry.activate(entry().hostId)}
							>
								<Icon
									name={remote() ? "Server" : "Laptop"}
									size={14}
									color={token("muted-foreground")}
								/>
								<Text class="font-sans min-w-0 flex-1 truncate text-left">
									{() => (remote() ? entry().name : t("hosts.thisMachine"))}
								</Text>
								{() =>
									remote() ? (
										<View class="flex-row items-center gap-1">
											<View
												class="size-1.5 rounded-full"
												style={{ backgroundColor: statusColor(entry().status) }}
											/>
											<Text
												testID={`sidebar-host-status-${entry().hostId}`}
												class="font-sans text-[11px] text-muted-foreground"
											>
												{() => t(STATUS_KEYS[entry().status])}
											</Text>
										</View>
									) : null
								}
							</Button>
							{() =>
								remote() ? (
									<Menu
										align="end"
										popupStyle={{ minWidth: 0 }}
										trigger={
											<Button
												testID={`sidebar-host-menu-${entry().hostId}`}
												variant="ghost"
												size="icon"
												class="size-6"
												accessibilityLabel={t("hosts.hostMenu")}
											>
												<Icon name="MoreHorizontal" size={14} />
											</Button>
										}
									>
										<View class="gap-1">
											{() =>
												entry().session ? (
													<MenuItem
														testID={`sidebar-host-disconnect-${entry().hostId}`}
														indicatorClass="hidden"
														icon={<Icon name="WifiOff" size={14} />}
														onSelect={() => registry.disconnect(entry().hostId)}
													>
														<Text class="font-sans">
															{t("hosts.disconnect")}
														</Text>
													</MenuItem>
												) : (
													<MenuItem
														testID={`sidebar-host-connect-${entry().hostId}`}
														indicatorClass="hidden"
														icon={<Icon name="Plug" size={14} />}
														onSelect={() =>
															void registry.connect(entry().hostId)
														}
													>
														<Text class="font-sans">{t("hosts.connect")}</Text>
													</MenuItem>
												)
											}
											<MenuItem
												testID={`sidebar-host-remove-${entry().hostId}`}
												indicatorClass="hidden"
												variant="destructive"
												icon={<Icon name="Trash2" size={14} />}
												onSelect={() => props.onRemove(entry())}
											>
												<Text class="font-sans">{t("hosts.remove")}</Text>
											</MenuItem>
										</View>
									</Menu>
								) : null
							}
						</View>
					);
				}}
			</Each>
			<Button
				testID="sidebar-add-remote-host"
				variant="ghost"
				size="sm"
				class="justify-start gap-2"
				onPress={props.onAddRemote}
			>
				<Icon name="Plus" size={14} color={token("muted-foreground")} />
				<Text class="font-sans text-muted-foreground">
					{() => t("hosts.addRemote")}
				</Text>
			</Button>
			<View class="mx-1.5 mt-1 border-b border-sidebar-border" />
		</View>
	);
}

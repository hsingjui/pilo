import { computed, type JSX, Text, token, View } from "nsh";

import { t } from "../shell/i18n";
import { SidebarSectionHeader } from "../shell/sidebar-parts";
import { Spinner } from "../ui/spinner";
import type { HostEntry, HostRegistry } from "./host-registry";

/** Keeps each visible Host in the same slot whether active or collapsed. */
export function HostList(props: {
	registry: HostRegistry;
	sectionClass: string;
	revealProjects: boolean;
	renderActive: (hostId: string) => JSX.Element | null;
}) {
	const { registry } = props;
	const entries = computed(() =>
		registry.entries().filter((host) => host.shownInHome),
	);
	return (
		<Each of={entries()} key={(host: HostEntry) => host.hostId}>
			{(host) => {
				const { hostId } = host();
				const section = `env:host:${hostId}`;
				const name = () =>
					host().kind === "local" ? t("common.local") : host().name;
				const opening = () => registry.openingHostId() === hostId;
				const busy = () => opening() || host().status === "connecting";
				const statusLabel = computed(() => {
					const { status, session } = host();
					if (opening())
						return t(
							status === "connected" ? "common.loading" : "hosts.connecting",
						);
					if (status !== "connected") return t(`hosts.${status}`);
					return session?.store.state().status.type === "failed"
						? t("common.loadFailed")
						: null;
				});
				return () =>
					registry.activeHostId() === hostId ? (
						props.renderActive(hostId)
					) : (
						<View testID={section} class={props.sectionClass}>
							<SidebarSectionHeader
								testID={`${section}:toggle`}
								icon="Monitor"
								title={name}
								label={() =>
									[
										busy() ? null : t("sidebar.expandEnvironment"),
										name(),
										statusLabel(),
									]
										.filter(Boolean)
										.join(" · ")
								}
								collapsed={() => true}
								disabled={busy()}
								onPress={() =>
									registry.activate(hostId, {
										revealProjects: props.revealProjects,
									})
								}
							>
								{() =>
									statusLabel() ? (
										<View class="shrink-0 flex-row items-center gap-1">
											{() =>
												busy() ? (
													<Spinner
														size={12}
														color={token("muted-foreground")}
													/>
												) : null
											}
											<Text class="font-sans text-[11px] text-muted-foreground">
												{statusLabel}
											</Text>
										</View>
									) : null
								}
							</SidebarSectionHeader>
						</View>
					);
			}}
		</Each>
	);
}

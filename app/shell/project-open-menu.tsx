import { Canvas, computed, Image, Path2D, Text, token, View } from "nsh";

import type { Project } from "@shared/api/projects-types";
import vscodeIcon from "../assets/editors/vscode.svg";
import wincIcon from "../assets/editors/winc.svg";
import type { ProjectNativeApp } from "../client/nsh-pilo-client";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuCheck } from "../ui/menu-check";
import { MenuItem } from "../ui/menu-item";
import { Tooltip } from "../ui/tooltip";
import { t } from "./i18n";
import {
	chooseProjectOpener,
	chosenProjectOpener,
	openProject,
	type ProjectOpenerId,
	projectOpeners,
} from "./project-opener";

// Zed and Cursor keep their official black/white marks.
const BRAND_PATHS = {
	zed: "M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z",
	cursor:
		"M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
} as const;

function BrandIcon(props: { path: string }) {
	const path = new Path2D(props.path);
	return (
		<Canvas
			style={{ width: 16, height: 16, flexShrink: 0 }}
			accessibilityElementsHidden
			draw={(cx, size) => {
				cx.scale(size.width / 24, size.height / 24);
				cx.fillStyle = token("foreground");
				cx.fill(path);
			}}
		/>
	);
}

function OpenerIcon(props: { opener: ProjectOpenerId }) {
	switch (props.opener) {
		case "zed":
		case "cursor":
			return <BrandIcon path={BRAND_PATHS[props.opener]} />;
		// Clip SVG images so their intrinsic dimensions (e.g. winc.svg's 1024x1024)
		// do not propagate as scrollable overflow into Menu's inner Scroll view.
		case "vscode":
			return <Image src={vscodeIcon} class="size-4 shrink-0 overflow-hidden" />;
		case "winc":
			return <Image src={wincIcon} class="size-4 shrink-0 overflow-hidden" />;
		case "explorer":
		case "finder":
			return <Icon name="FolderOpen" size={16} />;
		case "powershell":
		case "ghostty":
			return <Icon name="Terminal" size={16} />;
	}
}

/**
 * The header's quick open: a button that opens the project in the app the
 * user chose last, and a menu to open it in another, as the WebUI header's.
 */
export function ProjectOpenMenu(props: {
	project: () => Project;
	openInApp: (
		projectId: string,
		app: ProjectNativeApp,
		path?: string,
	) => Promise<void>;
	onError: (message: string) => void;
}) {
	const openers = computed(() =>
		projectOpeners(props.project()).map((opener) => ({
			id: opener.id,
			name: opener.id === "explorer" ? t("chat.fileExplorer") : opener.name,
		})),
	);
	const selected = computed(() => {
		const chosen = chosenProjectOpener();
		return openers().find(({ id }) => id === chosen) ?? openers()[0]!;
	});
	const openLabel = () =>
		t("chat.openProjectWithEditor", { editor: selected().name });
	const open = (opener: { id: ProjectOpenerId; name: string }) => {
		chooseProjectOpener(opener.id);
		void openProject(props.project(), opener.id, props.openInApp).catch(
			(error: unknown) => {
				console.warn(`Failed to open the project in ${opener.name}`, error);
				props.onError(
					t("chat.openProjectInAppFailed", { editor: opener.name }),
				);
			},
		);
	};
	return (
		<View
			testID="project-open"
			class="shrink-0 flex-row items-center"
			accessibilityLabel={t("chat.quickOpen")}
		>
			<Button
				testID="project-open-button"
				variant="ghost"
				size="icon"
				class="size-7"
				accessibilityLabel={openLabel()}
				tooltip={
					<Tooltip>
						<Text class="font-sans">{openLabel}</Text>
					</Tooltip>
				}
				onPress={() => open(selected())}
			>
				{() => {
					const opener = selected().id;
					return <OpenerIcon opener={opener} />;
				}}
			</Button>
			<Menu
				align="end"
				popupClass="w-44 min-w-44"
				trigger={
					<Button
						testID="project-open-choose"
						variant="ghost"
						size="icon"
						class="h-7 w-4"
						accessibilityLabel={t("chat.chooseProjectApp")}
					>
						<Icon
							name="ChevronDown"
							size={10}
							color={token("muted-foreground")}
						/>
					</Button>
				}
			>
				<View class="gap-1">
					{() =>
						openers().map((opener) => (
							<MenuItem
								testID={`project-open:${opener.id}`}
								role="menuitemradio"
								checked={selected().id === opener.id}
								indicatorClass="hidden"
								icon={<OpenerIcon opener={opener.id} />}
								onSelect={() => open(opener)}
							>
								<Text class="min-w-0 flex-1 truncate font-sans">
									{opener.name}
								</Text>
								<MenuCheck checked={() => selected().id === opener.id} />
							</MenuItem>
						))
					}
				</View>
			</Menu>
		</View>
	);
}

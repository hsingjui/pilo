import {
	type Accessor,
	computed,
	keyboardFrame,
	platform,
	Scroll,
	signal,
	Text,
	token,
	View,
	windowSize,
} from "nsh";
import {
	Button as BaseButton,
	MenuItem as BaseMenuItem,
	Popover as BasePopover,
	type PopoverProps,
} from "nsh/base";

import { isDefaultWorkspace, type Project } from "@shared/api/projects-types";
import { ConversationColumnLayout } from "../chat/conversation-column";
import type { AppStore } from "../state/app-store";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { blurOnPointerPress, focusRingStyle } from "../ui/focus-ring-style";
import { Icon } from "../ui/icon";
import { Menu, menuPopupStyle } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import {
	chevronRotateStyle,
	popupMotionStyles,
	tactileTransition,
} from "../ui/motion";
import { Skeleton } from "../ui/skeleton";
import { displayFontFamily } from "./appearance";
import { connectionLabel } from "./connection-label";
import { t } from "./i18n";
import { PiLogo } from "./pi-logo";

function projectLabel(project: Project) {
	return isDefaultWorkspace(project)
		? t("sidebar.defaultWorkspace")
		: project.name;
}

/**
 * The new-session landing: Pi's hero with the project picker, like the WebUI
 * app's empty chat. Without projects it asks for one instead.
 */
export function SessionLanding(
	props:
		| { loading: true; touch?: boolean }
		| {
				store: AppStore;
				project: Accessor<Project | null>;
				onAddProject?: () => void;
				/** Uses 44px touch targets and an anchored popover instead of a bottom sheet. */
				touch?: boolean;
				/** Visible height when the host already accounts for the soft keyboard. */
				availableHeight?: () => number;
		  },
) {
	const loading = "loading" in props;
	const touch = Boolean(props.touch);
	const projects = computed(() =>
		"store" in props ? props.store.state().projects : [],
	);
	const layout = ConversationColumnLayout();
	return (
		<View
			testID={loading ? undefined : "landing"}
			class="w-full min-w-0 items-center justify-center gap-3 py-4"
		>
			<PiLogo
				size={64}
				color={token(loading ? "skeleton-line-strong" : "foreground")}
			/>
			<View class="relative max-w-full">
				<Text
					testID={loading ? undefined : "workspace-title"}
					accessible={!loading}
					accessibilityElementsHidden={loading}
					class={`text-center font-semibold tracking-tight text-foreground ${
						layout().narrow ? "text-2xl" : "text-3xl"
					}`}
					style={{
						...tactileTransition("opacity"),
						fontFamily: displayFontFamily(),
						opacity: loading ? 0 : 1,
					}}
				>
					{() => t("chat.todayPrompt")}
				</Text>
				{loading ? <Skeleton class="absolute inset-x-0 inset-y-1" /> : null}
			</View>
			{() =>
				"loading" in props ? (
					// The project picker's outline: name, connection and chevron.
					<View
						class={classNames(
							"flex-row items-center justify-center gap-1.5",
							touch ? "min-h-11 px-3" : "min-h-(--pilo-button-sm-height) px-2",
						)}
					>
						<Skeleton class="h-3.5 w-20" />
						<Skeleton class="h-3 w-12" />
						<Skeleton class="size-3.5" />
					</View>
				) : projects().length > 0 ? (
					<LandingProjectPicker
						projects={projects}
						project={props.project}
						touch={touch}
						availableHeight={props.availableHeight}
						onSelect={(projectId) => props.store.selectProject(projectId)}
					/>
				) : props.onAddProject ? (
					<>
						<Text class="font-sans text-center text-sm text-muted-foreground">
							{() => t("app.addProjectFirst")}
						</Text>
						<Button testID="landing-add-project" onPress={props.onAddProject}>
							<Text class="font-sans">{() => t("project.addProject")}</Text>
						</Button>
					</>
				) : (
					<Text class="font-sans text-center text-sm text-muted-foreground">
						{() => t("app.addProjectOnDesktop")}
					</Text>
				)
			}
		</View>
	);
}

/**
 * The WebUI landing's `DraftProjectPicker`: a borderless trigger with the
 * project and its connection, and a menu of every project.
 */
export function LandingProjectPicker(props: {
	projects: Accessor<Project[]>;
	project: Accessor<Project | null>;
	onSelect: (projectId: string) => void;
	touch?: boolean;
	availableHeight?: () => number;
	onPosition?: PopoverProps["onPosition"];
}) {
	const touch = Boolean(props.touch);
	const useAnchoredPopover = touch || !platform.desktop;
	const accessibilityLabel = () => {
		const project = props.project();
		return project
			? `${t("app.selectProject")}: ${projectLabel(project)} · ${connectionLabel(project.connection)}`
			: t("app.selectProject");
	};
	const open = signal(false);
	const pointerBlur = blurOnPointerPress();
	const trigger = (
		// A plain press target, as the WebUI trigger is: no `Button` press
		// scale, which would shrink the text while it is held.
		<BaseButton
			testID="landing-project-picker"
			ref={pointerBlur.ref}
			onMouseUp={pointerBlur.onMouseUp}
			class={classNames(
				"max-w-full flex-row items-center gap-1.5 hover:bg-hover focus-visible:outline-hidden",
				touch
					? "min-h-11 rounded-(--pilo-mobile-radius-md) px-3 active:bg-hover"
					: "min-h-(--pilo-button-sm-height) rounded-lg px-2",
				open() && "bg-hover",
			)}
			style={tactileTransition("background-color")}
			focusVisibleStyle={focusRingStyle(token("ring"))}
			accessibilityLabel={accessibilityLabel()}
		>
			{() => {
				const project = props.project();
				return (
					<>
						<Text
							class={classNames(
								"min-w-0 shrink truncate font-sans text-sm font-medium text-foreground",
								touch && "text-(length:--pilo-ui-text-sm) leading-tight",
							)}
						>
							{project ? projectLabel(project) : t("app.selectProject")}
						</Text>
						{project ? (
							<>
								<Text
									class={classNames(
										"shrink-0 font-sans text-sm text-muted-foreground",
										touch && "text-(length:--pilo-ui-text-sm) leading-tight",
									)}
								>
									·
								</Text>
								<Text
									class={classNames(
										"min-w-0 shrink truncate font-sans text-xs text-muted-foreground",
										touch && "text-(length:--pilo-ui-text-xs) leading-snug",
									)}
								>
									{connectionLabel(project.connection)}
								</Text>
							</>
						) : null}
					</>
				);
			}}
			<View
				class="shrink-0 items-center justify-center"
				style={chevronRotateStyle(open(), 0, 180)}
			>
				<Icon
					name="ChevronDown"
					size={touch ? 15 : 14}
					color={token("muted-foreground")}
				/>
			</View>
		</BaseButton>
	);

	// On phone/compact idioms `nsh/base`'s `Menu` turns into a bottom sheet
	// (leaving fixed-width pickers stranded at the bottom of the screen).
	// Anchor a Popover directly under the centered trigger instead.
	if (useAnchoredPopover) {
		const motion = () => popupMotionStyles();
		const popupWidth = () => {
			const max = Math.max(200, windowSize().width - 32);
			return {
				minWidth: Math.min(220, max),
				maxWidth: Math.min(340, max),
			};
		};
		const maxListHeight = () => {
			const available =
				props.availableHeight?.() ??
				Math.max(0, windowSize().height - keyboardFrame().height);
			return Math.min(288, Math.max(160, Math.round(available * 0.4)));
		};
		return (
			<BasePopover
				open={open()}
				onOpenChange={(event) => open.set(event.open)}
				onPosition={props.onPosition}
				placement="bottom"
				align="center"
				offset={6}
				margin={16}
				popupClass="overflow-hidden rounded-(--pilo-mobile-menu-radius) bg-(--pilo-menu-background) p-(--pilo-mobile-menu-padding) font-sans text-foreground"
				popupStyle={[menuPopupStyle(), popupWidth()]}
				popupStartingStyle={motion().popupStartingStyle}
				popupEndingStyle={motion().popupEndingStyle}
				trigger={trigger}
			>
				<Scroll bounces={false} style={{ maxHeight: maxListHeight() }}>
					<View
						testID="landing-project-picker-popup"
						role="menu"
						class="w-full gap-0.5"
					>
						{props.projects().map((candidate) => {
							const selected = () => props.project()?.id === candidate.id;
							const label = projectLabel(candidate);
							const connection = connectionLabel(candidate.connection);
							return (
								<BaseMenuItem
									testID={`landing-project:${candidate.id}`}
									role="menuitemradio"
									checked={selected()}
									closeOnSelect={false}
									accessibilityLabel={`${label} · ${connection}`}
									class={classNames(
										"min-h-11 w-full flex-row items-center gap-2.5 rounded-(--pilo-mobile-menu-item-radius) px-2.5 py-1.5 text-left hover:bg-hover active:bg-hover",
										selected() && "bg-muted/70",
									)}
									style={tactileTransition("background-color, color")}
									onSelect={() => {
										props.onSelect(candidate.id);
										open.set(false);
									}}
								>
									<Icon
										name="Folder"
										size={15}
										color={token(
											selected() ? "foreground" : "muted-foreground",
										)}
									/>
									<Text
										class={classNames(
											"min-w-0 flex-1 truncate font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-foreground",
											selected() ? "font-semibold" : "font-medium",
										)}
									>
										{label}
									</Text>
									<Text class="min-w-0 max-w-[42%] shrink truncate font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-muted-foreground">
										{connection}
									</Text>
									<View class="size-4 shrink-0 items-center justify-center">
										{() =>
											selected() ? (
												<Icon name="Check" size={14} color={token("primary")} />
											) : null
										}
									</View>
								</BaseMenuItem>
							);
						})}
					</View>
				</Scroll>
			</BasePopover>
		);
	}

	return (
		<Menu
			align="center"
			open={open()}
			onOpenChange={(event) => open.set(event.open)}
			// React's `min-w-48 max-w-[calc(100vw-2rem)]`.
			popupStyle={{ minWidth: 192, maxWidth: windowSize().width - 32 }}
			trigger={trigger}
		>
			<View class="gap-1">
				{props.projects().map((candidate) => (
					<MenuItem
						testID={`landing-project:${candidate.id}`}
						indicatorClass="hidden"
						icon={<Icon name="Folder" size={14} />}
						class={
							props.project()?.id === candidate.id ? "bg-hover" : undefined
						}
						onSelect={() => props.onSelect(candidate.id)}
					>
						<Text
							class={`min-w-0 flex-1 truncate font-sans font-medium ${
								props.project()?.id === candidate.id
									? "text-hover-foreground"
									: ""
							}`}
						>
							{projectLabel(candidate)}
						</Text>
						<Text class="min-w-0 max-w-[50%] shrink truncate font-sans text-xs text-muted-foreground">
							{connectionLabel(candidate.connection)}
						</Text>
					</MenuItem>
				))}
			</View>
		</Menu>
	);
}

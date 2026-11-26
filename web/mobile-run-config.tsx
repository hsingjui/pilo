import {
	computed,
	createAnimatedValue,
	effect,
	keyboardFrame,
	Overlay,
	PanResponder,
	reduceMotion,
	safeArea,
	Scroll,
	signal,
	Text,
	token,
	untracked,
	View,
	windowSize,
} from "nsh";
import { Button as BaseButton } from "nsh/base";

import type { PiModel } from "@shared/api/pi-runtime-types";
import { resolveMobileSheetMaxHeight } from "@shared/mobile-viewport";
import {
	piModelsMatch,
	piThinkingLevelLabel,
	toggleProjectScopeDefaultModel,
} from "@shared/pi-model-selection";
import type { ProjectScopedModel } from "@shared/project-model-scope";

import { t } from "../app/shell/i18n";
import { PiLogo } from "../app/shell/pi-logo";
import type { ComposerRunConfigProps } from "../app/composer/composer-run-config";
import { Button } from "../app/ui/button";
import { classNames } from "../app/ui/class-names";
import { Icon } from "../app/ui/icon";
import { Input } from "../app/ui/input";
import { MOTION, tactileTransition } from "../app/ui/motion";
import { Skeleton } from "../app/ui/skeleton";
import { Spinner } from "../app/ui/spinner";
import { Tab } from "../app/ui/tab";
import { Tabs } from "../app/ui/tabs";
import { styleVar } from "../app/ui/theme-style";
import { MOBILE_TEXT } from "./mobile-typography";
import { MobileViewport } from "./mobile-viewport";

function identity(provider: string, id: string) {
	return JSON.stringify([provider, id]);
}

export interface MobileRunConfigProps extends ComposerRunConfigProps {
	toolbarWidth: () => number;
}

/**
 * Touch-first model + reasoning bottom sheet for nsh Web, aligned with React's
 * mobile `ComposerRunConfig` + `ChatModelPicker` (`compact={false}`,
 * `canEditScope={false}`):
 * - Single bottom sheet with model list (Scope / All toggle, search, 2-line
 *   model rows, always-visible default star) AND the 4-column reasoning level
 *   grid directly underneath — no nested submenus or Scope editor.
 * - Lifts smoothly above the software keyboard and respects bottom safe area.
 */
export function MobileRunConfig(props: MobileRunConfigProps) {
	const open = signal(false);
	const mounted = signal(false);
	const query = signal("");
	const view = signal<"scope" | "all">("scope");
	const saveError = signal<string | null>(null);

	const sheetHeight = signal(380);
	const progress = createAnimatedValue(0);
	const sheetTranslateY = computed(() =>
		progress.interpolate({
			inputRange: [0, 1],
			outputRange: [Math.max(160, sheetHeight()), 0],
			extrapolate: "clamp",
		}),
	);
	const backdropOpacity = progress.interpolate({
		inputRange: [0, 1],
		outputRange: [0, 0.4],
		extrapolate: "clamp",
	});

	let dismissVelocity = 0;

	const settleOpen = (velocity = 0) => {
		if (reduceMotion()) {
			progress.set(1);
			return;
		}
		void progress.spring(1, { ...MOTION.spring.smooth, velocity });
	};

	const settleClosed = (velocity = 0) => {
		if (reduceMotion()) {
			progress.set(0);
			if (!open()) {
				mounted.set(false);
				query.set("");
				saveError.set(null);
			}
			return;
		}
		void progress
			.spring(0, { ...MOTION.spring.smooth, velocity })
			.then(({ finished }) => {
				if (finished && !open()) {
					mounted.set(false);
					query.set("");
					saveError.set(null);
				}
			});
	};

	effect(() => {
		const isOpen = open();
		untracked(() => {
			if (isOpen) {
				mounted.set(true);
				settleOpen(0);
			} else {
				if (!mounted()) return;
				const velocity = dismissVelocity;
				dismissVelocity = 0;
				settleClosed(velocity);
			}
		});
	});

	const dismissPan = PanResponder.create({
		// nsh Web activates a `panActivation` gate without asking the responder
		// handlers, and a dismissal skips `close()`'s guard, so a save in flight
		// holds the sheet in place and reports its error here.
		onShouldBlockNativeResponder: () => !props.savingScope(),
		onMoveShouldSetPanResponder: (_event, gesture) =>
			open() &&
			!props.savingScope() &&
			gesture.numberActiveTouches === 1 &&
			gesture.dy > 8 &&
			Math.abs(gesture.dy) > Math.abs(gesture.dx) * 1.2,
		onPanResponderMove: (_event, gesture) => {
			const height = Math.max(160, sheetHeight());
			const ratio = Math.max(
				0,
				Math.min(1, 1 - Math.max(0, gesture.dy) / height),
			);
			progress.set(ratio);
		},
		onPanResponderRelease: (_event, gesture) => {
			if (props.savingScope()) return;
			const height = Math.max(160, sheetHeight());
			const normalizedVelocity = -gesture.vy / height;
			if (
				gesture.dy >= Math.min(96, height * 0.25) ||
				(gesture.dy >= 24 && gesture.vy > 350)
			) {
				dismissVelocity = normalizedVelocity;
				open.set(false);
			} else {
				settleOpen(normalizedVelocity);
			}
		},
		onPanResponderTerminate: () => {
			if (open()) settleOpen(0);
		},
		onPanResponderTerminationRequest: () => false,
	});

	const close = () => {
		if (props.savingScope()) return;
		open.set(false);
	};

	const selected = () => props.config()?.model ?? null;
	const modelLabel = () => selected()?.name || selected()?.id || "—";
	const thinking = () => props.config()?.thinkingLevel ?? null;
	const thinkingLevels = computed(() => props.config()?.thinkingLevels ?? [], {
		equals: (previous, next) =>
			previous.length === next.length &&
			previous.every((level, index) => level === next[index]),
	});
	const thinkingLabel = () => piThinkingLevelLabel(thinking());
	const modelPending = computed(
		() => !selected() && (props.loading() || !props.config()?.ready),
	);
	const thinkingPending = computed(
		() => modelPending() || (!thinking() && !props.config()?.ready),
	);
	const triggerDisabled = () => !props.config()?.ready || !!props.readOnly?.();

	const search = () => query().trim().toLowerCase();
	const matches = (provider: string, id: string, name = "") =>
		[name, id, provider].some((value) =>
			value.toLowerCase().includes(search()),
		);
	const scopeReady = () => props.scope() !== null && props.scopeReady();
	// A catalog without Scope metadata, such as the connection's models shown
	// for a project not probed yet, still lists its models under All.
	effect(() => {
		if (!props.loading() && !scopeReady() && props.models().length > 0) {
			untracked(() => view.set("all"));
		}
	});
	const showModels = () => view() === "all" || scopeReady();
	const allModels = () => props.models();
	const visibleModels = () =>
		(view() === "all" ? allModels() : props.scopeModels()).filter((model) =>
			matches(model.provider, model.id, model.name),
		);
	const defaultValue = () => {
		const entry = props.scope()?.models?.find((model) => model.isDefault);
		return entry ? identity(entry.provider, entry.modelId) : null;
	};
	const listError = () => saveError() ?? props.error();
	const busy = () => props.loading() || props.savingScope();

	const saveDefault = async (models: ProjectScopedModel[] | null) => {
		if (!props.onSaveScope || props.savingScope()) return;
		saveError.set(null);
		try {
			await props.onSaveScope(models);
		} catch (error) {
			saveError.set(error instanceof Error ? error.message : String(error));
		}
	};

	const toggleDefault = (model: PiModel) => {
		const scope = props.scope();
		if (!scope || !scopeReady() || busy() || triggerDisabled()) return;
		void saveDefault(
			toggleProjectScopeDefaultModel(props.scopeModels(), scope, model),
		);
	};

	const viewport = MobileViewport();
	const narrowToolbar = computed(() => props.toolbarWidth() < 384);
	const sheetMaxHeight = computed(() =>
		resolveMobileSheetMaxHeight(viewport.availableHeight()),
	);
	const sheetMarginBottom = computed(() =>
		viewport.managed() ? 0 : keyboardFrame().height,
	);
	const sheetPaddingBottom = computed(() =>
		viewport.managed() && viewport.keyboardOpen()
			? 12
			: Math.max(12, safeArea().bottom),
	);
	const listMaxHeight = computed(() =>
		Math.min(256, Math.max(140, Math.round(viewport.availableHeight() * 0.35))),
	);
	const reasoningGridColumns = computed(() =>
		windowSize().width >= 300 ? "repeat(4, 1fr)" : "repeat(2, 1fr)",
	);

	const needsDisambiguation = (model: PiModel) =>
		allModels().some(
			(candidate) =>
				candidate.provider === model.provider &&
				candidate.id !== model.id &&
				(candidate.name || candidate.id) === (model.name || model.id),
		);

	const renderModelRow = (model: PiModel) => {
		const isSelected = () => piModelsMatch(model, selected());
		const isDefault = () =>
			identity(model.provider, model.id) === defaultValue();
		const showStar = view() === "scope" && props.onSaveScope !== undefined;
		const name = model.name || model.id;
		const subtitle = needsDisambiguation(model)
			? `${model.provider} · ${model.id}`
			: model.provider;
		return (
			<View class="relative flex-row items-center">
				<BaseButton
					testID={`run-config-model:${model.provider}:${model.id}`}
					disabled={triggerDisabled()}
					class={classNames(
						"min-h-12 min-w-0 flex-1 flex-row items-center gap-2 rounded-(--pilo-sheet-item-radius) px-3 py-2 hover:bg-hover active:bg-hover",
						isSelected() && "bg-muted/70",
						showStar && "pr-14",
					)}
					accessibilityLabel={`${name} · ${model.provider} · ${model.id}${isDefault() ? ` · ${t("chat.scopeDefaultModel")}` : ""}${isSelected() ? ` · ${t("chat.currentModel")}` : ""}`}
					onPress={() => props.onModel(model)}
				>
					<View class="min-w-0 flex-1">
						<Text
							class="font-sans font-medium text-popover-foreground"
							style={{ fontSize: 16, lineHeight: 21 }}
						>
							{name}
						</Text>
						<Text
							class="mt-0.5 font-sans text-muted-foreground"
							style={{ fontSize: 13, lineHeight: 17 }}
						>
							{subtitle}
						</Text>
					</View>
					<View class="size-4 shrink-0 items-center justify-center">
						{() =>
							isSelected() ? (
								<Icon name="Check" size={14} color={token("primary")} />
							) : null
						}
					</View>
				</BaseButton>
				{showStar ? (
					<Button
						testID={`run-config-default:${model.provider}:${model.id}`}
						variant="ghost"
						size="icon"
						class="absolute right-1 size-11 shrink-0 rounded-(--pilo-sheet-item-radius)"
						disabled={
							triggerDisabled() ||
							!scopeReady() ||
							props.savingScope() ||
							busy()
						}
						accessibilityLabel={t("chat.scopeDefaultModelLabel", {
							model: name,
						})}
						onPress={() => toggleDefault(model)}
					>
						<Icon
							name="Star"
							size={15}
							fill={isDefault()}
							color={token("muted-foreground")}
						/>
					</Button>
				) : null}
			</View>
		);
	};

	const renderRefreshButton = () => (
		<Button
			testID="run-config-refresh"
			variant="ghost"
			size="icon"
			class="size-11 shrink-0 rounded-(--pilo-sheet-item-radius)"
			disabled={props.savingScope() || !props.onRefresh}
			accessibilityLabel={t("chat.refreshModels")}
			onPress={() => {
				if (props.loading()) return;
				props.onRefresh?.();
			}}
		>
			<Icon
				name="RefreshCw"
				size={15}
				color={token("muted-foreground")}
				class={props.loading() ? "animate-spin" : undefined}
			/>
		</Button>
	);

	const renderSearchBox = () => (
		<View class="px-3 pb-2">
			<View class="relative justify-center">
				<Input
					testID="run-config-model-search"
					value={query()}
					placeholder={t("chat.searchModels")}
					accessibilityLabel={t("chat.searchModels")}
					class="min-h-11 rounded-(--pilo-sheet-item-radius) pl-10 pr-3"
					style={{ fontSize: 16 }}
					onChange={(event) => query.set(event.value)}
				/>
				<View class="pointer-events-none absolute inset-y-0 left-3 justify-center">
					<Icon name="Search" size={16} color={token("muted-foreground")} />
				</View>
			</View>
		</View>
	);

	const renderError = () =>
		listError() ? (
			<View class="mx-3 mb-2 rounded-lg bg-destructive/5 p-2">
				<Text class="font-sans text-destructive" style={MOBILE_TEXT.xs}>
					{listError}
				</Text>
			</View>
		) : null;

	const renderLoading = () =>
		props.loading() && (!showModels() || visibleModels().length === 0) ? (
			<View class="flex-row items-center justify-center gap-2 px-4 py-6">
				<Spinner size={14} color={token("muted-foreground")} />
				<Text class="font-sans text-muted-foreground" style={MOBILE_TEXT.xs}>
					{() => t("chat.readingModels")}
				</Text>
			</View>
		) : null;

	const renderEmpty = (message: string) => (
		<View class="px-3 py-6">
			<Text
				class="text-center font-sans text-muted-foreground"
				style={MOBILE_TEXT.xs}
			>
				{message}
			</Text>
		</View>
	);

	return (
		<>
			<Button
				testID="run-config-trigger"
				variant="ghost"
				size="sm"
				class="h-10 min-w-0 shrink rounded-(--pilo-mobile-radius-md) font-normal"
				style={{
					height: 40,
					marginLeft: -4,
					gap: narrowToolbar() ? 2 : 4,
					paddingHorizontal: narrowToolbar() ? 0 : 8,
				}}
				activeStyle={{ scale: 1 }}
				disabled={triggerDisabled()}
				accessibilityLabel={t("chat.runConfigLabel", {
					model: modelPending() ? t("chat.loadingModels") : modelLabel(),
					thinking: thinkingPending()
						? t("chat.readingReasoning")
						: thinkingLabel(),
				})}
				onPress={() => open.set(true)}
			>
				<PiLogo size={16} />
				{() =>
					modelPending()
						? untracked(() => (
								<Skeleton class="h-2.5 w-20 shrink-0 rounded-full" />
							))
						: untracked(() => (
								<>
									<Text
										class="min-w-0 shrink truncate font-sans text-muted-foreground"
										style={MOBILE_TEXT.xs}
									>
										{modelLabel}
									</Text>
									<Text
										accessible={false}
										accessibilityElementsHidden
										class="shrink-0 font-sans text-muted-foreground/60"
										style={MOBILE_TEXT.xs}
									>
										·
									</Text>
									{() =>
										thinkingPending()
											? untracked(() => (
													<Skeleton class="h-2.5 w-8 shrink-0 rounded-full" />
												))
											: untracked(() => (
													<Text
														class="shrink-0 font-sans text-muted-foreground"
														style={MOBILE_TEXT.xs}
													>
														{thinkingLabel}
													</Text>
												))
									}
								</>
							))
				}
			</Button>

			{() =>
				mounted() ? (
					<Overlay
						onCancel={close}
						class="absolute inset-0"
						style={{
							zIndex: token("z-dialog"),
							pointerEvents: open() ? "auto" : "none",
						}}
					>
						<View class="relative flex-1 justify-end">
							<View
								testID="mobile-run-config-backdrop"
								class="absolute inset-0 bg-black"
								style={{ opacity: backdropOpacity }}
								onPress={close}
							/>
							<View
								testID="mobile-run-config-sheet"
								onLayout={({ bounds }) => {
									if (bounds.size.height > 0)
										sheetHeight.set(bounds.size.height);
								}}
								class="relative min-h-0 w-full max-w-lg shrink self-center overflow-hidden border-t border-border/70 bg-popover"
								style={{
									marginBottom: sheetMarginBottom(),
									maxHeight: sheetMaxHeight(),
									borderTopLeftRadius: token("pilo-sheet-radius"),
									borderTopRightRadius: token("pilo-sheet-radius"),
									boxShadow: styleVar("pilo-shadow-floating"),
									paddingBottom: sheetPaddingBottom(),
									transform: [{ translateY: sheetTranslateY() }],
								}}
							>
								{/* Grabber + swipe-down header */}
								<View
									{...dismissPan.panHandlers}
									panActivation={{ activeOffsetY: 10, failOffsetX: 16 }}
									class="shrink-0"
								>
									<View class="items-center pt-2 pb-0.5">
										<View class="h-1 w-9 rounded-full bg-muted-foreground/30" />
									</View>
									<View class="shrink-0 flex-row items-center justify-between pl-4 pr-2 pt-0.5">
										<Text
											class="font-sans font-medium text-popover-foreground"
											style={MOBILE_TEXT.sm}
										>
											{() => t("chat.model")}
										</Text>
										<Button
											testID="mobile-run-config-close"
											variant="ghost"
											size="icon"
											class="size-11 rounded-full"
											disabled={props.savingScope()}
											accessibilityLabel={t("common.close")}
											onPress={close}
										>
											<Icon
												name="X"
												size={16}
												color={token("muted-foreground")}
											/>
										</Button>
									</View>
								</View>

								<Scroll class="min-h-0 shrink" bounces={false}>
									{/* Model picker toolbar */}
									<View class="flex-row items-center gap-2 px-3 py-2">
										<Tabs
											orientation="horizontal"
											class="h-auto gap-0.5 rounded-[10px] bg-muted/60 p-0.5"
											indicatorClass="inset-y-0.5 rounded-(--pilo-sheet-item-radius) bg-popover"
											indicatorStyle={{ boxShadow: styleVar("pilo-shadow-xs") }}
										>
											{(["scope", "all"] as const).map((option) => (
												<Tab
													testID={`run-config-view:${option}`}
													class="min-h-11 min-w-20 rounded-(--pilo-sheet-item-radius) px-3 py-0"
													style={tactileTransition("color")}
													selected={view() === option}
													accessibilityLabel={
														option === "scope"
															? t("chat.scopedModels")
															: t("chat.allModels")
													}
													onPress={() => view.set(option)}
												>
													<Text
														class={classNames(
															"font-sans",
															view() === option
																? "text-popover-foreground"
																: "text-muted-foreground",
														)}
														style={MOBILE_TEXT.sm}
													>
														{() =>
															option === "scope"
																? t("chat.scopedModels")
																: t("chat.allModels")
														}
													</Text>
												</Tab>
											))}
										</Tabs>
										<View class="ml-auto shrink-0">
											{renderRefreshButton()}
										</View>
									</View>

									{renderSearchBox()}
									{renderError}
									{renderLoading}

									{/* Scrollable model list */}
									<Scroll
										class="mx-2 min-h-0 shrink-0"
										contentClass="gap-0.5 pb-2"
										style={{ maxHeight: listMaxHeight() }}
										bounces={false}
									>
										{() => {
											const models = showModels() ? visibleModels() : [];
											return (
												<>
													{models.map(renderModelRow)}
													{!props.loading() &&
													!listError() &&
													(!showModels() || models.length === 0)
														? renderEmpty(
																!showModels()
																	? t("chat.scopeNotResolved")
																	: search()
																		? t("chat.noModelMatches")
																		: view() === "scope"
																			? t("chat.emptyScope")
																			: t("chat.noModels"),
															)
														: null}
												</>
											);
										}}
									</Scroll>

									{/* Reasoning level grid */}
									<View class="border-t border-border/60 px-3 pt-3 pb-1">
										<View class="mb-2 flex-row items-center gap-2">
											<Text
												class="font-sans font-medium text-muted-foreground"
												style={MOBILE_TEXT.sm}
											>
												{() => t("chat.reasoning")}
											</Text>
											{() =>
												thinkingPending() ? (
													<Spinner
														size={14}
														color={token("muted-foreground")}
													/>
												) : null
											}
										</View>
										{() => {
											const levels = thinkingLevels();
											if (levels.length === 0) {
												return untracked(() => (
													<Text
														class="py-2 font-sans text-muted-foreground"
														style={MOBILE_TEXT.sm}
													>
														{() =>
															props.config()?.ready
																? t("chat.noReasoning")
																: t("chat.readingReasoning")
														}
													</Text>
												));
											}
											return untracked(() => (
												<View
													style={{
														display: "grid",
														gridTemplateColumns: reasoningGridColumns(),
														gap: 4,
													}}
												>
													{levels.map((level) => {
														const active = () => thinking() === level;
														return (
															<Button
																testID={`run-config-thinking:${level}`}
																variant={active() ? "secondary" : "ghost"}
																size="sm"
																class="min-h-11 w-full rounded-(--pilo-sheet-item-radius) px-2 font-normal"
																style={{ boxShadow: "none" }}
																disabled={props.savingScope()}
																selected={active()}
																onPress={() => props.onThinking(level)}
															>
																<Text
																	class={classNames(
																		"font-sans",
																		active()
																			? "font-medium text-foreground"
																			: "text-popover-foreground",
																	)}
																	style={MOBILE_TEXT.sm}
																>
																	{piThinkingLevelLabel(level)}
																</Text>
															</Button>
														);
													})}
												</View>
											));
										}}
									</View>
								</Scroll>
							</View>
						</View>
					</Overlay>
				) : null
			}
		</>
	);
}

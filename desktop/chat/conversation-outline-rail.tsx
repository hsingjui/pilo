import {
	computed,
	signal,
	Text,
	token,
	untracked,
	View,
	type KeyEvent,
	type ViewRef,
} from "nsh";

import {
	sampleOutlineEntries,
	type ConversationOutlineEntry,
} from "@/lib/chat/conversation-outline";
import { t } from "../app/i18n";
import { focusRingStyle } from "../ui/focus-ring-style";
import { Tooltip } from "../ui/tooltip";

/** Altura del hueco de cada marca, como en la WebUI. */
const TICK_PITCH = 8;
/** Anchura en reposo de la marca según el peso de la ronda. */
const TICK_WIDTHS = [10, 13, 16, 20] as const;
/** Anchura de la marca activa. */
const ACTIVE_TICK_WIDTH = 24;
/** Anchura del raíl. */
const RAIL_WIDTH = 46;
/** Margen interior a la izquierda de las marcas. */
const TRACK_INSET = 8;
/** Ensanche de las marcas alrededor de la apuntada: campana gaussiana como
 * en la WebUI. */
const HOVER_WIDTH = 38;
const BELL_BASE_WIDTH = 15;
const BELL_SIGMA = 1.8;
const BELL_RADIUS = 4;

function tickWidth(resting: number, index: number, hoveredIndex: number) {
	if (hoveredIndex < 0) return resting;
	const distance = Math.abs(index - hoveredIndex);
	if (distance > BELL_RADIUS) return resting;
	const bell = Math.exp(-(distance * distance) / (2 * BELL_SIGMA * BELL_SIGMA));
	const target = BELL_BASE_WIDTH + (HOVER_WIDTH - BELL_BASE_WIDTH) * bell;
	return resting * (1 - bell) + target * bell;
}

export interface ConversationOutlineRailProps {
	/** Las rondas del chat, una por mensaje del usuario. */
	entries: () => readonly ConversationOutlineEntry[];
	/** La entrada que se está leyendo. */
	activeIndex: () => number;
	/** Salta a la ronda `index` de la lista. */
	onJump: (index: number) => void;
}

/**
 * Las rondas de la conversación como marcas apiladas en el borde izquierdo:
 * cada una salta a su mensaje del usuario (aunque aún no esté cargado),
 * la activa sigue al scroll y el ratón y el teclado la recorren. No se
 * muestra con menos de dos rondas. Las marcas se muestrean de forma
 * uniforme para caber siempre en la mitad del raíl (conservando la
 * primera y la última): en macOS las pulsaciones dentro de un `Scroll`
 * no llegan a los hijos, así que el raíl no desplaza sus marcas.
 */
export function ConversationOutlineRail(props: ConversationOutlineRailProps) {
	const focused = signal(-1);
	const hovered = signal(-1);
	const railHeight = signal(0);
	const ticks: (ViewRef | undefined)[] = [];

	const displayed = computed(() =>
		sampleOutlineEntries(
			props.entries(),
			Math.floor(Math.max(railHeight() / 2 - 16, TICK_PITCH) / TICK_PITCH),
		),
	);
	// La marca activa es la última mostrada cuya ronda no pasa de la activa.
	const activeTick = computed(() => {
		const active = props.activeIndex();
		let found = -1;
		for (const [position, tick] of displayed().entries()) {
			if (tick.index > active) break;
			found = position;
		}
		return found;
	});

	const onKeyDown = (e: KeyEvent) => {
		const shown = untracked(displayed);
		let next = -1;
		if (e.key === "ArrowDown") next = Math.min(focused() + 1, shown.length - 1);
		if (e.key === "ArrowUp") next = Math.max(focused() - 1, 0);
		if (e.key === "Home") next = 0;
		if (e.key === "End") next = shown.length - 1;
		if (next >= 0 && next !== focused()) {
			ticks[next]?.focus();
			return;
		}
		if (e.key === "Enter" || e.key === " ") {
			const tick = shown[focused()];
			if (tick) props.onJump(tick.index);
		}
	};

	return (
		<View
			testID="chat-outline-rail"
			accessibilityLabel={t("chat.messageNavigation")}
			role="navigation"
			class="pointer-events-none absolute inset-y-0 left-0 items-start justify-center"
			style={{ width: RAIL_WIDTH, zIndex: 20 }}
			onLayout={({ bounds }) => railHeight.set(bounds.size.height)}
			onKeyDown={onKeyDown}
		>
			<View
				class="pointer-events-auto py-2"
				style={{ maxHeight: Math.max(railHeight() / 2, TICK_PITCH) }}
			>
				<View class="flex-col" style={{ paddingLeft: TRACK_INSET }}>
					<Each of={displayed()} key="index">
						{(tick, index) => (
							<View
								testID={`chat-outline-tick-${index()}`}
								focusable
								accessibilityLabel={tick().entry.title}
								ref={(node: ViewRef) => (ticks[index()] = node)}
								focusVisibleStyle={focusRingStyle(token("ring"))}
								class="pointer-events-auto flex-row items-center"
								style={{ height: TICK_PITCH }}
								onFocus={() => focused.set(index())}
								onBlur={() => focused.set(-1)}
								onMouseEnter={() => hovered.set(index())}
								onMouseLeave={() => hovered.set(-1)}
								onPress={() => props.onJump(tick().index)}
								tooltip={
									<Tooltip placement="right" delay={200}>
										<View class="w-72 gap-1.5">
											<Text class="font-sans text-sm font-medium leading-snug">
												{() => tick().entry.title}
											</Text>
											<Text class="font-sans text-xs leading-relaxed text-muted-foreground">
												{() => tick().entry.preview || t("chat.noPiReply")}
											</Text>
										</View>
									</Tooltip>
								}
							>
								{() => {
									const active = index() === activeTick();
									const resting = tickWidth(
										TICK_WIDTHS[tick().entry.weight],
										index(),
										hovered(),
									);
									return (
										<View
											class={
												active
													? "rounded-full bg-foreground/80"
													: "rounded-full bg-muted-foreground/45 hover:bg-muted-foreground/80 focus:bg-foreground/80"
											}
											style={{
												height: 2,
												width: active
													? Math.max(ACTIVE_TICK_WIDTH, resting + 4)
													: resting,
												transitionProperty: "all",
												transitionDuration: "150ms",
												transitionTimingFunction: "ease-out",
											}}
										/>
									);
								}}
							</View>
						)}
					</Each>
				</View>
			</View>
		</View>
	);
}

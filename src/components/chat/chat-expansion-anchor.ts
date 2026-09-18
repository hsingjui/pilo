import { flushSync } from "react-dom";

const ANCHOR_EPSILON_PX = 0.5;
const ANCHOR_ROOT_SELECTOR = "[data-chat-expansion-root]";
/** Fired on the scroll viewport so bottom-following can yield to the anchor. */
export const CHAT_EXPANSION_TOGGLE_EVENT = "pilo:chat-expansion-toggle";

/**
 * Keep a user-clicked disclosure trigger fixed in the viewport while content
 * below it expands/collapses.
 *
 * The state change is flushed synchronously so the first correction happens
 * before the browser can paint the expanded layout. A temporary ResizeObserver
 * then runs alongside Virtua's row measurement and corrects any scroll jump in
 * the same pre-paint resize cycle.
 */
export function toggleChatExpansionWithAnchor(
	trigger: HTMLElement,
	toggle: () => void,
) {
	const viewport = trigger.closest<HTMLElement>(".chat-scrollbar");
	if (!viewport) {
		toggle();
		return;
	}

	// A toggle in the upper half moves a large visible mass, so bottom-following
	// must not clamp to the new max offset on the next frame — that fights the
	// anchor and shoves the clicked trigger upward. Lower-half toggles keep the
	// clamp, which reads as the familiar bottom-anchored expansion.
	const triggerTop =
		trigger.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
	if (triggerTop < viewport.clientHeight / 2) {
		viewport.dispatchEvent(new CustomEvent(CHAT_EXPANSION_TOGGLE_EVENT));
	}

	const anchorTop = trigger.getBoundingClientRect().top;
	const expansionRoot =
		trigger.closest<HTMLElement>(ANCHOR_ROOT_SELECTOR) ??
		trigger.parentElement ??
		trigger;

	const correctAnchor = () => {
		if (!trigger.isConnected || !viewport.isConnected) return;
		const delta = trigger.getBoundingClientRect().top - anchorTop;
		if (Math.abs(delta) > ANCHOR_EPSILON_PX) {
			viewport.scrollTop += delta;
		}
	};

	let observer: ResizeObserver | null = null;
	if (typeof ResizeObserver !== "undefined") {
		observer = new ResizeObserver(correctAnchor);
		observer.observe(expansionRoot);
	}

	flushSync(toggle);
	correctAnchor();

	// rAF callbacks run before ResizeObserver delivery within the same frame, so
	// a single rAF would disconnect the observer before its first delivery. Two
	// frames keep it alive across Virtua's flushSync row measurement and any
	// late markdown reflow, then release it.
	requestAnimationFrame(() => {
		requestAnimationFrame(() => observer?.disconnect());
	});
}

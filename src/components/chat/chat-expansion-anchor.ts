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
	root?: HTMLElement,
) {
	const viewport = trigger.closest<HTMLElement>(".chat-scrollbar");
	if (!viewport) {
		toggle();
		return;
	}

	// Any user toggle is reading intent: bottom-following must not clamp to the
	// new max offset, or it fights the anchor and shoves the clicked trigger
	// upward so long content appears to expand above it and the trigger becomes
	// hard to reach. Content always grows downward from the fixed trigger.
	viewport.dispatchEvent(new CustomEvent(CHAT_EXPANSION_TOGGLE_EVENT));

	const anchorTop = trigger.getBoundingClientRect().top;
	const expansionRoot =
		root ??
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

import { useEffect, useRef } from "react";

import { keyboardEventMatchesShortcut } from "@/lib/keyboard-shortcuts";

export function useKeyboardShortcut(
	shortcut: string,
	onTrigger: (event: KeyboardEvent) => void,
	options: { enabled?: boolean } = {},
) {
	const callbackRef = useRef(onTrigger);
	const enabled = options.enabled ?? true;

	useEffect(() => {
		callbackRef.current = onTrigger;
	}, [onTrigger]);

	useEffect(() => {
		if (!enabled || !shortcut) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.repeat || event.isComposing) return;
			if (!keyboardEventMatchesShortcut(event, shortcut)) return;
			event.preventDefault();
			callbackRef.current(event);
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [enabled, shortcut]);
}

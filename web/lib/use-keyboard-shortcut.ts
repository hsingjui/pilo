import { useEffect, useRef } from "react";

import { keyboardEventMatchesShortcut } from "@/lib/keyboard-shortcuts";
import { isImeComposingNativeKeyboardEvent } from "@/lib/ime";

export function useKeyboardShortcut(
	shortcut: string,
	onTrigger: (event: KeyboardEvent) => void | false,
	{
		enabled = true,
		allowInDialog = false,
	}: { enabled?: boolean; allowInDialog?: boolean } = {},
) {
	const callbackRef = useRef(onTrigger);

	useEffect(() => {
		callbackRef.current = onTrigger;
	}, [onTrigger]);

	useEffect(() => {
		if (!enabled || !shortcut) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (
				event.defaultPrevented ||
				event.repeat ||
				isImeComposingNativeKeyboardEvent(event)
			)
				return;
			if (!keyboardEventMatchesShortcut(event, shortcut)) return;
			if (
				!allowInDialog &&
				event.target instanceof Element &&
				event.target.closest(
					'[role="dialog"], [role="alertdialog"], [role="menu"]',
				)
			)
				return;
			if (callbackRef.current(event) !== false) event.preventDefault();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [allowInDialog, enabled, shortcut]);
}

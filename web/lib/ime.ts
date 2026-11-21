interface ImeAwareKeyboardEvent {
	key: string;
	nativeEvent: { isComposing?: boolean; keyCode?: number; which?: number };
}

/**
 * IME composition detection for keydown handlers. Ported from Lody lib/ime.
 * `nativeEvent.isComposing` is the primary signal, but some IMEs only expose
 * composition via key=Process or keyCode/which=229.
 */
export function isImeComposingKeyboardEvent(
	event: ImeAwareKeyboardEvent,
): boolean {
	return isImeComposingNativeKeyboardEvent({
		key: event.key,
		isComposing: event.nativeEvent.isComposing,
		keyCode: event.nativeEvent.keyCode,
		which: event.nativeEvent.which,
	});
}

export function isImeComposingNativeKeyboardEvent(event: {
	key: string;
	isComposing?: boolean;
	keyCode?: number;
	which?: number;
}): boolean {
	if (event.isComposing) return true;
	if (event.key === "Process") return true;
	return event.keyCode === 229 || event.which === 229;
}

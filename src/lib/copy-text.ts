export async function copyText(text: string) {
	if (typeof navigator.clipboard?.writeText === "function") {
		await navigator.clipboard.writeText(text);
		return;
	}

	const activeElement = document.activeElement;
	const selection = window.getSelection();
	const anchor = selection?.anchorNode;
	const focus = selection?.focusNode;
	const anchorOffset = selection?.anchorOffset ?? 0;
	const focusOffset = selection?.focusOffset ?? 0;
	const field = document.createElement("textarea");
	field.value = text;
	field.readOnly = true;
	field.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
	document.body.append(field);
	try {
		field.focus({ preventScroll: true });
		field.select();
		if (!document.execCommand("copy")) throw new Error("Copy failed");
	} finally {
		field.remove();
		if (activeElement instanceof HTMLElement)
			activeElement.focus({ preventScroll: true });
		if (selection && anchor?.isConnected && focus?.isConnected)
			selection.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset);
	}
}

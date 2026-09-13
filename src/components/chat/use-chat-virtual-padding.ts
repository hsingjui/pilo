import { useEffect, useState } from "react";

type ChatVirtualPadding = {
	start: number;
	end: number;
};

function getChatVirtualPadding(): ChatVirtualPadding {
	if (
		typeof window !== "undefined" &&
		window.matchMedia("(min-width: 640px)").matches
	) {
		return { start: 24, end: 40 };
	}
	return { start: 16, end: 32 };
}

export function useChatVirtualPadding() {
	const [padding, setPadding] = useState<ChatVirtualPadding>(
		getChatVirtualPadding,
	);

	useEffect(() => {
		const media = window.matchMedia("(min-width: 640px)");
		const sync = () =>
			setPadding(
				media.matches ? { start: 24, end: 40 } : { start: 16, end: 32 },
			);
		media.addEventListener("change", sync);
		return () => media.removeEventListener("change", sync);
	}, []);

	return padding;
}

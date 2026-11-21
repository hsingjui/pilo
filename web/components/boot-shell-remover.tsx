import { useEffect } from "react";

export function BootShellRemover({ ready = true }: { ready?: boolean }) {
	useEffect(() => {
		if (!ready) return;
		let disposed = false;
		let frame = 0;
		// Catalog data and fonts both affect the centered landing layout.
		void document.fonts.ready.then(() => {
			if (disposed) return;
			frame = window.requestAnimationFrame(() => {
				document.getElementById("pilo-boot-shell")?.remove();
			});
		});
		return () => {
			disposed = true;
			window.cancelAnimationFrame(frame);
		};
	}, [ready]);
	return null;
}

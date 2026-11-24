(() => {
	const src = document.currentScript.getAttribute("src");

	async function checkBuild() {
		try {
			if (!document.hidden) {
				const response = await fetch("/index.html", { cache: "no-store" });
				if (response.ok && !(await response.text()).includes(`src="${src}"`)) {
					window.location.reload();
				}
			}
		} catch {
			// The Host may be restarting; wait for the next check.
		} finally {
			setTimeout(checkBuild, 1500);
		}
	}

	setTimeout(checkBuild, 1500);
})();

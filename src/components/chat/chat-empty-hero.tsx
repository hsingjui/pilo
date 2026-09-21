import { PiLogo } from "@/components/pi-logo";

export function ChatEmptyHero() {
	return (
		<div className="flex flex-col items-center justify-center gap-3 text-center">
			<PiLogo className="h-16 w-16 text-foreground" />
			<h1 className="text-2xl font-semibold tracking-tight @min-[40rem]:text-3xl">
				今天要做点什么？
			</h1>
		</div>
	);
}

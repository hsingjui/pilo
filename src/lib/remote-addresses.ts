import type { RemoteAccessAddress } from "./api/remote-types";

/** LAN and loopback hosts default to HTTP; public hostnames default to HTTPS. */
function withDefaultScheme(input: string): string {
	if (input.includes("://")) return input;
	const host = input
		.replace(/^\/\//, "")
		.replace(/^\[/, "")
		.split(/[/:]/, 1)[0];
	const scheme =
		!host || host === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
			? "http"
			: "https";
	return `${scheme}://${input.replace(/^\/\//, "")}`;
}

function isLanAddress(baseUrl: string): boolean {
	try {
		const octets = new URL(withDefaultScheme(baseUrl.trim())).hostname
			.split(".")
			.map(Number);
		return (
			octets.length === 4 &&
			octets.every(Number.isInteger) &&
			(octets[0] === 10 ||
				(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
				(octets[0] === 192 && octets[1] === 168))
		);
	} catch {
		return false;
	}
}

export function sortRemoteAddresses<T extends RemoteAccessAddress>(
	addresses: readonly T[],
): T[] {
	const lan: T[] = [];
	const other: T[] = [];
	for (const address of addresses) {
		if (isLanAddress(address.baseUrl)) lan.push(address);
		else other.push(address);
	}
	return [...lan, ...other];
}

export function remoteAddressConfig(
	addresses: RemoteAccessAddress[],
	entryAddressId: string,
) {
	const saved = addresses
		.filter((address) => address.baseUrl.trim())
		.map((address) =>
			Object.assign({}, address, {
				baseUrl: withDefaultScheme(address.baseUrl.trim()),
			}),
		);
	return {
		addresses: saved,
		entryAddressId:
			saved.find((address) => address.id === "lan")?.id ??
			saved.find((address) => address.id === entryAddressId)?.id ??
			saved[0]?.id ??
			"",
	};
}

export function sameAddressList(
	left: readonly RemoteAccessAddress[],
	right: readonly RemoteAccessAddress[],
): boolean {
	return (
		left.length === right.length &&
		left.every((address, index) => {
			const other = right[index];
			return (
				address.id === other.id &&
				address.baseUrl === other.baseUrl &&
				address.name === other.name
			);
		})
	);
}

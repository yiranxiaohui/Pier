import type { HostInfo } from "@pier/protocol";
import { parseProtocolVersion } from "@pier/protocol";

export function supportsPortFeature(info: HostInfo | undefined, minor: 37 | 39): boolean {
	const version = parseProtocolVersion(info?.protocolVersion ?? "");
	return !!version && version.major === 1 && version.minor >= minor;
}

/** Wildcard bind addresses must become a connectable address on the remote computer. */
export function portTarget(address: string): string {
	// ss can append a bound interface even to IPv4, which connects without a zone id.
	if (/^\d+\.\d+\.\d+\.\d+%/.test(address)) return address.split("%")[0] as string;
	if (address === "*" || address === "0.0.0.0") return "127.0.0.1";
	if (address === "::" || /^(?:0:){7}0$/.test(address)) return "::1";
	return address;
}

export function portAddress(host: string, port: number): string {
	return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

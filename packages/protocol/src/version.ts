/**
 * Protocol version as "<major>.<minor>".
 *
 * - Bump the minor version for backwards-compatible additions (new optional
 *   params, new methods, new events).
 * - Bump the major version for breaking changes. Hosts reject clients whose
 *   major version differs.
 */
export const PROTOCOL_VERSION = "1.37";

export interface ParsedVersion {
	major: number;
	minor: number;
}

export function parseProtocolVersion(version: string): ParsedVersion | undefined {
	const match = /^(\d+)\.(\d+)$/.exec(version);
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Whether a peer speaking `other` can talk to a peer speaking `ours`. */
export function isProtocolCompatible(other: string, ours: string = PROTOCOL_VERSION): boolean {
	const a = parseProtocolVersion(other);
	const b = parseProtocolVersion(ours);
	return a !== undefined && b !== undefined && a.major === b.major;
}

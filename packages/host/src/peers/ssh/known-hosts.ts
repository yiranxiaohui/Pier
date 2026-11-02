import { createHash, createHmac } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** `SHA256:<base64 without padding>`, as `ssh-keygen -l` prints it. */
export function hostKeyFingerprint(key: Buffer): string {
	return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

/** The key type inside an SSH public key blob (`ssh-ed25519`, `ssh-rsa`, …). */
export function hostKeyType(key: Buffer): string {
	if (key.length < 4) return "unknown";
	const length = key.readUInt32BE(0);
	if (length <= 0 || length > 64 || key.length < 4 + length) return "unknown";
	return key.subarray(4, 4 + length).toString("latin1");
}

/** How `known_hosts` names a server: `host`, or `[host]:port` for other ports. */
export function knownHostName(host: string, port: number): string {
	const bare = host.replace(/^\[(.*)\]$/, "$1").toLowerCase();
	return port === 22 ? bare : `[${bare}]:${port}`;
}

function globMatch(pattern: string, value: string): boolean {
	const regex = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("*", ".*")
		.replaceAll("?", ".");
	return new RegExp(`^${regex}$`, "i").test(value);
}

function hostMatches(field: string, name: string): boolean {
	if (field.startsWith("|1|")) {
		const [, , salt, hash] = field.split("|");
		if (!salt || !hash) return false;
		try {
			const digest = createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest("base64");
			return digest === hash;
		} catch {
			return false;
		}
	}
	let matched = false;
	for (const pattern of field.split(",")) {
		if (pattern.startsWith("!")) {
			if (globMatch(pattern.slice(1), name)) return false;
		} else if (globMatch(pattern, name)) matched = true;
	}
	return matched;
}

export interface KnownHostEntry {
	keyType: string;
	key: string;
	file: string;
	revoked: boolean;
}

/** Entries for `name` in the given `known_hosts` files (missing files are skipped). */
export function knownHostEntries(files: string[], name: string): KnownHostEntry[] {
	const entries: KnownHostEntry[] = [];
	for (const file of files) {
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim();
			if (!line || line.startsWith("#")) continue;
			const fields = line.split(/\s+/);
			let marker: string | undefined;
			if (fields[0]?.startsWith("@")) marker = fields.shift();
			const [hosts, keyType, key] = fields;
			if (!hosts || !keyType || !key || marker === "@cert-authority") continue;
			if (hostMatches(hosts, name)) entries.push({ keyType, key, file, revoked: marker === "@revoked" });
		}
	}
	return entries;
}

export type HostKeyCheck =
	| { status: "known" }
	| { status: "unknown" }
	| { status: "mismatch"; file: string }
	| { status: "revoked"; file: string };

/** Compare the server's key with what `known_hosts` recorded for it, the way OpenSSH does. */
export function checkHostKey(files: string[], name: string, key: Buffer): HostKeyCheck {
	const type = hostKeyType(key);
	const blob = key.toString("base64");
	const entries = knownHostEntries(files, name);
	const revoked = entries.find((e) => e.revoked && e.key === blob);
	if (revoked) return { status: "revoked", file: revoked.file };
	if (entries.some((e) => !e.revoked && e.keyType === type && e.key === blob)) return { status: "known" };
	const other = entries.find((e) => !e.revoked && e.keyType === type);
	if (other) return { status: "mismatch", file: other.file };
	return { status: "unknown" };
}

/** Key types recorded for `name`, so the handshake can ask for one of them first. */
export function knownHostKeyTypes(files: string[], name: string): string[] {
	return [...new Set(knownHostEntries(files, name).flatMap((e) => (e.revoked ? [] : [e.keyType])))];
}

/** Record a key the user accepted (Pier's own file, never `~/.ssh/known_hosts`). */
export function rememberHostKey(file: string, name: string, key: Buffer): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
	const prefix = existing && !existing.endsWith("\n") ? "\n" : "";
	appendFileSync(file, `${prefix}${name} ${hostKeyType(key)} ${key.toString("base64")}\n`, { mode: 0o600 });
}

import { z } from "zod";
import type { PeerInfo } from "./domain.ts";

/**
 * Add a Linux computer over SSH (1.49): the host signs in, installs or starts Pier there when
 * needed, and pairs with it without a pairing link. Local-only.
 */
export const SshAuthSchema = z.discriminatedUnion("type", [
	/** Password (also answers keyboard-interactive prompts, e.g. PAM). */
	z.object({ type: z.literal("password"), password: z.string().min(1).max(1024) }),
	/**
	 * A private key: `privateKey` (PEM / OpenSSH text) or `privateKeyPath` on the host's
	 * computer. With neither, the SSH agent and the default keys in `~/.ssh` are tried.
	 */
	z.object({
		type: z.literal("key"),
		privateKeyPath: z.string().trim().min(1).max(4096).optional(),
		privateKey: z
			.string()
			.min(1)
			.max(64 * 1024)
			.optional(),
		passphrase: z.string().max(1024).optional(),
	}),
]);
export type SshAuth = z.infer<typeof SshAuthSchema>;

/** `SHA256:<base64>` as printed by `ssh-keygen -l`. */
export const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

export const SshAddParamsSchema = z.object({
	/** Chosen by the client; `peer.sshProgress` events and `peer.sshCancel` refer to it. */
	operationId: z.string().min(1).max(128),
	host: z
		.string()
		.trim()
		.min(1)
		.max(255)
		.regex(/^[\w.:%-]+$|^\[[0-9a-fA-F:.%\w-]+\]$/, "Expected a host name or IP address"),
	port: z.number().int().min(1).max(65535).default(22),
	username: z
		.string()
		.trim()
		.min(1)
		.max(64)
		.regex(/^[\w.@-]+$/, "Invalid user name"),
	auth: SshAuthSchema,
	/** The server key fingerprint the user accepted after a `HOST_KEY_UNKNOWN` failure. */
	hostKeyFingerprint: z.string().regex(SSH_FINGERPRINT).optional(),
	/** Also register the computer with this host's relay, for when direct connections fail (default true). */
	relay: z.boolean().optional(),
	/** HTTPS acceleration prefix for GitHub release downloads (the desktop update route). */
	mirrorPrefix: z.string().trim().max(500).optional(),
});
export type SshAddParams = z.input<typeof SshAddParamsSchema>;

/** Why `peer.sshAdd` failed, in the error's `data.reason`. */
export type SshAddFailure =
	| "CANCELLED"
	| "SSH_UNREACHABLE"
	| "SSH_AUTH_FAILED"
	| "SSH_KEY_INVALID"
	| "HOST_KEY_UNKNOWN"
	| "HOST_KEY_MISMATCH"
	| "UNSUPPORTED_SYSTEM"
	| "DOWNLOAD_FAILED"
	| "INSTALL_FAILED"
	| "START_FAILED"
	| "PAIRING_FAILED"
	// From `peer.pair`.
	| "UNREACHABLE"
	| "PAIRING_INVALID"
	| "PAIRING_REJECTED"
	| "PAIRING_TIMEOUT"
	| "BAD_HANDSHAKE";

/** `data` of a `HOST_KEY_UNKNOWN` / `HOST_KEY_MISMATCH` failure. */
export interface SshHostKeyInfo {
	reason: "HOST_KEY_UNKNOWN" | "HOST_KEY_MISMATCH";
	/** The key the server presented. */
	fingerprint: string;
	keyType: string;
	/** For a mismatch: where the different, known key was recorded. */
	knownHostsFile?: string;
}

export type SshAddStep = "connect" | "detect" | "download" | "upload" | "install" | "start" | "pair";

/** Progress of `peer.sshAdd` (1.49), sent only to the calling connection. */
export interface SshAddProgress {
	operationId: string;
	step: SshAddStep;
	message: string;
	/** Bytes so far and in total, for `download` / `upload`. */
	transferred?: number;
	total?: number;
}

export interface SshAddResult {
	peer: PeerInfo;
	/** What was done on that computer. */
	action: "installed" | "updated" | "started" | "existing";
	/** Pier version running there. */
	version?: string;
	/** Things the user should know (e.g. the service stops after logout without lingering). */
	warnings: string[];
}

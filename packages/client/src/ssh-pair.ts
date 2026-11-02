/**
 * `pier cli --ssh-pair`: the remote half of adding a computer over SSH (`peer.sshAdd`).
 *
 * Reads one JSON line from stdin (`SshPairRequest`), turns on remote access (and the relay
 * the other computer uses, when this one has none), shows a pairing link and accepts only the
 * device whose key fingerprint was requested. Writes JSON lines (`SshPairOutput`) to stdout.
 * Exits when the pairing finished, on timeout, or when stdin closes (the SSH session ended).
 */
import type { MethodParams, PairingRequest, RemoteAccessStatus } from "@pier/protocol";
import type { PierClient } from "./client.ts";

export interface SshPairRequest {
	/** Fingerprint of the device key that may pair (the other computer's host key). */
	fingerprint: string;
	/** Relay to register with when none is enabled here. */
	relay?: { url: string; token?: string };
	/** Overall limit for the other computer to pair (default 3 minutes). */
	timeoutMs?: number;
}

export type SshPairOutput =
	| { type: "uri"; uri: string; port: number; addresses: string[]; relays: string[]; warnings: string[] }
	| { type: "done"; deviceId?: string }
	| { type: "error"; message: string };

const LISTENER_WAIT_MS = 5_000;
const RELAY_WAIT_MS = 10_000;
const POLL_MS = 200;

export function parseSshPairRequest(line: string): SshPairRequest {
	const value = JSON.parse(line) as Partial<SshPairRequest>;
	if (typeof value.fingerprint !== "string" || !value.fingerprint) throw new Error("Missing the fingerprint to accept");
	const relay =
		value.relay && typeof value.relay.url === "string" && value.relay.url
			? {
					url: value.relay.url,
					...(typeof value.relay.token === "string" && value.relay.token ? { token: value.relay.token } : {}),
				}
			: undefined;
	return {
		fingerprint: value.fingerprint,
		...(relay ? { relay } : {}),
		...(typeof value.timeoutMs === "number" && value.timeoutMs > 0 ? { timeoutMs: value.timeoutMs } : {}),
	};
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run the helper on a connected local client. Resolves with the final output, also emitted. */
export async function runSshPair(
	client: PierClient,
	request: SshPairRequest,
	emit: (output: SshPairOutput) => void,
	signal?: AbortSignal,
): Promise<SshPairOutput> {
	const end = (output: SshPairOutput) => {
		emit(output);
		return output;
	};
	let off: (() => void) | undefined;
	try {
		const poll = async (status: RemoteAccessStatus, done: (s: RemoteAccessStatus) => boolean, ms: number) => {
			const deadline = Date.now() + ms;
			while (!done(status) && Date.now() < deadline && !signal?.aborted) {
				await sleep(POLL_MS);
				status = await client.request("remote.status");
			}
			return status;
		};
		let status = await client.request("remote.status");
		const patch: MethodParams<"remote.configure"> = {};
		if (!status.enabled) patch.enabled = true;
		if (request.relay && !status.relay?.enabled)
			patch.relay = { enabled: true, url: request.relay.url, token: request.relay.token ?? null };
		if (Object.keys(patch).length) status = await client.request("remote.configure", patch);
		status = await poll(status, (s) => s.running || Boolean(s.error), LISTENER_WAIT_MS);
		if (status.relay?.enabled) status = await poll(status, (s) => s.relay?.state !== "connecting", RELAY_WAIT_MS);
		const warnings: string[] = [];
		if (status.enabled && !status.running && status.error) warnings.push(status.error);
		if (status.relay?.enabled && status.relay.state !== "online")
			warnings.push(
				`Relay ${status.relay.url ?? ""} is ${status.relay.state}${status.relay.error ? `: ${status.relay.error}` : ""}`,
			);
		if (!status.running && status.relay?.state !== "online")
			return end({ type: "error", message: status.error ?? "Remote access could not start on this computer" });

		let accepting: string | undefined;
		let resolveDone: (output: SshPairOutput) => void = () => {};
		const done = new Promise<SshPairOutput>((resolve) => {
			resolveDone = resolve;
		});
		// Requests can only use the new code after the link below was printed.
		off = client.onEvent((frame) => {
			if (frame.sessionId) return;
			const event = frame.event;
			if (event.type === "pairing.request") {
				const pairing = event.request as PairingRequest;
				const accept = !accepting && pairing.fingerprint === request.fingerprint;
				if (accept) accepting = pairing.id;
				void client.request("pairing.respond", { requestId: pairing.id, accept }).catch(() => undefined);
			} else if (event.type === "pairing.resolved" && accepting && event.requestId === accepting) {
				resolveDone(
					event.resolution === "accepted"
						? { type: "done", ...(typeof event.deviceId === "string" ? { deviceId: event.deviceId } : {}) }
						: { type: "error", message: `Pairing ${String(event.resolution)}` },
				);
			}
		});
		const pairing = await client.request("pairing.start");
		emit({
			type: "uri",
			uri: pairing.uri,
			port: status.port,
			addresses: pairing.addresses,
			relays: pairing.relays ?? [],
			warnings,
		});
		let timer: ReturnType<typeof setTimeout> | undefined;
		const stop = new Promise<SshPairOutput>((resolve) => {
			timer = setTimeout(
				() => resolve({ type: "error", message: "The other computer did not pair in time" }),
				request.timeoutMs ?? 3 * 60_000,
			);
			signal?.addEventListener("abort", () => resolve({ type: "error", message: "Cancelled" }), { once: true });
		});
		const output = await Promise.race([done, stop]);
		clearTimeout(timer);
		if (output.type !== "done") await client.request("pairing.cancel").catch(() => undefined);
		return end(output);
	} catch (error) {
		return end({ type: "error", message: error instanceof Error ? error.message : String(error) });
	} finally {
		off?.();
	}
}

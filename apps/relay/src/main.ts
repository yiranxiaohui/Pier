#!/usr/bin/env node
/**
 * Pier Relay command line. Configuration from flags or environment variables (handy in Docker).
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { IceServer, RelayMode } from "@pier/crypto";
import { RELAY_VERSION, startRelayServer } from "./server.ts";

const HELP = `pier-relay ${RELAY_VERSION}

Forwards end-to-end encrypted traffic between the Pier app and Pier on computers that cannot
reach each other directly, and answers STUN so they can connect peer-to-peer when possible.

Usage: pier-relay [options]

Options:
  --mode <private|open>   private: only computers with an access token may register (default)
                          open: any computer may register, within the limits below
                                                           [env PIER_RELAY_MODE]
  --token <token>         Access token for private mode (repeatable)
                                                           [env PIER_RELAY_TOKENS, comma-separated]
  --token-file <path>     Read access tokens from a file, one per line
                                                           [env PIER_RELAY_TOKEN_FILE]
  --port <n>              HTTP / WebSocket port (default 7480)        [env PIER_RELAY_PORT]
  --host <addr>           Interface to bind (default: all)             [env PIER_RELAY_HOST]
  --stun-port <n>         UDP port of the built-in STUN server (default 3478, 0 = off)
                                                           [env PIER_RELAY_STUN_PORT]
  --public-host <name>    Name or IP clients reach this server at, for the announced STUN
                          URL (default: the Host header each computer connected with)
                                                           [env PIER_RELAY_PUBLIC_HOST]
  --ice-server <url>      Another STUN server to announce, e.g. stun:stun.miwifi.com:3478
                          (repeatable)                     [env PIER_RELAY_ICE_SERVERS, comma-separated]
                          If omitted, common domestic and international public STUN fallbacks are used.
  --max-hosts <n>         Registered computers at most     [env PIER_RELAY_MAX_HOSTS]
  --max-streams <n>       Device connections per computer (default 32)
                                                           [env PIER_RELAY_MAX_STREAMS]
  --rate-limit <bytes/s>  Per connection and direction, 0 = unlimited
                          (default: 0 in private mode, 2097152 in open mode)
                                                           [env PIER_RELAY_RATE_LIMIT]
  --trust-proxy           Take client addresses from X-Forwarded-For / X-Real-IP
                                                           [env PIER_RELAY_TRUST_PROXY=1]
  --data-dir <path>       Keep accounts and settings here and serve the web admin panel at /
                          (accounts create their own access tokens; settings saved in the
                          panel take precedence over these options)
                                                           [env PIER_RELAY_DATA_DIR]
  -h, --help              Show this help
  -v, --version           Print the version

Run it behind a TLS reverse proxy (or a tunnel) and give Pier the wss:// address; the relay
only ever sees ciphertext, but TLS hides who talks to whom.
`;

function list(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function int(name: string, value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid ${name}: ${value}`);
	return n;
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2).filter((a) => a !== "--"),
		options: {
			mode: { type: "string" },
			token: { type: "string", multiple: true },
			"token-file": { type: "string" },
			port: { type: "string" },
			host: { type: "string" },
			"stun-port": { type: "string" },
			"public-host": { type: "string" },
			"ice-server": { type: "string", multiple: true },
			"max-hosts": { type: "string" },
			"max-streams": { type: "string" },
			"rate-limit": { type: "string" },
			"trust-proxy": { type: "boolean" },
			"data-dir": { type: "string" },
			help: { type: "boolean", short: "h" },
			version: { type: "boolean", short: "v" },
		},
	});
	if (values.help) {
		process.stdout.write(HELP);
		return;
	}
	if (values.version) {
		process.stdout.write(`${RELAY_VERSION}\n`);
		return;
	}
	const env = process.env;
	const mode = (values.mode ?? env.PIER_RELAY_MODE ?? "private").trim().toLowerCase();
	if (mode !== "private" && mode !== "open") throw new Error(`Invalid --mode ${mode}; use private or open`);
	const tokens = [...(values.token ?? []), ...list(env.PIER_RELAY_TOKENS)];
	const tokenFile = values["token-file"] ?? env.PIER_RELAY_TOKEN_FILE;
	if (tokenFile) {
		tokens.push(
			...readFileSync(tokenFile, "utf8")
				.split(/\r?\n/)
				.map((l) => l.trim())
				.filter((l) => l && !l.startsWith("#")),
		);
	}
	const dataDir = values["data-dir"] ?? env.PIER_RELAY_DATA_DIR;
	if (mode === "private" && !tokens.length && !dataDir) {
		throw new Error(
			"Private mode needs an access token: pass --token (or PIER_RELAY_TOKENS), e.g. one from `openssl rand -base64 24`; or use --data-dir for accounts with their own tokens, or --mode open",
		);
	}
	if (tokens.some((t) => t.length < 16)) throw new Error("Access tokens must be at least 16 characters long");
	const stunPort = int("--stun-port", values["stun-port"] ?? env.PIER_RELAY_STUN_PORT);
	const configuredIceServers = [...(values["ice-server"] ?? []), ...list(env.PIER_RELAY_ICE_SERVERS)];
	const iceServers: IceServer[] | undefined = configuredIceServers.length
		? configuredIceServers.map((url) => {
				if (!/^stuns?:/i.test(url)) throw new Error(`Only STUN URLs can be announced: ${url}`);
				return { urls: url };
			})
		: undefined;
	const log = (message: string) => process.stderr.write(`[pier-relay] ${new Date().toISOString()} ${message}\n`);
	const maxHosts = int("--max-hosts", values["max-hosts"] ?? env.PIER_RELAY_MAX_HOSTS);
	const maxStreams = int("--max-streams", values["max-streams"] ?? env.PIER_RELAY_MAX_STREAMS);
	const rateLimit = int("--rate-limit", values["rate-limit"] ?? env.PIER_RELAY_RATE_LIMIT);
	const host = values.host ?? env.PIER_RELAY_HOST;
	const publicHost = values["public-host"] ?? env.PIER_RELAY_PUBLIC_HOST;
	const relay = await startRelayServer({
		mode: mode as RelayMode,
		tokens,
		port: int("--port", values.port ?? env.PIER_RELAY_PORT) ?? 7480,
		...(host ? { host } : {}),
		stunPort: stunPort === 0 ? false : (stunPort ?? 3478),
		...(publicHost ? { publicHost } : {}),
		iceServers,
		...(maxHosts !== undefined ? { maxHosts } : {}),
		...(maxStreams !== undefined ? { maxStreamsPerHost: maxStreams } : {}),
		...(rateLimit !== undefined ? { bytesPerSecond: rateLimit } : {}),
		trustProxy: values["trust-proxy"] === true || env.PIER_RELAY_TRUST_PROXY === "1",
		...(dataDir ? { dataDir } : {}),
		log,
	});
	const stop = () => {
		log("shutting down");
		void relay.close().then(() => process.exit(0));
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
	process.stderr.write(`[pier-relay] ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});

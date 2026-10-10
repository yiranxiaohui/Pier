import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { endianness } from "node:os";
import { type HostPort, type HostPorts, PierProtocolError } from "@pier/protocol";

const MAX_PORTS = 4096;

function endpoint(text: string): { address: string; port: number } | undefined {
	const split = text.lastIndexOf(":");
	if (split < 0) return undefined;
	const port = Number(text.slice(split + 1));
	const address = text.slice(0, split).replace(/^\[|\]$/g, "");
	if (!address || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	return { address, port };
}

export function parseSs(text: string, wildcard = "*"): HostPort[] {
	const ports: HostPort[] = [];
	for (const line of text.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		const protocol = fields[0];
		if (protocol !== "tcp" && protocol !== "udp") continue;
		if (fields[1] !== (protocol === "tcp" ? "LISTEN" : "UNCONN")) continue;
		const local = endpoint(fields[4] ?? "");
		if (!local) continue;
		if (local.address === "*") local.address = wildcard;
		const process = /"([^"\n]+)",pid=(\d+)/.exec(line);
		ports.push({
			protocol,
			...local,
			...(process ? { process: (process[1] as string).slice(0, 256), pid: Number(process[2]) } : {}),
		});
	}
	return ports;
}

/** lsof's field output avoids columns whose widths depend on the process name. */
export function parseLsof(text: string, protocol: HostPort["protocol"]): HostPort[] {
	const ports: HostPort[] = [];
	let pid: number | undefined;
	let process: string | undefined;
	let family: string | undefined;
	for (const field of text.split(/\r?\n/)) {
		if (field.startsWith("p")) {
			pid = Number(field.slice(1)) || undefined;
			process = undefined;
			family = undefined;
		} else if (field.startsWith("c")) process = field.slice(1, 257);
		else if (field.startsWith("f")) family = undefined;
		else if (field.startsWith("t")) family = field.slice(1);
		else if (field.startsWith("n") && !field.includes("->")) {
			const local = endpoint(field.slice(1));
			if (local?.address === "*" && (family === "IPv4" || family === "IPv6"))
				local.address = family === "IPv6" ? "::" : "0.0.0.0";
			if (local) ports.push({ protocol, ...local, ...(pid ? { pid } : {}), ...(process ? { process } : {}) });
		}
	}
	return ports;
}

/** Fallback for minimal Linux hosts without ss; /proc lists sockets in this network namespace. */
export function parseProcSockets(text: string, protocol: HostPort["protocol"]): HostPort[] {
	const ports: HostPort[] = [];
	for (const line of text.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields[3] !== (protocol === "tcp" ? "0A" : "07")) continue;
		const [hex, portHex] = (fields[1] ?? "").split(":");
		if (!hex || !/^(?:[\da-f]{8}|[\da-f]{32})$/i.test(hex) || !/^[\da-f]{4}$/i.test(portHex ?? "")) continue;
		const bytes = Buffer.from(hex, "hex");
		if (endianness() === "LE") {
			for (let offset = 0; offset < bytes.length; offset += 4) bytes.subarray(offset, offset + 4).reverse();
		}
		const address =
			bytes.length === 4
				? [...bytes].join(".")
				: Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16)).join(":");
		const port = Number.parseInt(portHex as string, 16);
		if (port > 0) ports.push({ protocol, address, port });
	}
	return ports;
}

export function parseWindowsPorts(text: string): HostPort[] {
	const parsed: unknown = JSON.parse(text || "[]");
	const ports: HostPort[] = [];
	for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
		if (!item || typeof item !== "object") continue;
		const { protocol, address, port, pid, process } = item;
		if (
			(protocol !== "tcp" && protocol !== "udp") ||
			typeof address !== "string" ||
			!Number.isInteger(port) ||
			port < 1 ||
			port > 65535
		)
			continue;
		ports.push({
			protocol,
			address,
			port,
			...(Number.isInteger(pid) && pid > 0 ? { pid } : {}),
			...(typeof process === "string" ? { process: process.slice(0, 256) } : {}),
		});
	}
	return ports;
}

function run(command: string, args: string[], emptyExit = false): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ timeout: 5000, windowsHide: true, maxBuffer: 2 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
			(error, stdout) => {
				if (error && !(emptyExit && error.code === 1 && !error.killed)) reject(error);
				else resolve(stdout);
			},
		);
	});
}

async function linuxPorts(): Promise<HostPort[]> {
	try {
		const [v4, v6] = await Promise.all([run("ss", ["-4", "-H", "-lntup"]), run("ss", ["-6", "-H", "-lntup"])]);
		return [...parseSs(v4, "0.0.0.0"), ...parseSs(v6, "::")];
	} catch {
		const files = ["tcp", "tcp6", "udp", "udp6"] as const;
		const results = await Promise.allSettled(files.map((file) => readFile(`/proc/net/${file}`, "utf8")));
		if (results[0]?.status !== "fulfilled") throw new Error("Cannot read listening sockets");
		return results.flatMap((result, index) =>
			result.status === "fulfilled" ? parseProcSockets(result.value, index < 2 ? "tcp" : "udp") : [],
		);
	}
}

async function readPorts(): Promise<HostPort[]> {
	if (process.platform === "linux") return linuxPorts();
	if (process.platform === "darwin") {
		const [tcp, udp] = await Promise.all([
			run("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcnt"], true),
			run("/usr/sbin/lsof", ["-nP", "-iUDP", "-Fpcnt"], true),
		]);
		return [...parseLsof(tcp, "tcp"), ...parseLsof(udp, "udp")];
	}
	if (process.platform === "win32") {
		const script =
			"$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); " +
			"$processes=@{}; Get-Process | ForEach-Object { $processes[$_.Id]=$_.ProcessName }; $rows=@(); foreach($kind in @('tcp','udp')) { " +
			"$sockets=if($kind -eq 'tcp'){Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue}else{Get-NetUDPEndpoint -ErrorAction SilentlyContinue}; " +
			"foreach($s in $sockets){ " +
			"$rows+=@{protocol=$kind;address=$s.LocalAddress;port=$s.LocalPort;pid=$s.OwningProcess;process=$processes[[int]$s.OwningProcess]}} }; ConvertTo-Json -InputObject @($rows) -Compress";
		return parseWindowsPorts(await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]));
	}
	throw new PierProtocolError("UNSUPPORTED", "这台主机的系统暂不支持查看监听端口");
}

/** Share a short-lived sample between windows; never invoke a privileged command. */
export class HostPortSampler {
	private cached?: { time: number; result: HostPorts };
	private pending?: Promise<HostPorts>;

	sample(): Promise<HostPorts> {
		if (this.cached && Date.now() - this.cached.time < 1000) return Promise.resolve(this.cached.result);
		if (this.pending) return this.pending;
		this.pending = readPorts()
			.then((ports) => {
				const unique = [
					...new Map(ports.map((p) => [`${p.protocol}|${p.address}|${p.port}|${p.pid ?? ""}`, p])).values(),
				];
				unique.sort(
					(a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol) || a.address.localeCompare(b.address),
				);
				const result = { ports: unique.slice(0, MAX_PORTS), truncated: unique.length > MAX_PORTS };
				this.cached = { time: Date.now(), result };
				return result;
			})
			.catch((error) => {
				if (error instanceof PierProtocolError) throw error;
				throw new PierProtocolError("INTERNAL", "无法读取监听端口，请确认系统的端口查询工具或 /proc 可用");
			})
			.finally(() => {
				this.pending = undefined;
			});
		return this.pending;
	}
}

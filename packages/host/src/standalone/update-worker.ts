import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileSha256 } from "../peers/ssh/release.ts";
import { findInstallation, type Installation, installHost } from "./service.ts";
import { validateReleaseTag, verifyStandaloneVersion } from "./update-release.ts";

export interface UpdateReceipt {
	version: string;
	pid: number;
	state: "installing" | "error" | "done";
	startedAt?: number;
	error?: string;
}

export function receiptPath(config: Installation): string {
	return join(config.installDir, "remote-update.json");
}

export function writeUpdateReceipt(config: Installation, receipt: UpdateReceipt): void {
	const path = receiptPath(config);
	writeFileSync(`${path}.new`, JSON.stringify({ ...receipt, startedAt: Date.now() }), { mode: 0o600 });
	renameSync(`${path}.new`, path);
}

export function readUpdateReceipt(config: Installation): UpdateReceipt | undefined {
	try {
		const receipt = JSON.parse(readFileSync(receiptPath(config), "utf8")) as UpdateReceipt;
		if (typeof receipt.version !== "string" || !Number.isSafeInteger(receipt.pid) || receipt.pid <= 0) return;
		if (!["installing", "error", "done"].includes(receipt.state)) return;
		return receipt;
	} catch {
		return undefined;
	}
}

interface UpdateJob {
	executable: string;
	tag: string;
	sha256: string;
}

/**
 * Start a separate systemd unit, not a detached child in pier.service's cgroup: stopping
 * Pier must not kill its installer. Type=exec acknowledges execution, not completion;
 * the helper writes a durable receipt for the surviving, restarted or rolled-back Host.
 */
export function launchUpdateWorker(
	config: Installation,
	directory: string,
	tag: string,
	sha256: string,
): Promise<void> {
	const executable = join(config.installDir, "current", config.app);
	const worker = join(directory, "worker");
	copyFileSync(executable, worker);
	const job = join(directory, "job.json");
	writeFileSync(job, JSON.stringify({ executable, tag, sha256 } satisfies UpdateJob), { mode: 0o600 });
	writeUpdateReceipt(config, { version: tag.slice(1), pid: process.pid, state: "installing" });
	return new Promise((resolve, reject) => {
		const child = spawn(
			"systemd-run",
			[
				...(config.scope === "user" ? ["--user"] : []),
				"--quiet",
				"--collect",
				`--unit=pier-update-${randomUUID()}`,
				"--property=Type=exec",
				"--property=UMask=0077",
				`--setenv=HOME=${homedir()}`,
				`--setenv=PATH=${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}`,
				`--setenv=XDG_CONFIG_HOME=${config.configHome}`,
				"--",
				worker,
				"--apply-service-update",
				job,
			],
			{ stdio: "ignore" },
		);
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`独立更新任务失败（${code ?? "signal"}）；请检查 systemd 日志或运行 pier update`));
		});
	});
}

/** Internal entry of the copied *old* executable: rollback does not rely on new installer code. */
export async function applyServiceUpdate(jobPath: string): Promise<void> {
	const directory = dirname(jobPath);
	const job = JSON.parse(readFileSync(jobPath, "utf8")) as UpdateJob;
	validateReleaseTag(job.tag);
	if (!/^[a-f0-9]{64}$/.test(job.sha256)) throw new Error("Invalid update checksum");
	const config = findInstallation(job.executable);
	if (!config) throw new Error("The original installation no longer exists");
	if (
		basename(jobPath) !== "job.json" ||
		!/^update-[A-Za-z0-9]+$/.test(basename(directory)) ||
		dirname(realpathSync(directory)) !== realpathSync(join(config.installDir, "updates"))
	)
		throw new Error("Invalid update staging directory");
	const version = job.tag.slice(1);
	const receipt = (state: UpdateReceipt["state"], error?: string) =>
		writeUpdateReceipt(config, { version, pid: process.pid, state, ...(error ? { error } : {}) });
	try {
		receipt("installing");
		const binary = join(directory, "pier");
		if ((await fileSha256(binary)) !== job.sha256) throw new Error("Staged release checksum mismatch");
		verifyStandaloneVersion(binary, job.tag);
		// Let the originating request/status reach clients before stopping their connection.
		await delay(500);
		await installHost(binary, [`--${config.scope}`], version, config);
		receipt("done");
	} catch (error) {
		receipt("error", error instanceof Error ? error.message : String(error));
		throw error;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

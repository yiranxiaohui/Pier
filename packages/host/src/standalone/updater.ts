import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeUpdateMirror } from "@pier/client";
import type { AppUpdateStatus } from "@pier/protocol";
import { writePrivateFile } from "../config.ts";
import { compareVersions } from "../peers/ssh/remote.ts";
import type { AppUpdater, ShellMethod } from "../shell.ts";
import { standaloneExecutable } from "./self.ts";
import { findInstallation, type Installation, standaloneUpdateSupport } from "./service.ts";
import { downloadStandaloneRelease, latestStandaloneRelease, type StandaloneRelease } from "./update-release.ts";
import { launchUpdateWorker, readUpdateReceipt } from "./update-worker.ts";

interface UpdaterOptions {
	version: string;
	config?: Installation;
	unsupported?: string;
	/** Test seams; production always uses fixed GitHub release endpoints and native service management. */
	latest?: typeof latestStandaloneRelease;
	download?: typeof downloadStandaloneRelease;
	launch?: typeof launchUpdateWorker;
}

export class StandaloneUpdater implements AppUpdater {
	private status: AppUpdateStatus;
	private release?: StandaloneRelease;
	private checking?: Promise<void>;
	private checkController?: AbortController;
	private readonly listeners = new Set<(status: AppUpdateStatus) => void>();
	private readonly abort = new AbortController();
	private startTimer?: ReturnType<typeof setTimeout>;
	private receiptTimer?: ReturnType<typeof setInterval>;
	private closed = false;

	constructor(private readonly options: UpdaterOptions) {
		this.status = {
			state: options.unsupported ? "unsupported" : "idle",
			currentVersion: options.version,
			autoCheck: false,
			downloaded: 0,
			...(options.unsupported ? { error: options.unsupported } : {}),
		};
		if (!options.unsupported && options.config) {
			const settings = join(options.config.stateDir, "updater.json");
			this.status.mirrorPrefix = existsSync(settings)
				? normalizeUpdateMirror(JSON.parse(readFileSync(settings, "utf8")).mirrorPrefix ?? "")
				: "";
			this.refreshReceipt();
			// The installer writes its final receipt after the new/rolled-back Host is ready.
			this.receiptTimer = setInterval(() => this.refreshReceipt(), 1000);
			this.receiptTimer.unref();
		}
	}

	get updateStatus(): AppUpdateStatus {
		return { ...this.status };
	}

	onUpdateStatus(listener: (status: AppUpdateStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private set(patch: Partial<AppUpdateStatus>): void {
		if (this.closed) return;
		this.status = { ...this.status, ...patch };
		for (const listener of this.listeners) listener(this.updateStatus);
	}

	private refreshReceipt(): void {
		if (!this.options.config || this.checking || this.status.state === "downloading") return;
		const receipt = readUpdateReceipt(this.options.config);
		if (!receipt) return;
		if (receipt.pid === process.pid && receipt.state === "installing") {
			if (Date.now() - (receipt.startedAt ?? 0) < 30_000) return;
			receipt.state = "error";
			receipt.error = "独立更新任务未能启动，请检查 systemd 日志后重试";
		}
		if (receipt.state === "installing") {
			try {
				process.kill(receipt.pid, 0);
				if (this.status.state !== "installing") this.set({ state: "installing", version: receipt.version });
				return;
			} catch {
				receipt.state = "error";
				receipt.error = "上次更新任务意外停止，请检查服务日志后重试";
			}
		}
		// Consume the result once; a later check must not be overwritten by this old receipt.
		try {
			rmSync(join(this.options.config.installDir, "remote-update.json"), { force: true });
		} catch {
			return; // A read-only installation must not crash Host from an interval callback.
		}
		if (receipt.state === "done" && receipt.version === this.options.version)
			this.set({ state: "upToDate", error: undefined, version: undefined });
		else this.set({ state: "error", error: receipt.error ?? "更新未生效，请重试", version: receipt.version });
	}

	async setMirror(prefix: string): Promise<AppUpdateStatus> {
		const config = this.options.config;
		if (this.closed || !config || this.status.state === "unsupported") throw new Error("更新服务不可用");
		if (this.status.state === "downloading" || this.status.state === "installing") {
			throw new Error("请等待当前更新操作结束后再切换线路");
		}
		const mirrorPrefix = normalizeUpdateMirror(prefix);
		writePrivateFile(join(config.stateDir, "updater.json"), JSON.stringify({ mirrorPrefix }));
		this.checkController?.abort();
		this.release = undefined;
		this.set({ mirrorPrefix, version: undefined, notes: undefined, date: undefined, downloaded: 0, total: undefined });
		void this.startCheck();
		return this.updateStatus;
	}

	private startCheck(): Promise<void> {
		const controller = new AbortController();
		this.checkController = controller;
		this.checking = this.check(controller.signal).finally(() => {
			if (this.checkController === controller) {
				this.checkController = undefined;
				this.checking = undefined;
			}
		});
		return this.checking;
	}

	private async check(signal: AbortSignal): Promise<void> {
		this.set({ state: "checking", error: undefined });
		try {
			const release = await (this.options.latest ?? latestStandaloneRelease)(signal, this.status.mirrorPrefix);
			if (signal.aborted) return;
			this.release = compareVersions(release.tag.slice(1), this.options.version) > 0 ? release : undefined;
			this.set({
				state: this.release ? "available" : "upToDate",
				version: this.release?.tag.slice(1),
				notes: this.release?.notes,
				date: this.release?.date,
				downloaded: 0,
				total: undefined,
				lastChecked: Date.now(),
			});
		} catch (error) {
			if (signal.aborted) return;
			this.set({ state: "error", error: error instanceof Error ? error.message : String(error) });
		}
	}

	async request(method: ShellMethod): Promise<AppUpdateStatus> {
		if (this.closed) throw new Error("The updater is closed");
		if (this.status.state === "unsupported") throw new Error(this.status.error);
		if (this.status.state === "downloading" || this.status.state === "installing") return this.updateStatus;
		if (this.checking || method === "update.check" || !this.release || this.status.state === "error") {
			const check = this.checking ?? this.startCheck();
			const controller = this.checkController;
			await check;
			if (controller?.signal.aborted) return this.updateStatus;
		}
		if (method === "update.install" && this.release && !this.closed && this.status.state !== "error") {
			// Multiple install requests may have been waiting on the same check.
			const state = this.updateStatus.state;
			if (state === "downloading" || state === "installing") return this.updateStatus;
			const release = this.release;
			this.set({ state: "downloading", downloaded: 0, total: undefined, error: undefined });
			this.startTimer = setTimeout(() => {
				void this.install(release);
			}, 0);
		}
		return this.updateStatus;
	}

	private async install(release: StandaloneRelease): Promise<void> {
		let directory: string | undefined;
		let handingOff = false;
		const config = this.options.config;
		try {
			if (!config) throw new Error("No managed installation");
			// Stage under the installation, not /tmp (which the service may see through PrivateTmp).
			const root = join(config.installDir, "updates");
			mkdirSync(root, { recursive: true, mode: 0o700 });
			directory = mkdtempSync(join(root, "update-"));
			const sha256 = await (this.options.download ?? downloadStandaloneRelease)(release.tag, join(directory, "pier"), {
				signal: this.abort.signal,
				mirrorPrefix: this.status.mirrorPrefix ?? "",
				onProgress: (downloaded, total) => this.set({ downloaded, total }),
			});
			if (this.closed) return;
			this.set({ state: "installing" });
			handingOff = true;
			await (this.options.launch ?? launchUpdateWorker)(config, directory, release.tag, sha256);
			// systemd now owns the helper and its staging directory, even after Host shutdown.
			directory = undefined;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.set({ state: "error", error: message, downloaded: 0, total: undefined });
			// Permit a fresh download on retry, retaining version/notes for the UI.
			this.release = undefined;
			if (config && !this.closed) {
				try {
					// No handoff happened. Do not leave a receipt that could overwrite a retry.
					rmSync(join(config.installDir, "remote-update.json"), { force: true });
				} catch {
					/* The live status still carries the failure if the disk is read-only. */
				}
			}
		} finally {
			// A shutdown can kill systemd-run after the separate worker has already started.
			// In that race only the worker may clean staging; deleting it here breaks installation.
			if (directory && !(this.closed && handingOff)) rmSync(directory, { recursive: true, force: true });
		}
	}

	close(): void {
		this.closed = true;
		this.checkController?.abort();
		this.abort.abort();
		clearTimeout(this.startTimer);
		clearInterval(this.receiptTimer);
		this.listeners.clear();
	}
}

/** Only the compiled standalone entry sets this marker; ordinary sidecars keep their shell updater. */
export function createStandaloneUpdater(stateDir: string): StandaloneUpdater | undefined {
	const { path, version } = standaloneExecutable;
	if (!path || !version) return;
	try {
		const config = findInstallation(path);
		return new StandaloneUpdater({ version, config, unsupported: standaloneUpdateSupport(config, stateDir) });
	} catch (error) {
		return new StandaloneUpdater({
			version,
			unsupported: `无法读取单文件安装信息：${error instanceof Error ? error.message : String(error)}`,
		});
	}
}

/**
 * Uploads to and downloads from workspaces (`workspace.readBytes` / `workspace.upload*`, 1.21).
 *
 * Files move in chunks over the host connection, so they work the same for this computer and
 * paired ones. Transfers are listed (with progress and a cancel button) at the bottom of the
 * file panel; uploads run one file at a time, in the order they were added.
 */
import type { PierClient } from "@pier/client";
import { PierProtocolError, type WorkspaceFileBytes, type WorkspaceInfo } from "@pier/protocol";
import { useSyncExternalStore } from "react";
import { workspaceNameError } from "./file-names.ts";
import { hostSpeaksMinor } from "./settings-target.ts";
import type { PierStore } from "./store.tsx";
import {
	beginWorkspacePaste,
	completeWorkspaceMoves,
	finishWorkspacePaste,
	type WorkspaceClipboardState,
} from "./workspace-clipboard.ts";

/** Bytes per request; small enough for smooth progress and cancelling over slow links. */
export const TRANSFER_CHUNK_BYTES = 1024 * 1024;

export type TransferState = "queued" | "running" | "done" | "error" | "cancelled" | "skipped";

export interface Transfer {
	id: number;
	kind: "upload" | "download" | "copy" | "move";
	workspaceId: string;
	/** Workspace-relative path of the file. */
	path: string;
	name: string;
	/** Total bytes, once known. */
	total?: number;
	done: number;
	state: TransferState;
	error?: string;
	/** Where a finished download was saved, when known. */
	savedTo?: string;
	/** A native Host operation cannot be interrupted once dispatched. */
	cancellable?: boolean;
}

/** What to do about an upload whose destination already exists. */
export type OverwriteChoice = "overwrite" | "skip" | "cancel";

export interface OverwriteQuestion {
	path: string;
	/** Only regular files may replace a same-name destination. */
	canOverwrite?: boolean;
	/** More uploads follow, so the answer can apply to all of them. */
	more: boolean;
}

export interface OverwriteAnswer {
	choice: OverwriteChoice;
	/** Apply the same choice to the remaining conflicts of this batch. */
	all?: boolean;
}

export interface PasteConflictQuestion extends OverwriteQuestion {
	suggestedName: string;
	error?: string;
}

export type PasteConflictAnswer = OverwriteAnswer | { choice: "rename"; name: string };

/** Keep renaming within the chosen destination directory. */
export function pasteNameError(name: string, existingName: string): string | undefined {
	const error = workspaceNameError(name);
	if (error) return error;
	if (name.trim() === existingName) return "此名称已被占用，请使用其他名称";
	return undefined;
}

/** The name offered when a pasted entry already exists, e.g. `a (副本).txt`. */
export function suggestedPasteName(name: string, kind: string): string {
	const dot = kind === "file" ? name.lastIndexOf(".") : -1;
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const extension = dot > 0 ? name.slice(dot) : "";
	const copy = / \(副本(?: (\d+))?\)$/.exec(stem);
	return copy
		? `${stem.slice(0, copy.index)} (副本 ${Number(copy[1] ?? 1) + 1})${extension}`
		: `${stem} (副本)${extension}`;
}

/** A local file to upload and its workspace-relative destination. */
export interface UploadItem {
	file: File;
	path: string;
}

const FINISHED: ReadonlySet<TransferState> = new Set(["done", "error", "cancelled", "skipped"]);

export function transferFinished(transfer: Transfer): boolean {
	return FINISHED.has(transfer.state);
}

class TransferList {
	private items: Transfer[] = [];
	private readonly listeners = new Set<() => void>();
	private readonly cancelled = new Set<number>();
	private nextId = 1;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	snapshot = (): readonly Transfer[] => this.items;

	add(transfer: Omit<Transfer, "id" | "done" | "state"> & Partial<Pick<Transfer, "state">>): Transfer {
		const item: Transfer = { done: 0, state: "queued", ...transfer, id: this.nextId++ };
		this.items = [...this.items, item];
		this.emit();
		return item;
	}

	update(id: number, patch: Partial<Transfer>): void {
		this.items = this.items.map((t) => (t.id === id ? { ...t, ...patch } : t));
		if (patch.state && FINISHED.has(patch.state)) {
			this.cancelled.delete(id);
			// Successful transfers leave the list on their own; failures stay until dismissed.
			if (patch.state === "done" || patch.state === "skipped") setTimeout(() => this.dismiss(id), 4000);
		}
		this.emit();
	}

	/** Ask a running or queued transfer to stop. */
	cancel(id: number): void {
		const item = this.items.find((t) => t.id === id);
		if (!item || FINISHED.has(item.state)) return;
		this.cancelled.add(id);
		if (item.state === "queued") this.update(id, { state: "cancelled" });
	}

	isCancelled(id: number): boolean {
		return this.cancelled.has(id) || this.items.find((t) => t.id === id)?.state === "cancelled";
	}

	dismiss(id: number): void {
		const before = this.items.length;
		this.items = this.items.filter((t) => t.id !== id || !FINISHED.has(t.state));
		if (this.items.length !== before) this.emit();
	}

	/** Remove every finished transfer of a workspace. */
	clearFinished(workspaceId: string): void {
		this.items = this.items.filter((t) => t.workspaceId !== workspaceId || !FINISHED.has(t.state));
		this.emit();
	}

	private emit(): void {
		for (const listener of this.listeners) listener();
	}
}

export const transfers = new TransferList();

/** The transfers of one workspace, oldest first. */
export function useTransfers(workspaceId: string): Transfer[] {
	const all = useSyncExternalStore(transfers.subscribe, transfers.snapshot);
	return all.filter((t) => t.workspaceId === workspaceId);
}

class CancelledError extends Error {
	constructor() {
		super("已取消");
	}
}

export function transferErrorMessage(error: unknown): string {
	if (error instanceof PierProtocolError) {
		if (error.code === "NOT_FOUND") return error.message.startsWith("Upload") ? "上传已失效，请重试" : "文件不存在";
		if (error.code === "FORBIDDEN") return "没有权限，或路径位于工作区之外";
	}
	if (error instanceof PierProtocolError && error.code === "BAD_REQUEST") {
		if (error.message.includes("same path")) return "源文件和目标位置相同，请选择另一个文件夹";
		if (error.message.includes("descendants")) return "不能把文件夹粘贴到它自己或其子文件夹中";
	}
	if (error instanceof PierProtocolError && error.code === "CONFLICT" && /[Ss]ource.*changed/.test(error.message)) {
		return "源文件在操作期间被修改，已保留源文件，请重试";
	}
	return error instanceof Error ? error.message : String(error);
}

function transferKindLabel(kind: Transfer["kind"]): string {
	return kind === "move" ? "移动" : kind === "copy" ? "复制" : kind === "upload" ? "上传" : "下载";
}

/** Bytes encoded by a base64 string. */
function base64Bytes(data: string): number {
	const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
	return (data.length / 4) * 3 - padding;
}

/** The bytes of a base64 string. */
export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
	const binary = atob(data);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

/** The file name at the end of a workspace-relative path. */
function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** A host directory is independent of the workspace selected in the chat view. */
type TransferLocation = WorkspaceInfo | { node: string; directory: string };

export function hostTransferKey(node: string): string {
	return `host:${node}`;
}

function transferClient(store: PierStore, location: TransferLocation): PierClient {
	if (!("node" in location)) return store.fileTransferClient(location.id);
	const host = store.getState().nodes[location.node];
	const client = store.nodeClient(location.node);
	if (!client || host?.connection !== "open") throw new Error("主机未连接");
	if (!hostSpeaksMinor(host.hostInfo, 57)) throw new Error("请更新此主机的 Pier 以传输工作区以外的文件");
	return client;
}

/** Reads `length` bytes of one file from `offset`. */
export type ReadBytes = (offset: number, length: number) => Promise<WorkspaceFileBytes>;

/**
 * A reader of byte ranges of a workspace, preview or host file, as downloads and media previews
 * use it; throws when the file's computer is not connected or cannot transfer files.
 */
export function fileBytesReader(
	store: PierStore,
	location: TransferLocation,
	path: string,
	expectedRealPath?: string,
	preview = false,
): ReadBytes {
	const client = transferClient(store, location);
	return (offset, length) => {
		const range = { path, offset, length };
		return "node" in location
			? client.request("host.readBytes", { directory: location.directory, ...range })
			: client.request("workspace.readBytes", {
					workspaceId: location.id,
					...range,
					...(expectedRealPath ? { expectedRealPath } : {}),
					...(preview ? { preview: true } : {}),
				});
	};
}

/**
 * Download a workspace or preview file to this computer: asks where to save it, then copies it
 * in chunks. Resolves once the download ended (or the save dialog was cancelled).
 */
export async function downloadFile(
	store: PierStore,
	location: TransferLocation,
	path: string,
	expectedRealPath?: string,
	preview = false,
): Promise<void> {
	let read: ReadBytes;
	try {
		read = fileBytesReader(store, location, path, expectedRealPath, preview);
	} catch (error) {
		store.toast("error", transferErrorMessage(error));
		return;
	}
	const name = baseName(path);
	let sink: Awaited<ReturnType<PierStore["saveLocalFile"]>>;
	try {
		sink = await store.saveLocalFile(name);
	} catch (error) {
		store.toast("error", `无法保存文件：${transferErrorMessage(error)}`);
		return;
	}
	if (!sink) return;
	const key = "node" in location ? hostTransferKey(location.node) : location.id;
	const item = transfers.add({ kind: "download", workspaceId: key, path, name, state: "running" });
	let offset = 0;
	let version: string | undefined;
	try {
		for (;;) {
			if (transfers.isCancelled(item.id)) throw new CancelledError();
			const chunk = await read(offset, TRANSFER_CHUNK_BYTES);
			const stamp = `${chunk.size}@${chunk.modifiedAt}`;
			if (version !== undefined && stamp !== version) throw new Error("文件在下载过程中被修改，请重新下载");
			version = stamp;
			if (chunk.data) await sink.write(chunk.data);
			offset += base64Bytes(chunk.data);
			transfers.update(item.id, { total: chunk.size, done: offset });
			if (chunk.eof) break;
		}
		if (transfers.isCancelled(item.id)) throw new CancelledError();
		const savedTo = (await sink.finish()) ?? sink.path;
		transfers.update(item.id, { state: "done", ...(savedTo ? { savedTo } : {}) });
		store.toast("info", savedTo ? `已下载「${name}」到 ${savedTo}` : `已下载「${name}」`);
	} catch (error) {
		await sink.abort().catch(() => {});
		if (error instanceof CancelledError) transfers.update(item.id, { state: "cancelled" });
		else transfers.update(item.id, { state: "error", error: transferErrorMessage(error) });
	}
}

/**
 * Upload local files into a workspace, one at a time. `ask` decides what to do when a
 * destination already exists; answering `cancel` stops the remaining uploads of this batch.
 */
export async function uploadFiles(
	store: PierStore,
	location: TransferLocation,
	items: UploadItem[],
	ask: (question: OverwriteQuestion) => Promise<OverwriteAnswer>,
): Promise<void> {
	if (!items.length) return;
	let client: PierClient;
	try {
		client = transferClient(store, location);
	} catch (error) {
		store.toast("error", transferErrorMessage(error));
		return;
	}
	const key = "node" in location ? hostTransferKey(location.node) : location.id;
	const queued = items.map((item) => ({
		item,
		transfer: transfers.add({
			kind: "upload",
			workspaceId: key,
			path: item.path,
			name: baseName(item.path),
			total: item.file.size,
		}),
	}));
	let always: OverwriteChoice | undefined;
	let stopped = false;
	for (const [index, { item, transfer }] of queued.entries()) {
		if (stopped || transfers.isCancelled(transfer.id)) {
			transfers.update(transfer.id, { state: "cancelled" });
			continue;
		}
		transfers.update(transfer.id, { state: "running" });
		let uploadId: string | undefined;
		try {
			const start = (overwrite: boolean) => {
				const params = { path: item.path, size: item.file.size, ...(overwrite ? { overwrite: true } : {}) };
				return "node" in location
					? client.request("host.uploadStart", { directory: location.directory, ...params })
					: client.request("workspace.uploadStart", { workspaceId: location.id, ...params });
			};
			let started: Awaited<ReturnType<typeof start>>;
			try {
				started = await start(always === "overwrite");
			} catch (error) {
				const kind = (error as PierProtocolError).data as { kind?: string } | undefined;
				if (!(error instanceof PierProtocolError) || error.code !== "CONFLICT" || kind?.kind !== "file") throw error;
				let choice = always;
				if (!choice) {
					const answer = await ask({ path: item.path, more: index < queued.length - 1 });
					choice = answer.choice;
					if (answer.all && choice !== "cancel") always = choice;
				}
				if (choice === "cancel") {
					stopped = true;
					throw new CancelledError();
				}
				if (choice === "skip") {
					transfers.update(transfer.id, { state: "skipped" });
					continue;
				}
				if (transfers.isCancelled(transfer.id)) throw new CancelledError();
				started = await start(true);
			}
			uploadId = started.uploadId;
			const size = Math.min(TRANSFER_CHUNK_BYTES, started.chunkBytes);
			let offset = 0;
			while (offset < item.file.size) {
				if (transfers.isCancelled(transfer.id)) throw new CancelledError();
				const bytes = new Uint8Array(await item.file.slice(offset, offset + size).arrayBuffer());
				if (!bytes.length) throw new Error("读取本地文件失败，文件可能已被修改或删除");
				const { received } = await client.request("workspace.uploadChunk", {
					uploadId,
					offset,
					data: bytesToBase64(bytes),
				});
				offset = received;
				transfers.update(transfer.id, { done: offset });
			}
			if (transfers.isCancelled(transfer.id)) throw new CancelledError();
			await client.request("workspace.uploadFinish", { uploadId });
			uploadId = undefined;
			transfers.update(transfer.id, { state: "done", done: item.file.size });
		} catch (error) {
			if (uploadId) void client.request("workspace.uploadCancel", { uploadId }).catch(() => {});
			if (error instanceof CancelledError) transfers.update(transfer.id, { state: "cancelled" });
			else if (error instanceof PierProtocolError && error.code === "CONFLICT") {
				const kind = (error.data as { kind?: string } | undefined)?.kind;
				transfers.update(transfer.id, {
					state: "error",
					error:
						kind === "directory"
							? "同名文件夹已存在"
							: kind === "file"
								? "同名文件已存在"
								: transferErrorMessage(error),
				});
			} else transfers.update(transfer.id, { state: "error", error: transferErrorMessage(error) });
		}
		store.bumpFiles(key);
	}
}

/** Paste files into any connected workspace; folders use the owning Host's native transfer. */
export async function pasteWorkspaceEntries(
	store: PierStore,
	clipboard: WorkspaceClipboardState,
	destinationWorkspace: WorkspaceInfo,
	destinationDir: string,
	ask: (question: PasteConflictQuestion) => Promise<PasteConflictAnswer>,
): Promise<void> {
	if (!beginWorkspacePaste()) {
		store.toast("info", "正在粘贴文件，请等待完成");
		return;
	}
	try {
		await runWorkspacePaste(store, clipboard, destinationWorkspace, destinationDir, ask);
	} finally {
		finishWorkspacePaste();
	}
}

async function runWorkspacePaste(
	store: PierStore,
	clipboard: WorkspaceClipboardState,
	destinationWorkspace: WorkspaceInfo,
	destinationDir: string,
	ask: (question: PasteConflictQuestion) => Promise<PasteConflictAnswer>,
): Promise<void> {
	const sourceWorkspaceId = clipboard.sourceWorkspaceId;
	let source: PierClient;
	let destination: PierClient;
	const sameHost = store.nodeOf(sourceWorkspaceId) === store.nodeOf(destinationWorkspace.id);
	try {
		source = store.fileTransferClient(sourceWorkspaceId);
		destination = store.fileTransferClient(destinationWorkspace.id);
		if (sameHost || clipboard.mode === "move") store.requireNativeFileTransfers(sourceWorkspaceId);
		if (!sameHost && clipboard.entries.some((entry) => entry.kind !== "file" || entry.symlink)) {
			throw new Error("跨电脑暂只支持普通文件；文件夹和符号链接可在同一台电脑的工作区之间复制或移动");
		}
	} catch (error) {
		store.toast("error", transferErrorMessage(error));
		return;
	}
	const queued = clipboard.entries.map((entry) => {
		const path = childPath(destinationDir, entry.name);
		return {
			entry,
			path,
			transfer: transfers.add({ kind: clipboard.mode, workspaceId: destinationWorkspace.id, path, name: entry.name }),
		};
	});
	let always: OverwriteChoice | undefined;
	let stopped = false;
	let failures = 0;
	let skipped = 0;
	const completed: string[] = [];
	entries: for (const [index, item] of queued.entries()) {
		if (stopped || transfers.isCancelled(item.transfer.id)) {
			stopped = true;
			transfers.update(item.transfer.id, { state: "cancelled" });
			continue;
		}
		transfers.update(item.transfer.id, { state: "running", cancellable: !sameHost });
		try {
			const run = async (overwrite: boolean) => {
				if (sameHost) {
					await source.request(
						"workspace.transferPath",
						{
							workspaceId: sourceWorkspaceId,
							path: item.entry.path,
							destinationWorkspaceId: destinationWorkspace.id,
							destinationPath: item.path,
							mode: clipboard.mode,
							overwrite,
						},
						{ timeoutMs: 30 * 60_000 },
					);
				} else {
					await copyBetweenHosts(
						source,
						destination,
						sourceWorkspaceId,
						destinationWorkspace.id,
						item.entry.path,
						item.path,
						overwrite,
						item.transfer.id,
						clipboard.mode === "move",
					);
				}
			};
			let overwrite = false;
			let renamed = false;
			for (;;) {
				if (transfers.isCancelled(item.transfer.id)) throw new CancelledError();
				try {
					await run(overwrite);
					break;
				} catch (error) {
					if (!(error instanceof PierProtocolError)) throw error;
					// Older Hosts report pasting into the source directory as BAD_REQUEST.
					const samePath = error.code === "BAD_REQUEST" && error.message.includes("same path");
					const kind = (error.data as { kind?: string } | undefined)?.kind;
					if (!samePath && (error.code !== "CONFLICT" || !["file", "directory", "other"].includes(kind ?? "")))
						throw error;
					const canOverwrite = !samePath && kind === "file" && item.entry.kind === "file" && !item.entry.symlink;
					const question: PasteConflictQuestion = {
						path: item.path,
						more: index < queued.length - 1,
						canOverwrite,
						suggestedName: suggestedPasteName(baseName(item.path), item.entry.kind),
						...(renamed ? { error: "此名称已被占用，请使用其他名称" } : {}),
					};
					if (overwrite) always = undefined;
					let answer: PasteConflictAnswer =
						canOverwrite && !renamed && always ? { choice: always } : await ask(question);
					while (answer.choice === "rename") {
						const invalid = pasteNameError(answer.name, baseName(item.path));
						if (!invalid) break;
						answer = await ask({ ...question, suggestedName: answer.name, error: invalid });
					}
					if (answer.choice === "cancel") throw new CancelledError();
					if (answer.choice === "rename") {
						const name = answer.name.trim();
						item.path = childPath(destinationDir, name);
						renamed = true;
						overwrite = false;
						transfers.update(item.transfer.id, { path: item.path, name, done: 0, cancellable: !sameHost });
						continue;
					}
					if (canOverwrite && answer.all) always = answer.choice;
					if (answer.choice === "skip") {
						skipped++;
						transfers.update(item.transfer.id, { state: "skipped" });
						continue entries;
					}
					if (!canOverwrite) throw error;
					overwrite = true;
				}
			}
			completed.push(item.entry.path);
			if (clipboard.mode === "move") store.closeMovedFilePreview(sourceWorkspaceId, item.entry.path);
			transfers.update(item.transfer.id, { state: "done" });
		} catch (error) {
			if (error instanceof CancelledError) {
				stopped = true;
				transfers.update(item.transfer.id, { state: "cancelled" });
			} else {
				failures++;
				transfers.update(item.transfer.id, { state: "error", error: transferErrorMessage(error) });
			}
		} finally {
			store.bumpFiles(sourceWorkspaceId);
			store.bumpFiles(destinationWorkspace.id);
		}
	}
	if (clipboard.mode === "move") completeWorkspaceMoves(clipboard, completed);
	const label = transferKindLabel(clipboard.mode);
	if (failures) store.toast("error", `已${label} ${completed.length} 项，${failures} 项失败；请查看传输列表`);
	else
		store.toast(
			"info",
			`已${label} ${completed.length} 项${skipped ? `，跳过 ${skipped} 项` : ""}${stopped ? "，其余已取消" : ""}`,
		);
}

/** Stream one regular file; only delete a moved source if its last-read version still exists. */
async function copyBetweenHosts(
	source: PierClient,
	destination: PierClient,
	sourceWorkspaceId: string,
	destinationWorkspaceId: string,
	sourcePath: string,
	destinationPath: string,
	overwrite: boolean,
	transferId: number,
	move: boolean,
): Promise<void> {
	let uploadId: string | undefined;
	try {
		let chunk = await source.request("workspace.readBytes", {
			workspaceId: sourceWorkspaceId,
			path: sourcePath,
			offset: 0,
			length: TRANSFER_CHUNK_BYTES,
		});
		const version = `${chunk.size}@${chunk.modifiedAt}`;
		const expectedModifiedAt = chunk.modifiedAt;
		const expectedSize = chunk.size;
		const started = await destination.request("workspace.uploadStart", {
			workspaceId: destinationWorkspaceId,
			path: destinationPath,
			size: chunk.size,
			overwrite,
		});
		uploadId = started.uploadId;
		let offset = 0;
		for (;;) {
			if (transfers.isCancelled(transferId)) throw new CancelledError();
			if (`${chunk.size}@${chunk.modifiedAt}` !== version) throw new Error("源文件在传输过程中被修改，请重试");
			if (chunk.data) {
				const result = await destination.request("workspace.uploadChunk", { uploadId, offset, data: chunk.data });
				const next = offset + base64Bytes(chunk.data);
				if (result.received !== next) throw new Error("目标电脑收到的字节数不一致，请重试");
				offset = next;
			}
			transfers.update(transferId, { total: chunk.size, done: offset });
			if (chunk.eof) break;
			if (!chunk.data) throw new Error("读取源文件失败，请重试");
			chunk = await source.request("workspace.readBytes", {
				workspaceId: sourceWorkspaceId,
				path: sourcePath,
				offset,
				length: Math.min(TRANSFER_CHUNK_BYTES, started.chunkBytes),
			});
		}
		if (transfers.isCancelled(transferId)) throw new CancelledError();
		transfers.update(transferId, { cancellable: false });
		await destination.request("workspace.uploadFinish", { uploadId });
		uploadId = undefined;
		if (move) {
			try {
				await source.request("workspace.deletePath", {
					workspaceId: sourceWorkspaceId,
					path: sourcePath,
					expectedModifiedAt,
					expectedSize,
				});
			} catch (error) {
				throw new Error(`文件已复制，但删除源文件失败：${transferErrorMessage(error)}`);
			}
		}
	} finally {
		if (uploadId) await destination.request("workspace.uploadCancel", { uploadId }).catch(() => {});
	}
}

/** Join a workspace directory and a relative name with "/". */
export function childPath(dir: string, name: string): string {
	return dir ? `${dir}/${name}` : name;
}

/** Local files picked in a file input, placed under `dir` (keeping folder structure). */
export function uploadItemsFromInput(files: FileList | null, dir: string): UploadItem[] {
	return [...(files ?? [])].map((file) => ({ file, path: childPath(dir, file.webkitRelativePath || file.name) }));
}

type Entry = FileSystemEntry;

function readAllEntries(reader: FileSystemDirectoryReader): Promise<Entry[]> {
	return new Promise((resolve, reject) => {
		const all: Entry[] = [];
		const next = () =>
			reader.readEntries((batch) => {
				if (!batch.length) resolve(all);
				else {
					all.push(...batch);
					next();
				}
			}, reject);
		next();
	});
}

async function walk(entry: Entry, path: string, out: UploadItem[]): Promise<void> {
	if (entry.isFile) {
		const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
		out.push({ file, path });
		return;
	}
	if (entry.isDirectory) {
		const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader());
		for (const child of children) await walk(child, `${path}/${child.name}`, out);
	}
}

/**
 * The entries of a drop. Call synchronously in the `drop` handler (the data transfer is only
 * readable there); the returned function lists the files, walking dropped folders.
 */
export function dropEntries(data: DataTransfer): (dir: string) => Promise<UploadItem[]> {
	const entries = [...data.items]
		.filter((item) => item.kind === "file")
		.map((item) => item.webkitGetAsEntry?.())
		.filter((entry): entry is Entry => Boolean(entry));
	const files = [...data.files];
	return async (dir) => {
		if (!entries.length) return files.map((file) => ({ file, path: childPath(dir, file.name) }));
		const out: UploadItem[] = [];
		for (const entry of entries) await walk(entry, childPath(dir, entry.name), out);
		return out;
	};
}

/** Whether a drag carries files from outside the page. */
export function dragHasFiles(data: DataTransfer | null): boolean {
	return Boolean(data && [...data.types].includes("Files"));
}

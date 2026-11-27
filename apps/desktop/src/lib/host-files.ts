/**
 * The file manager of the host hub (「远程主机 → 文件」): one directory of a computer through the
 * `host.*` methods (listing and transfers since protocol 1.57, managing files since 1.58), or a
 * workspace through `workspace.*` on Pier Hosts older than 1.57.
 */
import type { PierClient } from "@pier/client";
import {
	type HostInfo,
	PierProtocolError,
	type WorkspaceFileContent,
	type WorkspaceFileEntry,
	type WorkspaceFileWriteResult,
	type WorkspaceInfo,
	type WorkspacePathDeleteResult,
	type WorkspacePathTransferResult,
} from "@pier/protocol";
import { useSyncExternalStore } from "react";
import { workspaceNameError } from "./file-names.ts";
import {
	childPath,
	hostTransferKey,
	type OverwriteChoice,
	type PasteConflictAnswer,
	type PasteConflictQuestion,
	pasteNameError,
	suggestedPasteName,
	transferErrorMessage,
	transfers,
} from "./file-transfers.ts";
import { joinPath } from "./format.ts";
import { hostSpeaksMinor } from "./settings-target.ts";

/** The directory a file browser shows. Entry paths are relative to `directory` or the workspace root. */
export type FileScope =
	| { kind: "host"; node: string; directory: string }
	| { kind: "workspace"; node: string; workspace: WorkspaceInfo; dir: string };

/** The transfer list and file version counter of a scope. */
export function scopeKey(scope: FileScope): string {
	return scope.kind === "host" ? hostTransferKey(scope.node) : scope.workspace.id;
}

/** The path of `name` in the shown directory, as the scope's methods expect it. */
export function scopeChild(scope: FileScope, name: string): string {
	return scope.kind === "host" ? name : childPath(scope.dir, name);
}

/** The absolute path of an entry on its computer. */
export function scopeAbsolute(scope: FileScope, path: string): string {
	return joinPath(scope.kind === "host" ? scope.directory : scope.workspace.path, path);
}

/** The absolute path of the shown directory. */
export function scopeDirectory(scope: FileScope): string {
	return scope.kind === "host" ? scope.directory : joinPath(scope.workspace.path, scope.dir);
}

export interface FileAbilities {
	/** Upload and download files. */
	transfer: boolean;
	/** Preview, edit, create, rename, copy, move and delete. */
	manage: boolean;
}

/** What a host's Pier supports for a scope kind. */
export function fileAbilities(kind: FileScope["kind"], info: HostInfo | undefined): FileAbilities {
	return kind === "host"
		? { transfer: hostSpeaksMinor(info, 57), manage: hostSpeaksMinor(info, 58) }
		: { transfer: hostSpeaksMinor(info, 21), manage: hostSpeaksMinor(info, 41) };
}

/** Copies and moves of whole folders may take long on a slow disk. */
const TRANSFER_TIMEOUT_MS = 30 * 60_000;

/** The scope's file methods on its computer. */
export function scopeFiles(client: PierClient, scope: FileScope) {
	const host = scope.kind === "host" ? scope : undefined;
	const workspaceId = scope.kind === "workspace" ? scope.workspace.id : "";
	return {
		readFile(path: string): Promise<WorkspaceFileContent> {
			return host
				? client.request("host.readFile", { directory: host.directory, path })
				: client.request("workspace.readFile", { workspaceId, path });
		},
		writeFile(path: string, text: string, expectedModifiedAt?: string): Promise<WorkspaceFileWriteResult> {
			const version = expectedModifiedAt ? { expectedModifiedAt } : {};
			return host
				? client.request("host.writeFile", { directory: host.directory, path, text, ...version })
				: client.request("workspace.writeFile", { workspaceId, path, text, ...version });
		},
		createFile(path: string): Promise<WorkspaceFileWriteResult> {
			return host
				? client.request("host.createFile", { directory: host.directory, path })
				: client.request("workspace.createFile", { workspaceId, path });
		},
		createDirectory(path: string): Promise<{ path: string }> {
			return host
				? client.request("host.createDirectory", { directory: host.directory, path })
				: client.request("workspace.createDirectory", { workspaceId, path });
		},
		deletePath(path: string): Promise<WorkspacePathDeleteResult> {
			return host
				? client.request("host.deletePath", { directory: host.directory, path })
				: client.request("workspace.deletePath", { workspaceId, path });
		},
		/** Copy or move `path` of this scope to `destinationPath` of `destination` on the same computer. */
		transferTo(
			path: string,
			destination: FileScope,
			destinationPath: string,
			mode: "copy" | "move",
			overwrite = false,
		): Promise<WorkspacePathTransferResult> {
			if (destination.node !== scope.node || destination.kind !== scope.kind) {
				return Promise.reject(new Error("只能在同一台主机的同类位置之间复制或移动"));
			}
			const options = { timeoutMs: TRANSFER_TIMEOUT_MS };
			return host && destination.kind === "host"
				? client.request(
						"host.transferPath",
						{
							directory: host.directory,
							path,
							destinationDirectory: destination.directory,
							destinationPath,
							mode,
							overwrite,
						},
						options,
					)
				: client.request(
						"workspace.transferPath",
						{
							workspaceId,
							path,
							destinationWorkspaceId: destination.kind === "workspace" ? destination.workspace.id : "",
							destinationPath,
							mode,
							overwrite,
						},
						options,
					);
		},
	};
}

/** Human-readable reason of a failed file operation. */
export function fileErrorText(error: unknown): string {
	if (error instanceof PierProtocolError || (error as { code?: string })?.code) {
		const { code, message } = error as { code?: string; message: string };
		if (code === "BAD_REQUEST" && /Unknown method/.test(message)) return "这台主机的 Pier 版本过旧，请先更新它";
		if (code === "NOT_FOUND") return "文件或文件夹不存在，可能已被移动或删除";
		if (code === "FORBIDDEN") return "没有权限访问该位置";
		if (code === "CONFLICT" && /exists/.test(message)) return "已有同名文件或文件夹，请使用其他名称";
		if (code === "BAD_REQUEST" && /Not a directory/.test(message)) return "这不是文件夹";
		if (code === "BAD_REQUEST" && /Not a file/.test(message)) return "这不是普通文件";
	}
	return transferErrorMessage(error);
}

/** Rename an entry inside its directory, never replacing an existing one. */
export async function renameEntry(
	client: PierClient,
	scope: FileScope,
	entry: Pick<WorkspaceFileEntry, "path" | "name">,
	name: string,
): Promise<WorkspacePathTransferResult> {
	const invalid = workspaceNameError(name);
	if (invalid) throw new Error(invalid);
	const value = name.trim();
	if (value === entry.name) throw new Error("请输入新的名称");
	const destination = entry.path.slice(0, entry.path.length - entry.name.length) + value;
	return scopeFiles(client, scope).transferTo(entry.path, scope, destination, "move");
}

/** A new entry typed as a name or relative path inside the shown directory; undefined when invalid. */
export function newEntryPath(scope: FileScope, value: string): string | undefined {
	const text = value.trim();
	const segments = text.split(/[\\/]+/).filter((part) => part && part !== ".");
	if (!segments.length || /^[\\/]|^[a-zA-Z]:/.test(text) || segments.some((part) => part === "..")) return undefined;
	if (segments.some((part) => [...part].some((char) => char.charCodeAt(0) < 32))) return undefined;
	return scopeChild(scope, segments.join("/"));
}

// --- Listing --------------------------------------------------------------------------------

export type FileSortKey = "name" | "size" | "modified";

export interface FileSort {
	by: FileSortKey;
	desc: boolean;
}

function compareNames(a: WorkspaceFileEntry, b: WorkspaceFileEntry): number {
	const byName = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
	return byName || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Folders first, then by the chosen column; ties fall back to the name. */
export function sortFileEntries(entries: readonly WorkspaceFileEntry[], sort: FileSort): WorkspaceFileEntry[] {
	const sign = sort.desc ? -1 : 1;
	const folder = (entry: WorkspaceFileEntry) => (entry.kind === "directory" ? 0 : 1);
	const time = (entry: WorkspaceFileEntry) => (entry.modifiedAt ? Date.parse(entry.modifiedAt) || 0 : 0);
	return [...entries].sort((a, b) => {
		const column =
			sort.by === "size" ? (a.size ?? -1) - (b.size ?? -1) : sort.by === "modified" ? time(a) - time(b) : 0;
		return folder(a) - folder(b) || sign * column || sign * compareNames(a, b);
	});
}

/** Dotfiles are hidden unless asked for, like in common file managers. */
export function isHiddenEntry(entry: Pick<WorkspaceFileEntry, "name">): boolean {
	return entry.name.startsWith(".");
}

// --- Clipboard ------------------------------------------------------------------------------

export interface HostClipboardEntry {
	path: string;
	name: string;
	kind: "file" | "directory";
	symlink?: boolean;
}

export interface HostClipboard {
	mode: "copy" | "move";
	scope: FileScope;
	entries: HostClipboardEntry[];
}

let clipboard: HostClipboard | undefined;
let pasting = false;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getHostClipboard(): HostClipboard | undefined {
	return clipboard;
}

export function setHostClipboard(mode: HostClipboard["mode"], scope: FileScope, entries: HostClipboardEntry[]): void {
	clipboard = entries.length ? { mode, scope, entries: entries.map((entry) => ({ ...entry })) } : undefined;
	emit();
}

export function clearHostClipboard(): void {
	if (!clipboard) return;
	clipboard = undefined;
	emit();
}

/** The host file manager's clipboard, separate from the workspace file panel's. */
export function useHostClipboard(): HostClipboard | undefined {
	return useSyncExternalStore(subscribe, getHostClipboard, getHostClipboard);
}

const isPasting = () => pasting;

export function useHostPasteBusy(): boolean {
	return useSyncExternalStore(subscribe, isPasting, isPasting);
}

/** Whether the clipboard can be pasted into `scope`: copies and moves stay on one computer. */
export function canPasteInto(current: HostClipboard | undefined, scope: FileScope | undefined): boolean {
	return Boolean(current && scope && current.scope.node === scope.node && current.scope.kind === scope.kind);
}

/** Whether an entry is cut and still waits for its paste (shown dimmed). */
export function isCut(current: HostClipboard | undefined, scope: FileScope, path: string): boolean {
	if (current?.mode !== "move" || current.scope.node !== scope.node || current.scope.kind !== scope.kind) return false;
	if (scopeDirectory(current.scope) !== scopeDirectory(scope)) return false;
	return current.entries.some((entry) => entry.path === path);
}

/**
 * Paste the clipboard into the shown directory of `destination`, one entry at a time, asking
 * `ask` about name conflicts. Moved entries leave the clipboard. Resolves with the source paths
 * that were copied or moved.
 */
export async function pasteHostEntries(
	store: { toast(kind: "info" | "error", message: string): void; bumpFiles(key: string): void },
	client: PierClient,
	snapshot: HostClipboard,
	destination: FileScope,
	ask: (question: PasteConflictQuestion) => Promise<PasteConflictAnswer>,
): Promise<string[]> {
	if (pasting) {
		store.toast("info", "正在粘贴文件，请等待完成");
		return [];
	}
	if (!canPasteInto(snapshot, destination)) {
		store.toast("error", "只能粘贴到同一台主机；跨主机请先下载再上传");
		return [];
	}
	pasting = true;
	emit();
	const source = scopeFiles(client, snapshot.scope);
	const key = scopeKey(destination);
	const queued = snapshot.entries.map((entry) => {
		const path = scopeChild(destination, entry.name);
		return { entry, path, transfer: transfers.add({ kind: snapshot.mode, workspaceId: key, path, name: entry.name }) };
	});
	let always: OverwriteChoice | undefined;
	let stopped = false;
	let failures = 0;
	let skipped = 0;
	const completed: string[] = [];
	try {
		entries: for (const [index, item] of queued.entries()) {
			if (stopped || transfers.isCancelled(item.transfer.id)) {
				stopped = true;
				transfers.update(item.transfer.id, { state: "cancelled" });
				continue;
			}
			transfers.update(item.transfer.id, { state: "running", cancellable: false });
			try {
				let overwrite = false;
				let renamed = false;
				for (;;) {
					try {
						await source.transferTo(item.entry.path, destination, item.path, snapshot.mode, overwrite);
						break;
					} catch (error) {
						if (!(error instanceof PierProtocolError)) throw error;
						const samePath = error.code === "BAD_REQUEST" && error.message.includes("same path");
						const kind = (error.data as { kind?: string } | undefined)?.kind;
						if (!samePath && (error.code !== "CONFLICT" || !["file", "directory", "other"].includes(kind ?? "")))
							throw error;
						const canOverwrite = !samePath && kind === "file" && item.entry.kind === "file" && !item.entry.symlink;
						const name = item.path.slice(item.path.lastIndexOf("/") + 1);
						const question: PasteConflictQuestion = {
							path: scopeAbsolute(destination, item.path),
							more: index < queued.length - 1,
							canOverwrite,
							suggestedName: suggestedPasteName(name, item.entry.kind),
							...(renamed ? { error: "此名称已被占用，请使用其他名称" } : {}),
						};
						if (overwrite) always = undefined;
						let answer: PasteConflictAnswer =
							canOverwrite && !renamed && always ? { choice: always } : await ask(question);
						while (answer.choice === "rename") {
							const invalid = pasteNameError(answer.name, name);
							if (!invalid) break;
							answer = await ask({ ...question, suggestedName: answer.name, error: invalid });
						}
						if (answer.choice === "cancel") {
							stopped = true;
							transfers.update(item.transfer.id, { state: "cancelled" });
							continue entries;
						}
						if (answer.choice === "rename") {
							const value = answer.name.trim();
							item.path = scopeChild(destination, value);
							renamed = true;
							overwrite = false;
							transfers.update(item.transfer.id, { path: item.path, name: value });
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
				transfers.update(item.transfer.id, { state: "done" });
			} catch (error) {
				failures++;
				transfers.update(item.transfer.id, { state: "error", error: fileErrorText(error) });
			}
		}
	} finally {
		pasting = false;
		if (snapshot.mode === "move" && clipboard === snapshot && completed.length) {
			const moved = new Set(completed);
			const rest = snapshot.entries.filter((entry) => !moved.has(entry.path));
			clipboard = rest.length ? { ...snapshot, entries: rest } : undefined;
		}
		emit();
		store.bumpFiles(scopeKey(snapshot.scope));
		store.bumpFiles(key);
	}
	const label = snapshot.mode === "move" ? "移动" : "复制";
	if (failures) store.toast("error", `已${label} ${completed.length} 项，${failures} 项失败；请查看传输列表`);
	else
		store.toast(
			"info",
			`已${label} ${completed.length} 项${skipped ? `，跳过 ${skipped} 项` : ""}${stopped ? "，其余已取消" : ""}`,
		);
	return completed;
}

/**
 * Workspace clipboard entries as host entries, so they can be pasted into a directory outside
 * any workspace on the same computer (`host.transferPath` takes absolute directories).
 */
export function hostClipboardOfWorkspace(
	clipboard: { mode: HostClipboard["mode"]; entries: readonly HostClipboardEntry[] },
	node: string,
	workspacePath: string,
): HostClipboard {
	return {
		mode: clipboard.mode,
		scope: { kind: "host", node, directory: workspacePath },
		entries: clipboard.entries.map((entry) => ({ ...entry })),
	};
}

/** Whether `path` (relative to `directory`) or a folder holding it is cut and waits for its paste. */
export function isCutInDirectory(
	current: HostClipboard | undefined,
	node: string,
	directory: string,
	path: string,
): boolean {
	if (current?.mode !== "move" || current.scope.kind !== "host" || current.scope.node !== node) return false;
	if (current.scope.directory !== directory) return false;
	return current.entries.some((entry) => path === entry.path || path.startsWith(`${entry.path}/`));
}

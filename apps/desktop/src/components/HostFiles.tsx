import type { WorkspaceFilesResult, WorkspaceInfo } from "@pier/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	downloadFile,
	hostTransferKey,
	type OverwriteAnswer,
	type OverwriteQuestion,
	uploadFiles,
	uploadItemsFromInput,
} from "../lib/file-transfers.ts";
import { formatSize } from "../lib/format.ts";
import { hostSpeaksMinor } from "../lib/settings-target.ts";
import { type ComputerInfo, hostTransfersFiles, useAppState, useStore } from "../lib/store.tsx";
import { OverwriteDialog, TransferList } from "./FilesPanel.tsx";
import { IconArrowUp, IconDownload, IconFile, IconFolder, IconHome, IconRefresh, IconUpload } from "./Icons.tsx";
import { Select } from "./Select.tsx";

export function HostFiles({ computer }: { computer: ComputerInfo }) {
	const store = useStore();
	const [selected, setSelected] = useState("");
	if (hostSpeaksMinor(computer.state.hostInfo, 57)) return <TransferDirectory node={computer.id} />;
	if (!hostTransfersFiles(computer.state.hostInfo))
		return <p className="host-notice">请更新此主机的 Pier 以使用文件传输。</p>;
	const workspaces = computer.state.workspaces;
	const workspace = workspaces.find((item) => item.id === selected) ?? workspaces[0];
	return (
		<>
			<div className="host-legacy-files">
				<span>此版本支持工作区内的传输。</span>
				{workspace && (
					<Select
						ariaLabel="传输工作区"
						value={workspace.id}
						options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
						onChange={setSelected}
					/>
				)}
				<button type="button" onClick={() => void store.pickAndAddWorkspace(computer.id)}>
					添加工作区
				</button>
			</div>
			{workspace && <TransferDirectory key={workspace.id} node={computer.id} workspace={workspace} />}
		</>
	);
}

type Listing = WorkspaceFilesResult & { directory: string; parent?: string; separator: string };

function TransferDirectory({ node, workspace }: { node: string; workspace?: WorkspaceInfo }) {
	const store = useStore();
	const client = store.nodeClient(node);
	const key = workspace?.id ?? hostTransferKey(node);
	const version = useAppState((s) => s.filesVersion[key] ?? 0);
	const [directory, setDirectory] = useState("");
	const [address, setAddress] = useState("");
	const [listing, setListing] = useState<Listing>();
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [refresh, setRefresh] = useState(0);
	const fileInput = useRef<HTMLInputElement>(null);
	const [conflict, setConflict] = useState<OverwriteQuestion>();
	const answer = useRef<((value: OverwriteAnswer) => void) | undefined>(undefined);
	const mounted = useRef(false);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			answer.current?.({ choice: "cancel" });
		};
	}, []);
	const ask = (question: OverwriteQuestion): Promise<OverwriteAnswer> =>
		new Promise((resolve) => {
			if (!mounted.current) return resolve({ choice: "cancel" });
			answer.current?.({ choice: "cancel" });
			answer.current = resolve;
			setConflict(question);
		});
	const workspaceId = workspace?.id;
	const list = useCallback(async (): Promise<Listing> => {
		if (!client) throw new Error("主机未连接");
		if (!workspaceId) return client.request("host.files", directory ? { directory } : {});
		const result = await client.request("workspace.files", { workspaceId, path: directory });
		const parent = result.path.split("/").slice(0, -1).join("/");
		return { ...result, directory: result.path, separator: "/", ...(result.path ? { parent } : {}) };
	}, [client, workspaceId, directory]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: completed uploads and the refresh button reload the listing.
	useEffect(() => {
		let current = true;
		setLoading(true);
		setError("");
		void list()
			.then((value) => {
				if (!current) return;
				setListing(value);
				setAddress(value.directory);
			})
			.catch((e: unknown) => {
				if (!current) return;
				setListing(undefined);
				setError(e instanceof Error ? e.message : String(e));
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [list, version, refresh]);

	const go = (path: string) => {
		setAddress(path);
		setListing(undefined);
		setLoading(true);
		setDirectory(path);
		setRefresh((n) => n + 1);
	};
	const location = workspace ?? (listing && { node, directory: listing.directory });
	return (
		<section className="host-files" aria-label="主机文件">
			<form
				className="host-file-toolbar"
				onSubmit={(e) => {
					e.preventDefault();
					go(address.trim());
				}}
			>
				<button
					type="button"
					className="ghost icon"
					title="上一级目录"
					disabled={listing?.parent === undefined || loading}
					onClick={() => listing?.parent !== undefined && go(listing.parent)}
				>
					<IconArrowUp size={16} />
				</button>
				<button
					type="button"
					className="ghost icon"
					title={workspace ? "工作区根目录" : "主目录"}
					onClick={() => go("")}
				>
					<IconHome size={16} />
				</button>
				<input
					className="mono"
					aria-label="目录路径"
					placeholder={workspace ? workspace.path : "输入主机上的绝对路径"}
					value={address}
					onChange={(e) => setAddress(e.target.value)}
					spellCheck={false}
				/>
				<button type="button" className="ghost icon" title="刷新目录" onClick={() => setRefresh((n) => n + 1)}>
					<IconRefresh size={15} />
				</button>
				<button type="button" disabled={loading || !listing} onClick={() => fileInput.current?.click()}>
					<IconUpload size={15} />
					上传文件
				</button>
				<input
					type="file"
					multiple
					hidden
					ref={fileInput}
					onChange={(e) => {
						const items = uploadItemsFromInput(e.target.files, workspace ? (listing?.path ?? "") : "");
						e.target.value = "";
						if (location && listing) void uploadFiles(store, location, items, ask);
					}}
				/>
			</form>
			<div className="host-file-list">
				{error && (
					<p role="alert" className="host-notice error-text">
						{error}
					</p>
				)}
				{!listing && loading && <p className="host-notice">正在读取目录…</p>}
				{listing && !listing.entries.length && <p className="host-notice">此目录为空</p>}
				{listing?.entries.map((entry) => (
					<div className="host-file-row" key={entry.path}>
						{entry.kind === "directory" ? (
							<button
								type="button"
								className="ghost host-file-name"
								onClick={() => {
									const separator = listing.directory.endsWith(listing.separator) ? "" : listing.separator;
									go(workspace ? entry.path : listing.directory + separator + entry.name);
								}}
							>
								<IconFolder size={16} />
								<span>{entry.name}</span>
							</button>
						) : (
							<span className="host-file-name">
								<IconFile size={16} />
								<span>{entry.name}</span>
							</span>
						)}
						<span className="muted small">{entry.size !== undefined && formatSize(entry.size)}</span>
						{entry.kind === "file" && location && (
							<button
								type="button"
								className="ghost icon"
								title={`下载 ${entry.name}`}
								onClick={() => void downloadFile(store, location, entry.path)}
							>
								<IconDownload size={15} />
							</button>
						)}
					</div>
				))}
				{listing?.truncated && (
					<p className="host-notice">
						已显示 {listing.entries.length} 项，共 {listing.total} 项。
					</p>
				)}
			</div>
			<TransferList workspaceId={key} />
			{conflict && (
				<OverwriteDialog
					key={conflict.path}
					question={conflict}
					onAnswer={(value) => {
						answer.current?.(value);
						answer.current = undefined;
						setConflict(undefined);
					}}
				/>
			)}
		</section>
	);
}

import type { PierClient } from "@pier/client";
import type { WorkspaceFileContent } from "@pier/protocol";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, relativeTime } from "../lib/format.ts";
import { type FileScope, fileErrorText, scopeAbsolute, scopeFiles } from "../lib/host-files.ts";
import { isSensitiveFile } from "../lib/sensitive-files.ts";
import { TextEditor, TextView } from "./FileViewer.tsx";
import { IconAlert, IconDownload, IconFile, IconLoader, IconPencil, IconRefresh, IconShieldAlert } from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { Modal } from "./Modal.tsx";

const toLf = (text: string) => text.replace(/\r\n?/g, "\n");

/**
 * Preview of one file in the host file manager: text with line numbers and highlighting, an
 * image, or a note for binary files. Text read in full can be edited and saved back; saving
 * refuses to overwrite a file changed on disk unless confirmed.
 */
export function HostFileViewer({
	client,
	scope,
	path,
	name,
	editable,
	onClose,
	onDownload,
	onSaved,
}: {
	client: PierClient | undefined;
	scope: FileScope;
	path: string;
	name: string;
	editable: boolean;
	onClose: () => void;
	onDownload?: (() => void) | undefined;
	onSaved?: () => void;
}) {
	const [confirmed, setConfirmed] = useState(() => !isSensitiveFile(path));
	const [file, setFile] = useState<WorkspaceFileContent>();
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [draft, setDraft] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string>();
	const [conflict, setConflict] = useState(false);
	const [closePrompt, setClosePrompt] = useState(false);
	const request = useRef(0);

	const load = useCallback(async () => {
		const id = ++request.current;
		setLoading(true);
		setError(undefined);
		try {
			if (!client) throw new Error("主机未连接");
			const result = await scopeFiles(client, scope).readFile(path);
			if (request.current === id) setFile(result);
		} catch (e) {
			if (request.current === id) {
				setFile(undefined);
				setError(fileErrorText(e));
			}
		} finally {
			if (request.current === id) setLoading(false);
		}
	}, [client, scope, path]);

	useEffect(() => {
		if (confirmed) void load();
		return () => {
			++request.current;
		};
	}, [confirmed, load]);

	const original = useMemo(() => toLf(file?.text ?? ""), [file?.text]);
	const editing = draft !== undefined && !!file;
	const dirty = editing && draft !== original;
	const canEdit = editable && file?.kind === "text" && !file.truncated;

	const save = async (force = false): Promise<boolean> => {
		if (!client || !file || draft === undefined || saving) return false;
		const text = file.text?.includes("\r\n") ? draft.replace(/\n/g, "\r\n") : draft;
		setSaving(true);
		setSaveError(undefined);
		try {
			const result = await scopeFiles(client, scope).writeFile(path, text, force ? undefined : file.modifiedAt);
			setFile({ ...file, text, size: result.size, modifiedAt: result.modifiedAt });
			setConflict(false);
			setClosePrompt(false);
			onSaved?.();
			return true;
		} catch (e) {
			if ((e as { code?: string }).code === "CONFLICT") setConflict(true);
			else setSaveError(fileErrorText(e));
			return false;
		} finally {
			setSaving(false);
		}
	};
	const requestClose = () => {
		if (dirty) setClosePrompt(true);
		else onClose();
	};

	let body: ReactNode;
	if (!confirmed) {
		body = (
			<div className="file-viewer-notice warning">
				<IconShieldAlert size={22} />
				<div>
					<strong>这个文件可能包含私钥或凭据</strong>
					<p>内容会显示在屏幕上，请确认周围没有旁人或屏幕共享。</p>
				</div>
				<button type="button" className="subtle" onClick={() => setConfirmed(true)}>
					仍然显示
				</button>
			</div>
		);
	} else if (error !== undefined) {
		body = (
			<div className="file-viewer-notice error">
				<IconAlert size={20} />
				<div>
					<strong>无法打开文件</strong>
					<p>{error}</p>
				</div>
				<button type="button" className="subtle" onClick={() => void load()}>
					重试
				</button>
			</div>
		);
	} else if (!file) {
		body = (
			<div className="file-viewer-empty">
				<IconLoader size={16} className="spin" />
				正在读取…
			</div>
		);
	} else if (file.kind === "image") {
		body = file.data ? (
			<div className="file-viewer-image">
				<img src={`data:${file.mimeType};base64,${file.data}`} alt={name} />
			</div>
		) : (
			<div className="file-viewer-empty">图片太大（{formatBytes(file.size)}），无法预览，可以下载后查看</div>
		);
	} else if (file.kind === "binary") {
		body = (
			<div className="file-viewer-empty">
				<IconFile size={16} />
				二进制文件，无法以文本显示
			</div>
		);
	} else if (editing) {
		body = (
			<>
				{closePrompt ? (
					<div className="file-viewer-banner row">
						<span>有尚未保存的修改，要保存吗？</span>
						<button type="button" className="ghost small" onClick={() => setClosePrompt(false)}>
							继续编辑
						</button>
						<button type="button" className="ghost small error-text" onClick={onClose}>
							不保存
						</button>
						<button
							type="button"
							className="primary small"
							disabled={saving}
							onClick={() => void save().then((ok) => ok && onClose())}
						>
							保存并关闭
						</button>
					</div>
				) : null}
				{conflict ? (
					<div className="file-viewer-banner row">
						<span>文件在打开后已被修改，保存会覆盖磁盘上的内容。</span>
						<button
							type="button"
							className="ghost small"
							onClick={() => {
								setDraft(undefined);
								setConflict(false);
								void load();
							}}
						>
							放弃修改并重新读取
						</button>
						<button type="button" className="primary small" disabled={saving} onClick={() => void save(true)}>
							仍然覆盖
						</button>
					</div>
				) : null}
				{saveError ? <div className="file-viewer-banner error">保存失败：{saveError}</div> : null}
				<TextEditor value={draft} path={path} onChange={setDraft} onSave={() => void save()} />
			</>
		);
	} else {
		body = (
			<>
				{file.truncated ? (
					<div className="file-viewer-banner">文件较大（{formatBytes(file.size)}），仅显示开头部分</div>
				) : null}
				<TextView file={file} />
			</>
		);
	}

	const absolute = scopeAbsolute(scope, path);
	return (
		<Modal title={name} wide className="host-file-viewer" onClose={requestClose}>
			<div className="file-viewer">
				<div className="file-viewer-toolbar">
					<span className="file-viewer-meta" title={absolute}>
						<span className="file-viewer-path">{absolute}</span>
						{file ? (
							<span>
								{formatBytes(file.size)} · 修改于 {relativeTime(file.modifiedAt)}
							</span>
						) : null}
					</span>
					<span className="file-viewer-actions">
						{editing ? (
							<>
								<span className="file-viewer-hint">{dirty ? "未保存" : "已保存"} · Ctrl/⌘+S 保存</span>
								<button
									type="button"
									className="ghost small"
									disabled={saving}
									onClick={() => {
										if (dirty) setDraft(original);
										else {
											setDraft(undefined);
											setSaveError(undefined);
											setConflict(false);
											setClosePrompt(false);
										}
									}}
								>
									{dirty ? "撤销修改" : "完成"}
								</button>
								<button type="button" className="primary small" disabled={!dirty || saving} onClick={() => void save()}>
									{saving ? <IconLoader size={13} className="spin" /> : null}
									保存
								</button>
							</>
						) : (
							<>
								{canEdit ? (
									<button
										type="button"
										className="ghost small"
										title="编辑文件"
										onClick={() => {
											setDraft(original);
											setSaveError(undefined);
											setConflict(false);
										}}
									>
										<IconPencil size={13} />
										编辑
									</button>
								) : null}
								{file?.kind === "text" && file.text ? <CopyButton text={file.text} label="复制内容" /> : null}
								<CopyButton text={absolute} label="复制路径" iconOnly />
								{onDownload ? (
									<button type="button" className="ghost icon" title="下载到本机" onClick={onDownload}>
										<IconDownload size={14} />
									</button>
								) : null}
								<button
									type="button"
									className="ghost icon"
									title="重新读取"
									disabled={!confirmed || loading}
									onClick={() => void load()}
								>
									<IconRefresh size={14} className={loading ? "spin" : undefined} />
								</button>
							</>
						)}
					</span>
				</div>
				<div className="file-viewer-body">{body}</div>
			</div>
		</Modal>
	);
}

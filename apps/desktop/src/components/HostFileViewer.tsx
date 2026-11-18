import type { PierClient } from "@pier/client";
import type { WorkspaceFileContent } from "@pier/protocol";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { formatBytes, relativeTime } from "../lib/format.ts";
import { type FileScope, fileErrorText, scopeAbsolute, scopeFiles } from "../lib/host-files.ts";
import { isSensitiveFile } from "../lib/sensitive-files.ts";
import { CodeEditor, type CodeEditorHandle, SAVE_SHORTCUT } from "./CodeEditor.tsx";
import {
	IconAlert,
	IconDownload,
	IconFile,
	IconLoader,
	IconRefresh,
	IconSave,
	IconShieldAlert,
	IconUndo,
} from "./Icons.tsx";
import { CopyButton } from "./Markdown.tsx";
import { Modal } from "./Modal.tsx";

/**
 * Preview of one file in the host file manager: text in VS Code's editor (Monaco), an image, or a
 * note for binary files. Text read in full can be edited in place and saved with Ctrl/⌘+S; saving
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
	/** The file as last read or saved; edits in progress live in the editor. */
	const [file, setFile] = useState<WorkspaceFileContent>();
	/** Bumped for every read, so the editor starts over with the file's new text. */
	const [reads, setReads] = useState(0);
	const [error, setError] = useState<string>();
	const [loading, setLoading] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string>();
	const [conflict, setConflict] = useState(false);
	const [closePrompt, setClosePrompt] = useState(false);
	const request = useRef(0);
	const editor = useRef<CodeEditorHandle>(null);

	const load = useCallback(async () => {
		const id = ++request.current;
		setLoading(true);
		setError(undefined);
		setDirty(false);
		setSaveError(undefined);
		setConflict(false);
		setClosePrompt(false);
		try {
			if (!client) throw new Error("主机未连接");
			const result = await scopeFiles(client, scope).readFile(path);
			if (request.current === id) {
				setFile(result);
				setReads((n) => n + 1);
			}
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

	const isText = file?.kind === "text";
	const canEdit = editable && isText && !file.truncated;
	const readOnlyReason = !isText
		? undefined
		: file.truncated
			? "文件太大，只读取了开头部分，无法编辑"
			: !editable
				? "主机未连接，或那台电脑的 Pier 版本不支持编辑文件"
				: undefined;

	/** Write the editor's text; `force` skips the check that the file is unchanged on disk. */
	const save = async (force = false): Promise<boolean> => {
		const handle = editor.current;
		if (!client || !file || !handle || !canEdit || saving) return false;
		const text = handle.getValue();
		const version = handle.version();
		setSaving(true);
		setSaveError(undefined);
		try {
			const result = await scopeFiles(client, scope).writeFile(path, text, force ? undefined : file.modifiedAt);
			setFile({ ...file, text, size: result.size, modifiedAt: result.modifiedAt });
			handle.markSaved(version);
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
	// Ctrl/⌘+S in the editor saves with the latest state.
	const saveHandler = useRef(save);
	saveHandler.current = save;
	const onEditorSave = useCallback(() => void saveHandler.current(), []);
	/** Drop unsaved edits (undoably, as VS Code's "Revert File"). */
	const revert = () => {
		editor.current?.revert(file?.text ?? "");
		setSaveError(undefined);
		setConflict(false);
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
	} else {
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
						<button type="button" className="ghost small" onClick={() => void load()}>
							放弃修改并重新读取
						</button>
						<button type="button" className="primary small" disabled={saving} onClick={() => void save(true)}>
							仍然覆盖
						</button>
					</div>
				) : null}
				{saveError ? <div className="file-viewer-banner error">保存失败：{saveError}</div> : null}
				{file.truncated ? (
					<div className="file-viewer-banner">文件较大（{formatBytes(file.size)}），仅显示开头部分，无法编辑</div>
				) : null}
				<CodeEditor
					key={reads}
					ref={editor}
					path={path}
					value={file.text ?? ""}
					readOnly={!canEdit}
					readOnlyReason={readOnlyReason}
					onDirtyChange={setDirty}
					onSave={onEditorSave}
				/>
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
						{isText && file.text !== undefined ? (
							<CopyButton text={() => editor.current?.getValue() ?? file.text ?? ""} label="复制内容" />
						) : null}
						<CopyButton text={absolute} label="复制路径" iconOnly />
						{onDownload ? (
							<button type="button" className="ghost icon" title="下载到本机" onClick={onDownload}>
								<IconDownload size={14} />
							</button>
						) : null}
						<button
							type="button"
							className="ghost icon"
							title={dirty ? "有未保存的修改，请先保存或还原" : "重新读取"}
							disabled={!confirmed || loading || dirty}
							onClick={() => void load()}
						>
							<IconRefresh size={14} className={loading ? "spin" : undefined} />
						</button>
						{dirty ? (
							<>
								<button
									type="button"
									className="ghost small"
									title="放弃未保存的修改（可撤销）"
									disabled={saving}
									onClick={revert}
								>
									<IconUndo size={13} />
									还原
								</button>
								<button
									type="button"
									className="primary small"
									title={`保存 (${SAVE_SHORTCUT})`}
									disabled={saving}
									onClick={() => void save()}
								>
									{saving ? <IconLoader size={13} className="spin" /> : <IconSave size={13} />}
									保存
								</button>
							</>
						) : null}
					</span>
				</div>
				<div className="file-viewer-body">{body}</div>
			</div>
		</Modal>
	);
}

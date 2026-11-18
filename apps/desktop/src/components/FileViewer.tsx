import type { WorkspaceFileContent } from "@pier/protocol";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { downloadFile } from "../lib/file-transfers.ts";
import { formatBytes, joinPath, relativeTime, relativeWorkspacePath } from "../lib/format.ts";
import { filePreviewAuthorizationPath, filePreviewError } from "../lib/markdown-files.ts";
import { isSensitiveFile } from "../lib/sensitive-files.ts";
import {
	hostAuthorizesFilePreviews,
	hostSupportsPreviewDownloads,
	hostTransfersFiles,
	LOCAL_NODE,
	useAppState,
	useCanManageWorkspace,
	useStore,
} from "../lib/store.tsx";
import { CodeEditor, type CodeEditorHandle, SAVE_SHORTCUT } from "./CodeEditor.tsx";
import { HtmlPreview } from "./HtmlPreview.tsx";
import {
	IconAlert,
	IconDownload,
	IconFile,
	IconFolderOpen,
	IconLoader,
	IconMessagePlus,
	IconRefresh,
	IconSave,
	IconShieldAlert,
	IconUndo,
} from "./Icons.tsx";
import { CopyButton, Markdown, MarkdownFiles } from "./Markdown.tsx";

function errorText(error: unknown): string {
	const code = (error as { code?: string }).code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message)) return "当前 Pier Host 版本不支持预览文件，请更新 Pier";
	if (code === "NOT_FOUND") return "文件不存在，可能已被移动或删除";
	if (code === "FORBIDDEN") return /outside/.test(message) ? "该文件位于工作区之外，无法预览" : "没有权限读取该文件";
	if (code === "BAD_REQUEST" && /Not a file/.test(message)) return "这不是普通文件，无法预览";
	return message;
}

function saveErrorText(error: unknown): string {
	const code = (error as { code?: string }).code;
	const message = error instanceof Error ? error.message : String(error);
	if (code === "BAD_REQUEST" && /Unknown method/.test(message)) return "当前 Pier Host 版本不支持编辑文件，请更新 Pier";
	if (code === "NOT_FOUND") return "文件不存在，可能已被移动或删除";
	if (code === "FORBIDDEN") return /outside/.test(message) ? "该文件位于工作区之外，无法保存" : "没有权限写入该文件";
	if (code === "BAD_REQUEST" && /larger than/.test(message)) return "内容太大，无法保存";
	return message;
}

const isConflict = (error: unknown) => (error as { code?: string }).code === "CONFLICT";

const MARKDOWN = /\.(md|markdown|mdx)$/i;
const HTML = /\.html?$/i;

/** The path as VS Code's breadcrumbs show it: folders then the file name, which never shrinks away. */
function Breadcrumbs({ path }: { path: string }) {
	const parts = path.split(/[\\/]/).filter(Boolean);
	const name = parts.pop() ?? path;
	return (
		<span className="file-viewer-breadcrumbs">
			{parts.map((part, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: path segments repeat and never reorder.
				<span key={index} className="file-viewer-crumb">
					{part}
				</span>
			))}
			<span className="file-viewer-crumb current">{name}</span>
		</span>
	);
}

/**
 * One workspace file in the preview. Text opens in VS Code's editor (Monaco) with syntax
 * highlighting and, when the file was read in full and its computer accepts edits, can be edited
 * in place and saved with Ctrl/⌘+S. Markdown and HTML open rendered, with a source view to edit
 * them; images show as images. `onInsert` inserts the path into the composer when present (and
 * closes the file after it with `closeOnInsert`). The file name shows on its tab in `SidePanel`,
 * so the viewer reports unsaved edits through `onDirtyChange`; bumping `closeRequest` asks to
 * close the file, which first offers to save unsaved edits.
 */
export function FileViewer({
	workspaceId,
	path,
	onClose,
	onInsert,
	closeOnInsert = true,
	fromMarkdown = false,
	onDirtyChange,
	closeRequest = 0,
}: {
	workspaceId: string;
	path: string;
	onClose: () => void;
	onInsert?: (() => void) | undefined;
	closeOnInsert?: boolean;
	fromMarkdown?: boolean | undefined;
	onDirtyChange?: ((dirty: boolean) => void) | undefined;
	closeRequest?: number;
}) {
	const store = useStore();
	const [confirmed, setConfirmed] = useState(() => !isSensitiveFile(path));
	/** The file as last read or saved; edits in progress live in the editor. */
	const [file, setFile] = useState<WorkspaceFileContent>();
	/** Bumped for every read, so the editor starts over with the file's new text. */
	const [reads, setReads] = useState(0);
	const [error, setError] = useState<unknown>();
	const [authorizationPrompt, setAuthorizationPrompt] = useState(false);
	const [loading, setLoading] = useState(false);
	const [rendered, setRendered] = useState(true);
	/** Markdown / HTML: the source editor stays mounted (with its edits) once it has been shown. */
	const [sourceShown, setSourceShown] = useState(false);
	/** The text the rendered view shows, taken from the editor when switching to it. */
	const [renderedText, setRenderedText] = useState<string>();
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string>();
	const [conflict, setConflict] = useState(false);
	const [closePrompt, setClosePrompt] = useState(false);
	const [downloading, setDownloading] = useState(false);
	const [authorizedPreviewPath, setAuthorizedPreviewPath] = useState<string>();
	const request = useRef(0);
	const editor = useRef<CodeEditorHandle>(null);

	const load = useCallback(
		async (authorizedPath?: string) => {
			const id = ++request.current;
			setLoading(true);
			setError(undefined);
			setFile(undefined);
			setAuthorizationPrompt(false);
			setDirty(false);
			setRenderedText(undefined);
			setSaveError(undefined);
			setConflict(false);
			setClosePrompt(false);
			try {
				const result = await (authorizedPath
					? store.authorizeFilePreview(workspaceId, path, authorizedPath)
					: fromMarkdown
						? store.previewFile(workspaceId, path)
						: store.readFile(workspaceId, path));
				if (request.current === id) {
					setFile(result);
					setReads((n) => n + 1);
					setAuthorizedPreviewPath(authorizedPath);
				}
			} catch (e) {
				if (request.current === id) setError(e);
			} finally {
				if (request.current === id) setLoading(false);
			}
		},
		[store, workspaceId, path, fromMarkdown],
	);

	useEffect(() => {
		if (confirmed) void load();
		return () => {
			++request.current;
		};
	}, [confirmed, load]);

	const previewNode = useAppState((s) => s.workspaceNodes[workspaceId] || s.node);
	const previewHost = useAppState((s) => s.nodes[previewNode]?.hostInfo);
	const workspace = useAppState((s) => s.workspaces.find((workspace) => workspace.id === workspaceId));
	const workspacePath = workspace?.path;
	const absolutePath = /^(?:[\\/]|[a-zA-Z]:[\\/])/.test(path)
		? path
		: workspacePath
			? joinPath(workspacePath, path)
			: undefined;
	const downloadPath = workspacePath && absolutePath ? relativeWorkspacePath(workspacePath, absolutePath) : undefined;
	const previewDownloadPath = downloadPath ?? (fromMarkdown ? path : undefined);
	const expectedRealPath = downloadPath ? undefined : authorizedPreviewPath;
	const previewDownload = !downloadPath && fromMarkdown;
	const canDownload =
		!!workspace &&
		!!previewDownloadPath &&
		hostTransfersFiles(previewHost) &&
		(!previewDownload || hostSupportsPreviewDownloads(previewHost, previewNode !== LOCAL_NODE));
	const canReveal = previewNode === LOCAL_NODE && store.canRevealPaths && !!absolutePath;
	const authorizationPath = fromMarkdown ? filePreviewAuthorizationPath(error) : undefined;
	const canAuthorize = !!authorizationPath && hostAuthorizesFilePreviews(previewHost, previewNode !== LOCAL_NODE);

	const name = path.split(/[\\/]/).pop() || path;
	const isText = file?.kind === "text";
	const isMarkdown = MARKDOWN.test(path) && isText;
	const isHtml = HTML.test(path) && isText && !file.truncated;
	const renderable = isMarkdown || isHtml;
	const showRendered = renderable && rendered;
	// Paired computers on protocol 1.10+ accept edits; older ones are read-only from here.
	const canManage = useCanManageWorkspace(workspaceId);
	const editable = !fromMarkdown && canManage && isText && !file.truncated;
	const readOnlyReason = !isText
		? undefined
		: fromMarkdown
			? "这是从 Markdown 链接打开的只读预览"
			: file.truncated
				? "文件太大，只读取了开头部分，无法编辑"
				: !canManage
					? "那台电脑的 Pier 版本过旧，不支持远程编辑文件"
					: undefined;

	/** Write the editor's text; `force` skips the check that the file is unchanged on disk. */
	const save = async (force = false): Promise<boolean> => {
		const handle = editor.current;
		if (!file || !handle || !editable || saving) return false;
		const text = handle.getValue();
		const version = handle.version();
		setSaving(true);
		setSaveError(undefined);
		try {
			const result = await store.writeFile(workspaceId, path, text, force ? undefined : file.modifiedAt);
			setFile({ ...file, text, size: result.size, modifiedAt: result.modifiedAt });
			handle.markSaved(version);
			setConflict(false);
			setClosePrompt(false);
			return true;
		} catch (e) {
			if (isConflict(e)) setConflict(true);
			else setSaveError(saveErrorText(e));
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

	useEffect(() => {
		onDirtyChange?.(dirty);
	}, [dirty, onDirtyChange]);

	// Close requests from the tab strip (changes after mount); the latest handler sees the latest edits.
	const closeHandler = useRef(requestClose);
	closeHandler.current = requestClose;
	const handledCloseRequest = useRef(closeRequest);
	useEffect(() => {
		if (closeRequest === handledCloseRequest.current) return;
		handledCloseRequest.current = closeRequest;
		closeHandler.current();
	}, [closeRequest]);

	const showRenderedView = (next: boolean) => {
		if (next) setRenderedText(editor.current?.getValue());
		else setSourceShown(true);
		setRendered(next);
	};

	const download = async () => {
		if (!workspace || !previewDownloadPath || downloading) return;
		setDownloading(true);
		try {
			await downloadFile(store, workspace, previewDownloadPath, expectedRealPath, previewDownload);
		} finally {
			setDownloading(false);
		}
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
	} else if (authorizationPrompt && canAuthorize && authorizationPath) {
		body = (
			<div className="file-viewer-notice warning file-viewer-authorization">
				<IconShieldAlert size={22} />
				<div>
					<strong>授权读取工作区外的文件？</strong>
					<p>将读取并显示「{store.nodeName(previewNode)}」上的以下文件：</p>
					<p className="file-viewer-authorization-path">{authorizationPath}</p>
					<p>仅授权这次只读预览。刷新或重新打开文件时需要再次确认。</p>
					{isSensitiveFile(authorizationPath) ? <p>该文件可能包含私钥或凭据，请确认后再显示。</p> : null}
					<div className="file-viewer-confirm-actions">
						<button type="button" className="subtle" onClick={() => setAuthorizationPrompt(false)}>
							取消
						</button>
						<button type="button" className="primary" onClick={() => void load(authorizationPath)}>
							仅授权这次预览
						</button>
					</div>
				</div>
			</div>
		);
	} else if (error !== undefined) {
		body = (
			<div className="file-viewer-notice error">
				<IconAlert size={20} />
				<div>
					<strong>无法打开文件</strong>
					<p>{fromMarkdown ? filePreviewError(error, previewHost?.platform) : errorText(error)}</p>
					{authorizationPath && !canAuthorize ? (
						<p>
							{previewNode === LOCAL_NODE
								? "请更新 Pier 后授权预览，或将文件放到当前工作区。"
								: "请更新文件所在电脑的 Pier 以支持远程授权，或将文件放到当前工作区。"}
						</p>
					) : null}
				</div>
				<button
					type="button"
					className={canAuthorize ? "primary" : "subtle"}
					onClick={() => (canAuthorize ? setAuthorizationPrompt(true) : void load())}
				>
					{canAuthorize ? "授权并打开" : "重试"}
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
			<div className="file-viewer-empty">图片太大（{formatBytes(file.size)}），无法预览</div>
		);
	} else if (file.kind === "binary") {
		body = (
			<div className="file-viewer-empty">
				<IconFile size={16} />
				二进制文件，无法以文本显示
			</div>
		);
	} else {
		const text = file.text ?? "";
		const shownText = renderedText ?? text;
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
				{showRendered ? (
					isHtml ? (
						<HtmlPreview html={shownText} title={name} />
					) : (
						<div className="file-viewer-markdown">
							<MarkdownFiles
								workspaceId={workspaceId}
								basePath={path.replace(/\\/g, "/").split("/").slice(0, -1).join("/")}
							>
								<Markdown text={shownText} />
							</MarkdownFiles>
						</div>
					)
				) : null}
				{!renderable || sourceShown || !rendered ? (
					<div className={`file-viewer-source${showRendered ? " hidden" : ""}`}>
						<CodeEditor
							key={reads}
							ref={editor}
							path={path}
							value={text}
							readOnly={!editable}
							readOnlyReason={readOnlyReason}
							onDirtyChange={setDirty}
							onSave={onEditorSave}
						/>
					</div>
				) : null}
			</>
		);
	}

	return (
		<div className="file-viewer">
			<div className="file-viewer-toolbar">
				<span className="file-viewer-meta" title={path}>
					<Breadcrumbs path={path} />
					{file ? (
						<span>
							{formatBytes(file.size)} · 修改于 {relativeTime(file.modifiedAt)}
						</span>
					) : null}
				</span>
				<span className="file-viewer-actions">
					{canReveal ? (
						<button
							type="button"
							className="ghost small"
							title="打开所在文件夹并选中文件"
							onClick={() => absolutePath && store.revealPath(absolutePath)}
						>
							<IconFolderOpen size={14} />
							<span className="file-viewer-action-label">打开所在文件夹</span>
						</button>
					) : null}
					{renderable ? (
						<span className="segmented" role="tablist" aria-label="显示方式">
							<button
								type="button"
								className={rendered ? "active" : ""}
								role="tab"
								aria-selected={rendered}
								onClick={() => showRenderedView(true)}
							>
								预览
							</button>
							<button
								type="button"
								className={rendered ? "" : "active"}
								role="tab"
								aria-selected={!rendered}
								onClick={() => showRenderedView(false)}
							>
								源码
							</button>
						</span>
					) : null}
					{isText && file.text !== undefined ? (
						<CopyButton text={() => editor.current?.getValue() ?? file.text ?? ""} label="复制内容" />
					) : null}
					<CopyButton text={path} label="复制路径" iconOnly />
					{file ? (
						<button
							type="button"
							className="ghost icon"
							title={
								canDownload
									? "下载到本机"
									: previewDownload
										? "当前 Pier 版本不支持下载预览文件，请先更新"
										: "只能下载工作区内的文件，请将文件放入当前工作区"
							}
							disabled={!canDownload || downloading}
							onClick={() => void download()}
						>
							{downloading ? <IconLoader size={14} className="spin" /> : <IconDownload size={14} />}
						</button>
					) : null}
					{onInsert ? (
						<button
							type="button"
							className="ghost icon"
							title="插入路径到输入框"
							onClick={() => {
								onInsert();
								if (closeOnInsert) requestClose();
							}}
						>
							<IconMessagePlus size={14} />
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
								<span className="file-viewer-action-label">还原</span>
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
	);
}

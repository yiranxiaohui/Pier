import type { WorkspaceFileContent } from "@pier/protocol";
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes, joinPath, languageForPath, relativeTime } from "../lib/format.ts";
import { filePreviewAuthorizationPath, filePreviewError } from "../lib/markdown-files.ts";
import { isSensitiveFile } from "../lib/sensitive-files.ts";
import { hostAuthorizesFilePreviews, LOCAL_NODE, useAppState, useCanManageWorkspace, useStore } from "../lib/store.tsx";
import {
	IconAlert,
	IconFile,
	IconFolderOpen,
	IconLoader,
	IconMessagePlus,
	IconPencil,
	IconRefresh,
	IconShieldAlert,
} from "./Icons.tsx";
import { CopyButton, Markdown, MarkdownFiles } from "./Markdown.tsx";
import { Modal } from "./Modal.tsx";
import { Highlighted } from "./ToolCard.tsx";

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

/** Text areas report "\n" line breaks only, so CRLF files are edited as LF and converted back on save. */
const toLf = (text: string) => text.replace(/\r\n?/g, "\n");

/** The indentation Tab inserts: the file's own style when it has one, else a tab (two spaces for YAML). */
function indentUnit(text: string, path: string): string {
	if (/^\t/m.test(text)) return "\t";
	const widths = [...text.matchAll(/^( +)\S/gm)].map((m) => m[1]?.length ?? 0);
	const width = widths.length ? Math.min(...widths) : 0;
	if (width === 2 || width === 4) return " ".repeat(width);
	return /\.ya?ml$/i.test(path) ? "  " : "\t";
}

/** Insert text at the caret, keeping the browser's undo history when it can. */
function insertAtCaret(area: HTMLTextAreaElement, text: string, onChange: (value: string) => void) {
	if (document.execCommand("insertText", false, text)) return;
	area.setRangeText(text, area.selectionStart, area.selectionEnd, "end");
	onChange(area.value);
}

function TextEditor({
	value,
	path,
	onChange,
	onSave,
}: {
	value: string;
	path: string;
	onChange: (value: string) => void;
	onSave: () => void;
}) {
	const gutter = useRef<HTMLPreElement>(null);
	const area = useRef<HTMLTextAreaElement>(null);
	const lines = useMemo(() => Array.from({ length: value.split("\n").length }, (_, i) => i + 1).join("\n"), [value]);
	const indent = useMemo(() => indentUnit(value, path), [value, path]);
	useEffect(() => {
		const el = area.current;
		if (!el) return;
		el.focus();
		el.setSelectionRange(0, 0);
	}, []);
	const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
			e.preventDefault();
			onSave();
		} else if (e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
			e.preventDefault();
			insertAtCaret(e.currentTarget, indent, onChange);
		}
	};
	return (
		<div className="file-viewer-editor">
			<pre ref={gutter} className="file-viewer-gutter" aria-hidden="true">
				{lines}
			</pre>
			<textarea
				ref={area}
				value={value}
				spellCheck={false}
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				wrap="off"
				aria-label="文件内容"
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={onKeyDown}
				onScroll={(e) => {
					if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
				}}
			/>
		</div>
	);
}

const MARKDOWN = /\.(md|markdown|mdx)$/i;

function TextView({ file }: { file: WorkspaceFileContent }) {
	const text = file.text ?? "";
	const lines = useMemo(() => {
		const count = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
		return Array.from({ length: Math.max(count, 1) }, (_, i) => i + 1).join("\n");
	}, [text]);
	if (!text) return <div className="file-viewer-empty">空文件</div>;
	return (
		<div className="file-viewer-code">
			<pre className="file-viewer-gutter" aria-hidden="true">
				{lines}
			</pre>
			<pre className="file-viewer-text">
				<Highlighted code={text} language={languageForPath(file.path)} />
			</pre>
		</div>
	);
}

/**
 * Preview of one workspace file: text with line numbers and syntax highlighting, rendered
 * Markdown, or an image. Text files that were read in full can be edited and saved back.
 * `onInsert` inserts the path into the composer when present.
 */
export function FileViewer({
	workspaceId,
	path,
	onClose,
	onInsert,
	fromMarkdown = false,
}: {
	workspaceId: string;
	path: string;
	onClose: () => void;
	onInsert?: (() => void) | undefined;
	fromMarkdown?: boolean;
}) {
	const store = useStore();
	const [confirmed, setConfirmed] = useState(() => !isSensitiveFile(path));
	const [file, setFile] = useState<WorkspaceFileContent>();
	const [error, setError] = useState<unknown>();
	const [authorizationPrompt, setAuthorizationPrompt] = useState(false);
	const [loading, setLoading] = useState(false);
	const [rendered, setRendered] = useState(true);
	/** The text being edited; undefined while previewing. */
	const [draft, setDraft] = useState<string>();
	const [saving, setSaving] = useState(false);
	const [saveError, setSaveError] = useState<string>();
	const [conflict, setConflict] = useState(false);
	const [closePrompt, setClosePrompt] = useState(false);
	const request = useRef(0);

	const load = useCallback(
		async (authorizedPath?: string) => {
			const id = ++request.current;
			setLoading(true);
			setError(undefined);
			setFile(undefined);
			setAuthorizationPrompt(false);
			try {
				const result = await (authorizedPath
					? store.authorizeFilePreview(workspaceId, path, authorizedPath)
					: fromMarkdown
						? store.previewFile(workspaceId, path)
						: store.readFile(workspaceId, path));
				if (request.current === id) setFile(result);
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
	const workspacePath = useAppState((s) => s.workspaces.find((workspace) => workspace.id === workspaceId)?.path);
	const absolutePath = /^(?:[\\/]|[a-zA-Z]:[\\/])/.test(path)
		? path
		: workspacePath
			? joinPath(workspacePath, path)
			: undefined;
	const canReveal = previewNode === LOCAL_NODE && store.canRevealPaths && !!absolutePath;
	const authorizationPath = fromMarkdown ? filePreviewAuthorizationPath(error) : undefined;
	const canAuthorize = !!authorizationPath && hostAuthorizesFilePreviews(previewHost, previewNode !== LOCAL_NODE);

	const name = path.split("/").pop() ?? path;
	const isMarkdown = MARKDOWN.test(path) && file?.kind === "text";
	// Paired computers on protocol 1.10+ accept edits; older ones are read-only from here.
	const local = useCanManageWorkspace(workspaceId);
	const editable = !fromMarkdown && local && file?.kind === "text" && !file.truncated;
	const editing = draft !== undefined && !!file;
	const original = useMemo(() => toLf(file?.text ?? ""), [file?.text]);
	const dirty = editing && draft !== original;

	const startEditing = () => {
		setDraft(original);
		setSaveError(undefined);
		setConflict(false);
	};
	const stopEditing = () => {
		setDraft(undefined);
		setSaveError(undefined);
		setConflict(false);
		setClosePrompt(false);
	};

	/** Write the draft; `force` skips the check that the file is unchanged on disk. */
	const save = async (force = false): Promise<boolean> => {
		if (!file || draft === undefined || saving) return false;
		const text = file.text?.includes("\r\n") ? draft.replace(/\n/g, "\r\n") : draft;
		setSaving(true);
		setSaveError(undefined);
		try {
			const result = await store.writeFile(workspaceId, path, text, force ? undefined : file.modifiedAt);
			setFile({ ...file, text, size: result.size, modifiedAt: result.modifiedAt });
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
								stopEditing();
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
				{isMarkdown && rendered ? (
					<div className="file-viewer-markdown">
						<MarkdownFiles
							workspaceId={workspaceId}
							basePath={path.replace(/\\/g, "/").split("/").slice(0, -1).join("/")}
						>
							<Markdown text={file.text ?? ""} />
						</MarkdownFiles>
					</div>
				) : (
					<TextView file={file} />
				)}
			</>
		);
	}

	return (
		<Modal title={dirty ? `${name} •` : name} onClose={requestClose} wide className="file-viewer">
			<div className="file-viewer-toolbar">
				<span className="file-viewer-meta" title={path}>
					<span className="file-viewer-path">{path}</span>
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
							打开所在文件夹
						</button>
					) : null}
					{editing ? (
						<>
							<span className="file-viewer-hint">{dirty ? "未保存" : "已保存"} · Ctrl/⌘+S 保存</span>
							<button
								type="button"
								className="ghost small"
								disabled={saving}
								onClick={() => {
									if (dirty) setDraft(original);
									else stopEditing();
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
							{isMarkdown ? (
								<span className="segmented" role="tablist" aria-label="显示方式">
									<button
										type="button"
										className={rendered ? "active" : ""}
										role="tab"
										aria-selected={rendered}
										onClick={() => setRendered(true)}
									>
										预览
									</button>
									<button
										type="button"
										className={rendered ? "" : "active"}
										role="tab"
										aria-selected={!rendered}
										onClick={() => setRendered(false)}
									>
										源码
									</button>
								</span>
							) : null}
							{editable ? (
								<button type="button" className="ghost small" title="编辑文件" onClick={startEditing}>
									<IconPencil size={13} />
									编辑
								</button>
							) : null}
							{file?.kind === "text" && file.text ? <CopyButton text={file.text} label="复制内容" /> : null}
							<CopyButton text={path} label="复制路径" iconOnly />
							{onInsert ? (
								<button
									type="button"
									className="ghost icon"
									title="插入路径到输入框"
									onClick={() => {
										onInsert();
										requestClose();
									}}
								>
									<IconMessagePlus size={14} />
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
		</Modal>
	);
}

/** The preview dialog opened from the file panel or a composer file chip. */
export function FilePreview() {
	const store = useStore();
	const preview = useAppState((s) => s.filePreview);
	const known = useAppState((s) => !!preview && s.workspaces.some((w) => w.id === preview.workspaceId));
	if (!preview || !known) return null;
	const { workspaceId, path, composerKey, fromMarkdown } = preview;
	return (
		<FileViewer
			key={`${workspaceId}:${path}:${fromMarkdown ?? false}`}
			workspaceId={workspaceId}
			path={path}
			fromMarkdown={fromMarkdown}
			onClose={() => store.closeFilePreview()}
			onInsert={composerKey ? () => store.insertFileIntoComposer(composerKey, path) : undefined}
		/>
	);
}

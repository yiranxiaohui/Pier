import type { WorkspaceInfo } from "@pier/protocol";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
	type Breadcrumb,
	type FilesLocation,
	isWorkspaceRoot,
	locationForPath,
	resolveTypedPath,
	typedPathNeedsHome,
	WORKSPACE_ROOT,
} from "../lib/files-location.ts";
import { IconArrowUp, IconChevronRight, IconHome, IconPencil } from "./Icons.tsx";

export const NEEDS_BROWSE_UPDATE = "请更新文件所在电脑的 Pier 以浏览工作区以外的文件夹";

/** The path bar: up, back to the workspace root, and the shown directory as clickable parts or text. */
export function FilesPathBar({
	workspace,
	location,
	crumbs,
	canBrowseHost,
	disabled,
	onUp,
	upTitle,
	navigate,
	home,
}: {
	workspace: WorkspaceInfo;
	location: FilesLocation;
	crumbs: Breadcrumb[];
	canBrowseHost: boolean;
	disabled: boolean;
	onUp: (() => void) | undefined;
	upTitle: string;
	/** Show `location`, selecting its entry `select` (the folder the panel came from). */
	navigate: (location: FilesLocation, select?: string) => void;
	/** The home directory of the workspace's computer, for `~`; rejects with a readable message. */
	home: () => Promise<string>;
}) {
	const [editing, setEditing] = useState(false);
	const [text, setText] = useState("");
	const [error, setError] = useState<string>();
	const [busy, setBusy] = useState(false);
	const scroller = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const current = crumbs.at(-1)?.path ?? workspace.path;
	const atRoot = isWorkspaceRoot(location);

	// Long paths keep their end, the shown directory, in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll whenever the parts change.
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element) element.scrollLeft = element.scrollWidth;
	}, [crumbs, editing]);
	useEffect(() => {
		if (!editing) return;
		input.current?.focus();
		input.current?.select();
	}, [editing]);

	const startEditing = () => {
		if (disabled) return;
		setText(current);
		setError(undefined);
		setEditing(true);
	};
	const stopEditing = () => {
		setEditing(false);
		setError(undefined);
		setBusy(false);
	};
	const submit = async () => {
		if (busy) return;
		const value = text.trim();
		if (!value) {
			stopEditing();
			navigate(WORKSPACE_ROOT);
			return;
		}
		let homeDirectory: string | undefined;
		if (typedPathNeedsHome(value)) {
			if (!canBrowseHost) {
				setError(NEEDS_BROWSE_UPDATE);
				return;
			}
			setBusy(true);
			try {
				homeDirectory = await home();
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
				setBusy(false);
				return;
			}
			setBusy(false);
		}
		const path = resolveTypedPath(value, current, homeDirectory);
		if (!path) {
			setError("请输入绝对路径，或相对当前文件夹的路径");
			return;
		}
		const next = locationForPath(workspace.path, path);
		if (next.kind === "host" && !canBrowseHost) {
			setError(NEEDS_BROWSE_UPDATE);
			return;
		}
		stopEditing();
		navigate(next);
	};

	return (
		<div className="files-path">
			<div className="files-path-bar">
				<button
					type="button"
					className="ghost icon"
					title={upTitle}
					aria-label="上一级"
					disabled={!onUp || disabled}
					onClick={onUp}
				>
					<IconArrowUp size={14} />
				</button>
				<button
					type="button"
					className="ghost icon"
					title={atRoot ? "已在工作区根目录" : `回到工作区根目录（${workspace.name}）`}
					aria-label="回到工作区根目录"
					disabled={atRoot || disabled}
					onClick={() => navigate(WORKSPACE_ROOT)}
				>
					<IconHome size={14} />
				</button>
				{editing ? (
					<input
						ref={input}
						className={`files-path-input${error ? " invalid" : ""}`}
						aria-label="文件夹路径"
						aria-invalid={Boolean(error)}
						value={text}
						spellCheck={false}
						autoComplete="off"
						disabled={busy}
						placeholder="输入路径，回车前往；留空回到工作区"
						onChange={(event) => {
							setText(event.target.value);
							setError(undefined);
						}}
						onKeyDown={(event) => {
							if (event.nativeEvent.isComposing) return;
							if (event.key === "Enter") {
								event.preventDefault();
								void submit();
							} else if (event.key === "Escape") {
								event.preventDefault();
								event.stopPropagation();
								stopEditing();
							}
						}}
						onBlur={() => {
							if (!busy) stopEditing();
						}}
					/>
				) : (
					// biome-ignore lint/a11y/noStaticElementInteractions: the parts are buttons; a click beside them edits the path, which the pencil button also does.
					// biome-ignore lint/a11y/useKeyWithClickEvents: the pencil button edits the path from the keyboard.
					<div
						ref={scroller}
						className="files-crumbs"
						title={`${current}\n单击空白处输入路径`}
						onClick={(event) => {
							if (!(event.target as Element).closest("button")) startEditing();
						}}
					>
						{crumbs.map((crumb, index) => {
							const last = index === crumbs.length - 1;
							const blocked = crumb.location.kind === "host" && !canBrowseHost;
							return (
								<span key={crumb.path} className="files-crumb-part">
									{index ? <IconChevronRight size={11} className="files-crumb-sep" /> : null}
									<button
										type="button"
										className={`files-crumb${last ? " current" : ""}${crumb.workspaceRoot ? " workspace-root" : ""}`}
										title={blocked ? `${crumb.path}（${NEEDS_BROWSE_UPDATE}）` : crumb.path}
										aria-current={last ? "location" : undefined}
										disabled={disabled || blocked}
										onClick={() => {
											if (last) startEditing();
											else navigate(crumb.location, crumbs[index + 1]?.label);
										}}
									>
										{crumb.label}
									</button>
								</span>
							);
						})}
					</div>
				)}
				<button
					type="button"
					className="ghost icon"
					title="输入路径"
					aria-label="输入路径"
					disabled={disabled || editing}
					onMouseDown={(event) => event.preventDefault()}
					onClick={startEditing}
				>
					<IconPencil size={13} />
				</button>
			</div>
			{error ? (
				<p className="files-path-error" role="alert">
					{error}
				</p>
			) : null}
		</div>
	);
}

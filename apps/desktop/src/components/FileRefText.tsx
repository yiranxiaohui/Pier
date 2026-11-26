import { fileRefLabel, splitFileRefs } from "@pier/chat-state";
import { Fragment, useMemo } from "react";
import { useStore } from "../lib/store.tsx";
import { IconFile, IconFolder } from "./Icons.tsx";
import { useMarkdownFiles } from "./Markdown.tsx";

/** Paths outside the workspace are previewed with the Markdown link rules (which can ask for access). */
const OUTSIDE = /^(?:\/|~\/|\.\.\/|[a-zA-Z]:[\\/])/;

/** A file picked into a sent message, as the composer's chip showed it; a file opens in the preview. */
function FileRefChip({ path, workspaceId }: { path: string; workspaceId: string | undefined }) {
	const store = useStore();
	const directory = /[\\/]$/.test(path);
	const content = (
		<>
			{directory ? <IconFolder size={13} /> : <IconFile size={13} />}
			<span className="file-ref-chip-name">{fileRefLabel(path)}</span>
		</>
	);
	if (directory || !workspaceId) {
		return (
			<span className="file-ref-chip" title={path}>
				{content}
			</span>
		);
	}
	return (
		<button
			type="button"
			className="file-ref-chip"
			title={`${path}（点击查看）`}
			onClick={() =>
				OUTSIDE.test(path) ? store.openMarkdownFilePreview(workspaceId, path) : store.openFilePreview(workspaceId, path)
			}
		>
			{content}
		</button>
	);
}

/**
 * Message text with the files picked into it (inline-code paths, see `@pier/chat-state`'s
 * `file-refs.ts`) shown as chips. Files open on the conversation's host: `workspaceId`, else the
 * surrounding `MarkdownFiles`.
 */
export function FileRefText({ text, workspaceId }: { text: string; workspaceId?: string | undefined }) {
	const files = useMarkdownFiles();
	const parts = useMemo(() => splitFileRefs(text), [text]);
	const workspace = workspaceId ?? files?.workspaceId;
	return (
		<>
			{parts.map((part, i) =>
				part.type === "text" ? (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional parts of one message.
					<Fragment key={i}>{part.text}</Fragment>
				) : (
					// biome-ignore lint/suspicious/noArrayIndexKey: positional parts of one message.
					<FileRefChip key={i} path={part.path} workspaceId={workspace} />
				),
			)}
		</>
	);
}

import {
	type ComponentProps,
	createContext,
	memo,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { filePreviewError, markdownFilePath, markdownUrlTransform } from "../lib/markdown-files.ts";
import { isSensitiveFile } from "../lib/sensitive-files.ts";
import { useStore } from "../lib/store.tsx";
import { IconCheck, IconCopy } from "./Icons.tsx";

const FileContext = createContext<{ workspaceId: string; basePath?: string } | undefined>(undefined);

/** Resolve references against this conversation's host, even when another computer is selected. */
export function MarkdownFiles({
	workspaceId,
	basePath,
	children,
}: {
	workspaceId: string;
	basePath?: string;
	children: ReactNode;
}) {
	const value = useMemo(() => ({ workspaceId, basePath }), [workspaceId, basePath]);
	return <FileContext.Provider value={value}>{children}</FileContext.Provider>;
}

function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (node && typeof node === "object" && "props" in node) {
		return textOf((node as { props: { children?: ReactNode } }).props.children);
	}
	return "";
}

export function CopyButton({ text, label = "复制", iconOnly }: { text: string; label?: string; iconOnly?: boolean }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className={`copy-button${iconOnly ? " icon-only" : ""}${copied ? " copied" : ""}`}
			title={iconOnly ? label : undefined}
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				});
			}}
		>
			{copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
			{iconOnly ? null : <span>{copied ? "已复制" : label}</span>}
		</button>
	);
}

function languageOf(node: ReactNode): string | undefined {
	const child = Array.isArray(node) ? node[0] : node;
	if (child && typeof child === "object" && "props" in child) {
		const className = (child as { props: { className?: unknown } }).props.className;
		const match = typeof className === "string" ? /language-([\w+#-]+)/.exec(className) : null;
		return match?.[1];
	}
	return undefined;
}

function Pre(props: ComponentProps<"pre">) {
	const text = textOf(props.children);
	const language = languageOf(props.children);
	return (
		<div className="code-block">
			<div className="code-block-header">
				<span className="code-lang">{language ?? "code"}</span>
				<CopyButton text={text.replace(/\n$/, "")} />
			</div>
			<pre {...props} />
		</div>
	);
}

function Link({ href, children }: ComponentProps<"a">) {
	const store = useStore();
	const files = useContext(FileContext);
	const path = markdownFilePath(href, files?.basePath);
	return (
		<a
			href={href}
			onClick={(event) => {
				if (href?.startsWith("#")) return;
				event.preventDefault();
				if (files && path) store.openMarkdownFilePreview(files.workspaceId, path);
				else if (href && /^https?:\/\//i.test(href)) void store.openWorkspaceUrl(href, files?.workspaceId);
			}}
		>
			{children}
		</a>
	);
}

function Image({ src, alt, title }: ComponentProps<"img">) {
	const store = useStore();
	const files = useContext(FileContext);
	const path = markdownFilePath(typeof src === "string" ? src : undefined, files?.basePath);
	const workspaceId = files?.workspaceId;
	const [image, setImage] = useState<{ src?: string; error?: string }>();
	const [failed, setFailed] = useState(false);
	const sensitive = !!path && isSensitiveFile(path);
	useEffect(() => {
		let active = true;
		setImage(undefined);
		setFailed(false);
		if (workspaceId && path && !sensitive) {
			void store.previewFile(workspaceId, path).then(
				(file) => {
					if (!active) return;
					if (file.kind !== "image") setImage({ error: "该文件不是可预览的图片" });
					else if (file.tooLarge || !file.data) setImage({ error: "图片太大，无法预览（上限 8 MiB）" });
					else setImage({ src: `data:${file.mimeType};base64,${file.data}` });
				},
				(error: unknown) => active && setImage({ error: filePreviewError(error) }),
			);
		}
		return () => {
			active = false;
		};
	}, [store, workspaceId, path, sensitive]);

	const imageSrc = path ? image?.src : src;
	const error = failed ? "图片无法显示" : image?.error;
	const content =
		imageSrc && !error ? (
			<img src={imageSrc} alt={alt ?? "图片"} title={title} loading="lazy" onError={() => setFailed(true)} />
		) : (
			<span className="markdown-image-placeholder">
				{alt ? <strong>{alt}</strong> : null}
				<span>{error ?? (sensitive ? "点击预览文件" : path && workspaceId ? "正在读取图片…" : "无法读取图片")}</span>
			</span>
		);
	return path && workspaceId ? (
		<button
			type="button"
			className="markdown-image"
			title={error ?? "查看图片"}
			onClick={() => store.openMarkdownFilePreview(workspaceId, path)}
		>
			{content}
		</button>
	) : (
		<span className="markdown-image">{content}</span>
	);
}

const components = { pre: Pre, a: Link, img: Image };
const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as ComponentProps<
	typeof ReactMarkdown
>["rehypePlugins"];

export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="markdown">
			<ReactMarkdown
				remarkPlugins={remarkPlugins}
				rehypePlugins={rehypePlugins}
				components={components}
				urlTransform={markdownUrlTransform}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
});

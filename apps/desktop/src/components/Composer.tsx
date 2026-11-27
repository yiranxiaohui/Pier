import {
	appendDictation,
	type ChatController,
	type ChatState,
	resolveSlash,
	runBuiltin,
	type SlashActions,
} from "@pier/chat-state";
import type { WorkspaceInfo } from "@pier/protocol";
import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef, useState } from "react";
import { promptWithContexts } from "../lib/browser-context.ts";
import { draftToMessage, draftToPrompt } from "../lib/composer-text.ts";
import { attachToDraft, type Draft, restoreToDraft, useStore } from "../lib/store.tsx";
import { useVoiceInput } from "../lib/use-voice-input.ts";
import { ComposerInput, type ComposerInputHandle } from "./ComposerInput.tsx";
import { IconArrowUp, IconImage, IconMousePointer, IconScan, IconStop, IconX } from "./Icons.tsx";
import { SessionModelPicker } from "./ModelPicker.tsx";
import { PolicyPicker } from "./SessionControls.tsx";
import { SlashMenu, type SlashMenuEntry, useSlashMenu } from "./SlashMenu.tsx";
import { VoiceControls } from "./VoiceControls.tsx";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Read the image files among `files` as attachments, warning about oversized ones. */
export async function readImages(files: Iterable<File>, warn: (message: string) => void): Promise<Draft["images"]> {
	const images: Draft["images"] = [];
	for (const file of files) {
		if (!file.type.startsWith("image/")) continue;
		if (file.size > MAX_IMAGE_BYTES) {
			warn(`图片 ${file.name} 超过 20 MB，已忽略`);
			continue;
		}
		images.push(await readImage(file));
	}
	return images;
}

function readImage(file: File): Promise<Draft["images"][number]> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const url = String(reader.result);
			resolve({ data: url.slice(url.indexOf(",") + 1), mimeType: file.type, name: file.name || "图片" });
		};
		reader.onerror = () => reject(reader.error ?? new Error("读取图片失败"));
		reader.readAsDataURL(file);
	});
}

/**
 * Let the file panel insert file chips at the cursor of this composer, the workspace browser
 * attach what was picked on a page, and an edited message that could not be sent come back here.
 * `key` is the draft key (a session id, or the new-chat draft).
 */
export function useComposerInsert(
	key: string,
	input: RefObject<ComposerInputHandle | null>,
	setDraft: Dispatch<SetStateAction<Draft>>,
): void {
	const store = useStore();
	useEffect(
		() =>
			store.registerComposer(key, {
				insertFile: (path, directory) => input.current?.insertFile(path, directory),
				attach: (attachment) => {
					setDraft((draft) => attachToDraft(draft, attachment));
					input.current?.focus();
				},
				restore: (restored) => {
					setDraft((draft) => restoreToDraft(draft, restored));
					input.current?.focus();
				},
			}),
		[store, key, input, setDraft],
	);
}

/** The images and browser picks attached to a draft, each with a remove button. */
export function DraftAttachments({ draft, setDraft }: { draft: Draft; setDraft: Dispatch<SetStateAction<Draft>> }) {
	const contexts = draft.contexts ?? [];
	if (!draft.images.length && !contexts.length) return null;
	return (
		<div className="composer-images">
			{contexts.map((context) => (
				<div key={context.id} className="composer-context" title={context.text}>
					{context.kind === "element" ? <IconMousePointer size={13} /> : <IconScan size={13} />}
					<span className="composer-context-label">{context.label}</span>
					{context.note ? <span className="composer-context-note">{context.note}</span> : null}
					<button
						type="button"
						title="移除"
						aria-label={`移除 ${context.label}`}
						onClick={() => setDraft((d) => ({ ...d, contexts: (d.contexts ?? []).filter((c) => c.id !== context.id) }))}
					>
						<IconX size={11} />
					</button>
				</div>
			))}
			{draft.images.map((image, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: positional attachments.
				<div key={i} className="composer-image">
					<img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
					<button
						type="button"
						title="移除"
						onClick={() => setDraft((d) => ({ ...d, images: d.images.filter((_, j) => j !== i) }))}
					>
						<IconX size={11} />
					</button>
				</div>
			))}
		</div>
	);
}

export function Composer({
	chat,
	controller,
	workspace,
}: {
	chat: ChatState;
	controller: ChatController;
	workspace?: WorkspaceInfo;
}) {
	const store = useStore();
	const sessionId = chat.sessionId;
	const [draft, setDraft] = useState<Draft>(() => store.draft(sessionId));
	const input = useRef<ComposerInputHandle>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const [sending, setSending] = useState(false);
	const [dragging, setDragging] = useState(false);
	const voice = useVoiceInput(
		sessionId,
		(text) => setDraft((draft) => ({ ...draft, text: appendDictation(draft.text, text) })),
		sending || !!chat.closed,
	);

	// The parent remounts the composer per session (`key={sessionId}`), so the draft state
	// always belongs to `sessionId`.
	useEffect(() => {
		input.current?.focus();
	}, []);

	useEffect(() => {
		store.saveDraft(sessionId, draft);
	}, [store, sessionId, draft]);

	useComposerInsert(sessionId, input, setDraft);

	// An extension asked to prefill the editor.
	const editorNonce = chat.editorText?.nonce;
	// biome-ignore lint/correctness/useExhaustiveDependencies: react to new requests only.
	useEffect(() => {
		if (chat.editorText) {
			setDraft((d) => ({ ...d, text: chat.editorText?.text ?? "" }));
			input.current?.focus();
		}
	}, [editorNonce]);

	const running = chat.runState === "streaming" || chat.runState === "retrying" || chat.runState === "compacting";
	const closed = !!chat.closed;
	const prompt = draftToPrompt(draft.text);
	const attached = draft.images.length > 0 || (draft.contexts?.length ?? 0) > 0;
	const canSend = !voice.busy && !closed && chat.loaded && !sending && (prompt.trim().length > 0 || attached);
	const menu = useSlashMenu(controller, prompt);
	// The predicted next prompt (1.76) shows in the empty composer; Tab takes it.
	const suggestion =
		!running && !closed && !sending && !voice.busy && draft.text === "" && !attached ? chat.suggestion : undefined;

	const actions: SlashActions = {
		newSession: () => {
			store.setNewChatRuntime(controller.workspaceId, chat.session?.runtime ?? "pi");
			store.startNewChat(controller.workspaceId);
			return true;
		},
		fork: (entryId) => (chat.session ? store.forkSession(chat.session, entryId) : false),
		notify: (level, message) => store.toast(level, message),
	};

	async function send(mode: "auto" | "steer" | "followUp", override?: string) {
		const text = draftToPrompt(override ?? draft.text).trim();
		const contexts = draft.contexts ?? [];
		if (voice.busy || closed || !chat.loaded || sending || (!text && !draft.images.length && !contexts.length)) return;
		const images = draft.images.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType }));
		const previous = { ...draft, text: override ?? draft.text };
		let cleared: Draft = { text: "", images: [] };

		let resolution = resolveSlash(text, menu.list.commands, menu.list.known, controller.chat.session?.runtime);
		if (resolution.kind === "unknown" || (resolution.kind === "host" && !menu.list.known)) {
			// The list may be stale (or still loading) right after typing.
			const fresh = await controller.loadCommands();
			resolution = resolveSlash(text, fresh.commands, fresh.known, controller.chat.session?.runtime);
		}
		if (resolution.kind === "unknown") {
			store.toast("error", `未知命令 /${resolution.name}，输入 / 查看可用的命令`);
			return;
		}

		setSending(true);
		if (resolution.kind === "builtin") {
			// Built-ins keep attached images; clear the text first because /new and /fork switch sessions.
			const kept = { ...previous, text: "" };
			setDraft(kept);
			store.saveDraft(sessionId, kept);
			const result = await runBuiltin(controller, resolution.name, resolution.args, actions);
			setSending(false);
			if (result.kind === "failed") setDraft(previous);
			else if (result.kind === "complete") setDraft({ ...previous, text: result.text });
			input.current?.focus();
			return;
		}

		// Browser picks go with messages; a command leaves them in the draft for the next one.
		if (resolution.kind === "host" && contexts.length) cleared = { ...cleared, contexts };
		setDraft(cleared);
		// A message carries picked files as inline-code paths, which the transcript shows as chips again;
		// a command gets plain paths.
		const result =
			resolution.kind === "host"
				? await controller.sendCommand(text, images, mode)
				: await controller.send(
						promptWithContexts(draftToMessage(override ?? draft.text).trim(), contexts),
						images,
						mode,
					);
		setSending(false);
		if (result === undefined) setDraft(previous);
		input.current?.focus();
	}

	// The session was just created from the new-chat screen: send its first message once loaded.
	// biome-ignore lint/correctness/useExhaustiveDependencies: fire once, when the session loads.
	useEffect(() => {
		if (chat.loaded && !closed && store.takeAutoSend(sessionId)) void send("auto");
	}, [chat.loaded]);

	function pick(entry: SlashMenuEntry, tab = false) {
		const next = entry.pick(tab);
		if (next.run) void send(running ? "steer" : "auto", next.text);
		else setDraft((d) => ({ ...d, text: next.text }));
		input.current?.focus();
	}

	async function addFiles(files: Iterable<File>) {
		const images = await readImages(files, (m) => store.toast("warning", m));
		if (images.length) setDraft((d) => ({ ...d, images: [...d.images, ...images].slice(0, 16) }));
	}

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drop target for pasted/dragged images.
		<div
			className={`composer${dragging ? " dragging" : ""}`}
			onDragOver={(e) => {
				if ([...e.dataTransfer.items].some((i) => i.type.startsWith("image/"))) {
					e.preventDefault();
					setDragging(true);
				}
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={(e) => {
				e.preventDefault();
				setDragging(false);
				void addFiles(e.dataTransfer.files);
			}}
		>
			<DraftAttachments draft={draft} setDraft={setDraft} />
			<SlashMenu menu={menu} onPick={(entry) => pick(entry)} />
			<ComposerInput
				ref={input}
				value={draft.text}
				disabled={closed}
				suggestion={suggestion}
				placeholder={
					suggestion ??
					(closed
						? "会话已关闭"
						: running
							? "补充指示以引导当前任务，Esc 停止…"
							: "描述你的任务…（Enter 发送，Shift+Enter 换行，/ 使用命令）")
				}
				onChange={(text) => setDraft((d) => ({ ...d, text }))}
				onOpenFile={(path) => store.openFilePreview(controller.workspaceId, path)}
				onPaste={(e) => {
					const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
					if (files.length) {
						e.preventDefault();
						void addFiles(files);
					}
				}}
				onKeyDown={(e) => {
					if (e.nativeEvent.isComposing || e.keyCode === 229) return;
					if (suggestion && e.key === "Tab" && !e.shiftKey && !e.altKey && !e.metaKey && !e.ctrlKey) {
						e.preventDefault();
						setDraft((d) => ({ ...d, text: suggestion }));
						return;
					}
					if (suggestion && e.key === "Escape") {
						e.preventDefault();
						controller.dismissSuggestion();
						return;
					}
					if (menu.open) {
						const entry = menu.entries[menu.active];
						if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							if (menu.entries.length) {
								e.preventDefault();
								menu.move(e.key === "ArrowDown" ? 1 : -1);
							}
							return;
						}
						if (e.key === "Escape") {
							e.preventDefault();
							menu.dismiss();
							return;
						}
						if (entry && (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.altKey))) {
							e.preventDefault();
							pick(entry, e.key === "Tab");
							return;
						}
					}
					if (e.key === "Escape" && running) {
						e.preventDefault();
						void controller.abort();
					} else if (e.key === "Enter" && !e.shiftKey) {
						e.preventDefault();
						void send(running ? (e.altKey ? "followUp" : "steer") : "auto");
					}
				}}
			/>
			<div className="composer-toolbar">
				<div className="composer-toolbar-left">
					<VoiceControls voice={voice} disabled={sending || !!chat.closed} />
					<button
						type="button"
						className="ghost icon composer-attach"
						title="添加图片（也可以粘贴或拖入）"
						disabled={closed}
						onClick={() => fileInput.current?.click()}
					>
						<IconImage size={16} />
					</button>
					<input
						ref={fileInput}
						type="file"
						accept="image/*"
						multiple
						hidden
						onChange={(e) => {
							const files = [...(e.target.files ?? [])];
							e.target.value = "";
							void addFiles(files);
						}}
					/>
					{workspace ? <PolicyPicker workspace={workspace} /> : null}
				</div>
				<div className="composer-actions">
					<SessionModelPicker chat={chat} controller={controller} />
					{suggestion ? <span className="composer-hint">Tab 填入建议 · Esc 忽略</span> : null}
					{running ? (
						<>
							<span className="composer-hint">Enter 引导 · Alt+Enter 排队</span>
							<button
								type="button"
								className="subtle"
								disabled={!canSend}
								onClick={() => void send("followUp")}
								title="Alt+Enter"
							>
								排队
							</button>
							<button
								type="button"
								className="subtle accent"
								disabled={!canSend}
								onClick={() => void send("steer")}
								title="Enter"
							>
								引导
							</button>
							<button
								type="button"
								className="round-button stop"
								onClick={() => void controller.abort()}
								title="停止（Esc）"
							>
								<IconStop size={14} />
							</button>
						</>
					) : (
						<button
							type="button"
							className="round-button send"
							disabled={!canSend}
							onClick={() => void send("auto")}
							title="发送（Enter）"
						>
							<IconArrowUp size={17} />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

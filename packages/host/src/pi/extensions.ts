import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	CONFIG_DIR_NAME,
	DefaultPackageManager,
	type PackageSource,
	type ProgressEvent,
	type ResolvedResource,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	type ExtensionListResult,
	type ExtensionPackageInfo,
	type ExtensionResourceInfo,
	type ExtensionResourceType,
	type ExtensionScope,
	type ExtensionUpdateInfo,
	PierProtocolError,
} from "@pier/protocol";

const RESOURCE_TYPES: readonly ExtensionResourceType[] = ["extensions", "skills", "prompts", "themes"];

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;

export interface ExtensionProgress {
	action: ProgressEvent["action"];
	/**
	 * pi's `result` (an outcome such as one changed package after an update, `npm:foo 1.2.0 -> 1.3.0`)
	 * is reported as `progress`: the protocol has no such phase, and clients show only its message.
	 */
	phase: Exclude<ProgressEvent["type"], "result">;
	source: string;
	message?: string;
}

export interface ExtensionManagerOptions {
	agentDir: string;
	/** Deleted resource files and directories go here. */
	trashDir: string;
	onProgress?: (event: ExtensionProgress) => void;
	log?: (message: string) => void;
}

/** The workspace an operation looks at; without one only user settings apply. */
export interface ExtensionTarget {
	/** Absolute workspace directory (the pi cwd). */
	path: string;
	id: string;
}

interface Context {
	settings: SettingsManager;
	packages: DefaultPackageManager;
	cwd: string;
	target?: ExtensionTarget;
}

function isOverride(entry: string): boolean {
	return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-");
}

function patternTarget(entry: string): string {
	return isOverride(entry) ? entry.slice(1) : entry;
}

/**
 * Compare settings patterns the way pi matches them: pi writes patterns with the platform
 * separator but converts them to `/` before matching, so on Windows `extensions\a.js` and
 * `extensions/a.js` name the same resource.
 */
function samePattern(a: string, b: string): boolean {
	return a.split(sep).join("/") === b.split(sep).join("/");
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
	return path;
}

function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function samePath(a: string, b: string): boolean {
	return resolve(a) === resolve(b) || canonical(a) === canonical(b);
}

function isInside(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Mirrors pi's source parsing: `npm:`, remote git prefixes/URLs, everything else is a path. */
export function sourceKind(source: string): ExtensionPackageInfo["kind"] {
	const s = source.trim();
	if (s.startsWith("npm:")) return "npm";
	if (/^(git:|github:|https?:|ssh:)/.test(s)) return "git";
	return "local";
}

function packageSourceString(pkg: PackageSource): string {
	return typeof pkg === "string" ? pkg : pkg.source;
}

function displayName(type: ExtensionResourceType, path: string): string {
	const file = basename(path);
	const parent = basename(dirname(path));
	if (type === "extensions" && parent !== "extensions") return `${parent}/${file}`;
	if (type === "skills" && file === "SKILL.md") return parent;
	return file;
}

function readPackageJson(dir: string): { name?: string; version?: string; description?: string } {
	try {
		if (!statSync(dir).isDirectory()) return {};
		const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
		const pick = (key: string) => (typeof json[key] === "string" && json[key] ? { [key]: json[key] as string } : {});
		return { ...pick("name"), ...pick("version"), ...pick("description") };
	} catch {
		return {};
	}
}

/** Explain failures to run npm / git, which the desktop app may not find on its PATH. */
function explain(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	const missing = /\bspawn (\S+) ENOENT\b/.exec(message) ?? /ENOENT.*\b(npm|git)\b/.exec(message);
	if (missing) {
		const command = missing[1] ?? "npm";
		return new PierProtocolError(
			"BAD_REQUEST",
			`Could not run \`${command}\`: it is not installed or not on the PATH of Pier Host. ` +
				(command.includes("git")
					? "Install git and restart Pier."
					: 'Install Node.js (npm) and restart Pier, or pick npm, pnpm or bun under Settings → Agent 配置 → pi → npm 命令 ("npmCommand" in pi settings.json).'),
		);
	}
	return error instanceof Error ? error : new Error(message);
}

/**
 * Manages pi packages and resources (extensions, skills, prompt templates, themes) through
 * pi's own package manager and settings, so the result is the same as `pi install`,
 * `pi remove`, `pi update --extensions`, and `pi config`.
 *
 * Settings are always file backed: user settings in `<agentDir>/settings.json`, project
 * settings in `<workspace>/.pi/settings.json` (workspaces added to Pier are trusted).
 */
export class ExtensionManager {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly options: ExtensionManagerOptions) {}

	private context(target?: ExtensionTarget): Context {
		const cwd = target?.path ?? this.options.agentDir;
		const settings = SettingsManager.create(cwd, this.options.agentDir, { projectTrusted: target !== undefined });
		const packages = new DefaultPackageManager({ cwd, agentDir: this.options.agentDir, settingsManager: settings });
		packages.setProgressCallback((event) =>
			this.options.onProgress?.({
				action: event.action,
				phase: event.type === "result" ? "progress" : event.type,
				source: event.source,
				...(event.message ? { message: event.message } : {}),
			}),
		);
		return { settings, packages, cwd, ...(target ? { target } : {}) };
	}

	/** Run mutations one at a time: pi's package operations are not safe to interleave. */
	private exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = this.queue.then(fn, fn);
		this.queue = run.catch(() => undefined);
		return run;
	}

	private baseDir(ctx: Context, scope: ExtensionScope): string {
		return scope === "project" ? join(ctx.cwd, CONFIG_DIR_NAME) : this.options.agentDir;
	}

	private scopeSettings(ctx: Context, scope: ExtensionScope): Settings {
		return scope === "project" ? ctx.settings.getProjectSettings() : ctx.settings.getGlobalSettings();
	}

	private requireScope(ctx: Context, scope: ExtensionScope): void {
		if (scope === "project" && !ctx.target) {
			throw new PierProtocolError("BAD_REQUEST", "Project scope needs a workspaceId");
		}
	}

	private async save(ctx: Context): Promise<void> {
		await ctx.settings.flush();
		const errors = ctx.settings.drainErrors();
		if (errors.length) {
			const first = errors[0];
			throw new PierProtocolError(
				"INTERNAL",
				`Could not update ${first?.scope === "project" ? "project" : "user"} settings${first?.path ? ` (${first.path})` : ""}: ${first?.error.message ?? "unknown error"}`,
			);
		}
	}

	private assertSettingsReadable(ctx: Context): void {
		const errors = ctx.settings.drainErrors();
		const first = errors[0];
		if (first) {
			throw new PierProtocolError(
				"CONFLICT",
				`pi settings${first.path ? ` ${first.path}` : ""} could not be read (${first.error.message}); fix the file first`,
			);
		}
	}

	// ---- queries -----------------------------------------------------------------------

	private packageInfo(ctx: Context): ExtensionPackageInfo[] {
		return ctx.packages.listConfiguredPackages().map((pkg) => {
			const kind = sourceKind(pkg.source);
			const meta = pkg.installedPath ? readPackageJson(pkg.installedPath) : {};
			return {
				source: pkg.source,
				scope: pkg.scope,
				kind,
				filtered: pkg.filtered,
				...(pkg.installedPath ? { installedPath: pkg.installedPath } : {}),
				...meta,
			};
		});
	}

	private resourceInfo(ctx: Context, type: ExtensionResourceType, resource: ResolvedResource): ExtensionResourceInfo {
		const scope: ExtensionScope = resource.metadata.scope === "project" ? "project" : "user";
		const info: ExtensionResourceInfo = {
			type,
			path: resource.path,
			name: displayName(type, resource.path),
			enabled: resource.enabled,
			scope,
			origin: resource.metadata.origin,
			source: resource.metadata.source,
			deletable: false,
		};
		info.deletable = this.deleteTarget(ctx, info, resource) !== undefined;
		return info;
	}

	private async resolveAll(ctx: Context): Promise<Array<{ info: ExtensionResourceInfo; raw: ResolvedResource }>> {
		// Listing never installs: missing npm / git packages are skipped (they show as not installed).
		const resolved = await ctx.packages.resolve(async () => "skip");
		const all: Array<{ info: ExtensionResourceInfo; raw: ResolvedResource }> = [];
		for (const type of RESOURCE_TYPES) {
			for (const raw of resolved[type]) {
				if (raw.metadata.scope === "temporary") continue;
				all.push({ info: this.resourceInfo(ctx, type, raw), raw });
			}
		}
		return all;
	}

	async list(target?: ExtensionTarget): Promise<ExtensionListResult> {
		const ctx = this.context(target);
		const resources = await this.resolveAll(ctx);
		return {
			agentDir: this.options.agentDir,
			...(target ? { workspaceId: target.id } : {}),
			packages: this.packageInfo(ctx),
			resources: resources.map((r) => r.info),
		};
	}

	async checkUpdates(target?: ExtensionTarget): Promise<ExtensionUpdateInfo[]> {
		const ctx = this.context(target);
		try {
			const updates = await ctx.packages.checkForAvailableUpdates();
			return updates.map((u) => ({ source: u.source, name: u.displayName, kind: u.type, scope: u.scope }));
		} catch (error) {
			throw explain(error);
		}
	}

	// ---- packages ----------------------------------------------------------------------

	/** Validate a source and turn `~` / local paths into absolute paths. */
	private normalizeSource(source: string): string {
		const trimmed = source.trim();
		if (sourceKind(trimmed) !== "local") return trimmed;
		const path = expandHome(trimmed.startsWith("file:") ? trimmed.slice("file:".length) : trimmed);
		if (!isAbsolute(path)) {
			throw new PierProtocolError(
				"BAD_REQUEST",
				"Use npm:<package>, git:<host>/<repo>, a git URL, or an absolute path to a local extension or package",
			);
		}
		if (!existsSync(path)) throw new PierProtocolError("BAD_REQUEST", `Path does not exist: ${path}`);
		return resolve(path);
	}

	install(source: string, scope: ExtensionScope, target?: ExtensionTarget): Promise<ExtensionPackageInfo | undefined> {
		return this.exclusive(async () => {
			const normalized = this.normalizeSource(source);
			const ctx = this.context(scope === "project" ? target : undefined);
			this.requireScope(ctx, scope);
			this.assertSettingsReadable(ctx);
			const before = new Set(this.packageInfo(ctx).map((p) => `${p.scope}\n${p.source}`));
			try {
				await ctx.packages.installAndPersist(normalized, { local: scope === "project" });
			} catch (error) {
				throw explain(error);
			}
			await this.save(ctx);
			const after = this.packageInfo(ctx).filter((p) => p.scope === scope);
			return (
				after.find((p) => !before.has(`${p.scope}\n${p.source}`)) ??
				after.find((p) => p.source === normalized) ??
				after.find(
					(p) =>
						p.installedPath !== undefined &&
						sourceKind(normalized) === "local" &&
						samePath(p.installedPath, normalized),
				)
			);
		});
	}

	remove(source: string, scope: ExtensionScope, target?: ExtensionTarget): Promise<boolean> {
		return this.exclusive(async () => {
			const ctx = this.context(scope === "project" ? target : undefined);
			this.requireScope(ctx, scope);
			this.assertSettingsReadable(ctx);
			const configured = (this.scopeSettings(ctx, scope).packages ?? []).some(
				(pkg) => packageSourceString(pkg) === source,
			);
			if (!configured) return false;
			// pi resolves a relative path argument from the cwd, but settings store it relative to
			// the settings directory: pass local sources as absolute paths.
			const argument = sourceKind(source) === "local" ? resolve(this.baseDir(ctx, scope), expandHome(source)) : source;
			let removed: boolean;
			try {
				removed = await ctx.packages.removeAndPersist(argument, { local: scope === "project" });
			} catch (error) {
				throw explain(error);
			}
			await this.save(ctx);
			return removed;
		});
	}

	update(source: string | undefined, target?: ExtensionTarget): Promise<void> {
		return this.exclusive(async () => {
			const ctx = this.context(target);
			try {
				await ctx.packages.update(source);
			} catch (error) {
				if (error instanceof Error && /No matching package/i.test(error.message)) {
					throw new PierProtocolError("NOT_FOUND", error.message);
				}
				throw explain(error);
			}
		});
	}

	// ---- resources ---------------------------------------------------------------------

	private async requireResource(
		ctx: Context,
		type: ExtensionResourceType,
		path: string,
	): Promise<{ info: ExtensionResourceInfo; raw: ResolvedResource }> {
		const found = (await this.resolveAll(ctx)).find((r) => r.info.type === type && samePath(r.info.path, path));
		if (!found) throw new PierProtocolError("NOT_FOUND", `No ${type} resource at ${path}`);
		return found;
	}

	/** Enable or disable a resource in its own scope, as `pi config` does. */
	setEnabled(
		type: ExtensionResourceType,
		path: string,
		enabled: boolean,
		target?: ExtensionTarget,
	): Promise<ExtensionResourceInfo> {
		return this.exclusive(async () => {
			const ctx = this.context(target);
			this.assertSettingsReadable(ctx);
			const { info, raw } = await this.requireResource(ctx, type, path);
			if (info.enabled !== enabled) {
				if (info.origin === "top-level") this.toggleTopLevel(ctx, info, raw, enabled);
				else this.togglePackageResource(ctx, info, raw, enabled);
				await this.save(ctx);
			}
			const updated = (await this.resolveAll(ctx)).find((r) => r.info.type === type && samePath(r.info.path, path));
			return updated?.info ?? { ...info, enabled };
		});
	}

	private setTopLevelPaths(ctx: Context, scope: ExtensionScope, type: ExtensionResourceType, paths: string[]): void {
		const s = ctx.settings;
		if (scope === "project") {
			if (type === "extensions") s.setProjectExtensionPaths(paths);
			else if (type === "skills") s.setProjectSkillPaths(paths);
			else if (type === "prompts") s.setProjectPromptTemplatePaths(paths);
			else s.setProjectThemePaths(paths);
		} else if (type === "extensions") s.setExtensionPaths(paths);
		else if (type === "skills") s.setSkillPaths(paths);
		else if (type === "prompts") s.setPromptTemplatePaths(paths);
		else s.setThemePaths(paths);
	}

	private toggleTopLevel(ctx: Context, info: ExtensionResourceInfo, raw: ResolvedResource, enabled: boolean): void {
		const base = raw.metadata.baseDir ?? this.baseDir(ctx, info.scope);
		const pattern = relative(base, info.path);
		const current = (this.scopeSettings(ctx, info.scope)[info.type] ?? []) as string[];
		const updated = current.filter((entry) => !(isOverride(entry) && samePattern(patternTarget(entry), pattern)));
		updated.push(`${enabled ? "+" : "-"}${pattern}`);
		this.setTopLevelPaths(ctx, info.scope, info.type, updated);
	}

	private togglePackageResource(
		ctx: Context,
		info: ExtensionResourceInfo,
		raw: ResolvedResource,
		enabled: boolean,
	): void {
		const packages = [...(this.scopeSettings(ctx, info.scope).packages ?? [])];
		const index = packages.findIndex((pkg) => packageSourceString(pkg) === info.source);
		const found = packages[index];
		if (index === -1 || found === undefined) {
			throw new PierProtocolError("NOT_FOUND", `Package ${info.source} is not in the ${info.scope} settings`);
		}
		const pkg = typeof found === "string" ? { source: found } : { ...found };
		const pattern = relative(raw.metadata.baseDir ?? dirname(info.path), info.path);
		const current = pkg[info.type] ?? [];
		const updated = current.filter((entry) => !samePattern(patternTarget(entry), pattern));
		updated.push(`${enabled ? "+" : "-"}${pattern}`);
		pkg[info.type] = updated;
		packages[index] = pkg;
		if (info.scope === "project") ctx.settings.setProjectPackages(packages);
		else ctx.settings.setPackages(packages);
	}

	/**
	 * Auto-discovered resources move to trash; exact settings entries are unlinked.
	 * A declared skill owns its directory, including supporting scripts and assets.
	 */
	private deleteTarget(
		ctx: Context,
		info: ExtensionResourceInfo,
		raw: ResolvedResource,
	): { kind: "trash"; path: string } | { kind: "entry"; entry: string } | undefined {
		if (info.origin !== "top-level") return undefined;
		if (info.source === "auto") {
			const root = join(raw.metadata.baseDir ?? this.baseDir(ctx, info.scope), info.type);
			if (!isInside(root, info.path)) return undefined;
			let path = info.path;
			if (info.type === "extensions") {
				const parts = relative(root, info.path).split(sep);
				if (parts.length === 2 && parts[0] && /^index\.[cm]?[jt]s$/.test(parts[1] ?? "")) {
					path = join(root, parts[0]);
				} else if (parts.length !== 1) return undefined;
			} else if (info.type === "skills" && basename(path) === "SKILL.md" && isInside(root, dirname(path))) {
				path = dirname(path);
			}
			// Moving a resource symlink is safe, but walking through an ancestor symlink
			// would remove files from the external tree it points at.
			for (let parent = dirname(path); ; parent = dirname(parent)) {
				if (lstatSync(parent).isSymbolicLink()) return undefined;
				if (parent === root) break;
			}
			return { kind: "trash", path };
		}
		if (info.source === "local") {
			const base = this.baseDir(ctx, info.scope);
			const entries = ((this.scopeSettings(ctx, info.scope)[info.type] ?? []) as string[]).filter(
				(e) => !isOverride(e),
			);
			const ownsDirectory =
				(info.type === "extensions" && /^index\.[cm]?[jt]s$/.test(basename(info.path))) ||
				(info.type === "skills" && basename(info.path) === "SKILL.md");
			const entry = entries.find((e) => {
				const resolved = resolve(base, expandHome(e));
				return samePath(resolved, info.path) || (ownsDirectory && samePath(resolved, dirname(info.path)));
			});
			return entry === undefined ? undefined : { kind: "entry", entry };
		}
		return undefined;
	}

	/** Resolves to the scope of the deleted resource. */
	delete(path: string, target?: ExtensionTarget, type: ExtensionResourceType = "extensions"): Promise<ExtensionScope> {
		return this.exclusive(async () => {
			const ctx = this.context(target);
			this.assertSettingsReadable(ctx);
			const { info, raw } = await this.requireResource(ctx, type, path);
			const action = this.deleteTarget(ctx, info, raw);
			if (!action) {
				throw new PierProtocolError(
					"BAD_REQUEST",
					info.origin === "package"
						? `This resource belongs to the package ${info.source}; remove the package or disable the resource`
						: "This resource cannot be deleted individually; disable it instead",
				);
			}
			if (action.kind === "trash") {
				const moved = moveToTrash(action.path, this.options.trashDir);
				this.options.log?.(`${type} resource moved to trash: ${action.path} -> ${moved}`);
			} else {
				const base = this.baseDir(ctx, info.scope);
				const targets = [action.entry, relative(base, info.path)];
				const current = (this.scopeSettings(ctx, info.scope)[type] ?? []) as string[];
				const updated = current.filter(
					(e) => e !== action.entry && !(isOverride(e) && targets.some((t) => samePattern(patternTarget(e), t))),
				);
				this.setTopLevelPaths(ctx, info.scope, type, updated);
				await this.save(ctx);
			}
			return info.scope;
		});
	}
}

/** Move a file or directory into `trashDir` under a unique name (copying across file systems). */
function moveToTrash(path: string, trashDir: string): string {
	mkdirSync(trashDir, { recursive: true, mode: 0o700 });
	const target = join(trashDir, `${Date.now()}-${randomUUID()}-${basename(path)}`);
	try {
		renameSync(path, target);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
		cpSync(path, target, { recursive: true, errorOnExist: true });
		rmSync(path, { recursive: true, force: true });
	}
	return target;
}

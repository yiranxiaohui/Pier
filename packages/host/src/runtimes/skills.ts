import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
	PierProtocolError,
	type ResourceList,
	ResourceNameSchema,
	type ResourceRuntime,
	type ResourceScope,
	type SkillDocument,
	type SkillInfo,
} from "@pier/protocol";
import type { ExtensionManager, ExtensionTarget } from "../pi/extensions.ts";
import type { AgentConfigFiles } from "./agent-config.ts";
import { checkRevision, object, revision, strings, writeText } from "./resource-files.ts";

interface SkillRoot {
	path: string;
	scope: ResourceScope;
	shared: boolean;
}
interface Options {
	home: string;
	agentDir: string;
	trashDir: string;
	extensions: ExtensionManager;
	configs: AgentConfigFiles;
}

function metadata(text: string, fallback: string): { name: string; description: string } {
	try {
		const { frontmatter } = parseFrontmatter(text);
		return {
			name: typeof frontmatter.name === "string" ? frontmatter.name : fallback,
			description: typeof frontmatter.description === "string" ? frontmatter.description : "",
		};
	} catch {
		return { name: fallback, description: "技能的 YAML 格式无效" };
	}
}
function validate(text: string): void {
	let meta: Record<string, unknown>;
	try {
		meta = parseFrontmatter(text).frontmatter;
	} catch {
		throw new PierProtocolError("BAD_REQUEST", "SKILL.md 的 YAML 格式无效");
	}
	if (
		typeof meta.name !== "string" ||
		!/^[a-z0-9][a-z0-9-]{0,63}$/.test(meta.name) ||
		typeof meta.description !== "string" ||
		!meta.description.trim()
	) {
		throw new PierProtocolError("BAD_REQUEST", "SKILL.md 需要 name（小写字母、数字和连字符）与非空 description");
	}
}
/** Writes are restricted to discovered, standalone resources with no symlink ancestors. */
function safe(path: string, root: string): boolean {
	if (relative(root, path).startsWith("..") || !isAbsolute(path)) return false;
	let at = path;
	while (true) {
		if (existsSync(at) && lstatSync(at).isSymbolicLink()) return false;
		if (at === dirname(at)) break;
		at = dirname(at);
	}
	return !relative(root, path).split(/[\\/]/).includes(".system");
}

export class SkillManager {
	constructor(private readonly options: Options) {}
	private roots(runtime: ResourceRuntime, target?: ExtensionTarget): SkillRoot[] {
		const { home, configs } = this.options;
		const roots: SkillRoot[] =
			runtime === "claude-code"
				? [{ path: join(configs.configDir(runtime), "skills"), scope: "user", shared: false }]
				: [
						{ path: join(home, ".agents", "skills"), scope: "user", shared: true },
						{ path: join(configs.configDir("codex"), "skills"), scope: "user", shared: false },
					];
		if (target) {
			let at = resolve(target.path);
			while (true) {
				roots.push({
					path: join(at, runtime === "claude-code" ? ".claude" : ".agents", "skills"),
					scope: "project",
					shared: runtime === "codex",
				});
				if (at === dirname(at)) break;
				at = dirname(at);
			}
		}
		return roots;
	}
	private configFiles(runtime: "claude-code" | "codex", target?: ExtensionTarget) {
		return this.options.configs
			.scopes(runtime)
			.filter((s) => s === "user" || target)
			.map((s) => this.options.configs.read(runtime, s, target?.path));
	}
	async list(runtime: ResourceRuntime, target?: ExtensionTarget): Promise<ResourceList<SkillInfo>> {
		const errors: string[] = [];
		const items: SkillInfo[] = [];
		if (runtime === "pi") {
			const resources = (await this.options.extensions.list(target)).resources.filter((r) => r.type === "skills");
			for (const r of resources) {
				try {
					const text = this.readText(r.path);
					items.push({
						runtime,
						scope: r.scope,
						...metadata(text, r.name),
						path: r.path,
						enabled: r.enabled,
						editable: r.origin === "top-level" && safe(r.path, dirname(r.path)),
						deletable: r.deletable,
						shared: /[\\/]\.agents[\\/]skills[\\/]/.test(r.path),
					});
				} catch {
					errors.push(`无法读取技能：${r.path}`);
				}
			}
			return { items, errors };
		}
		const files = this.configFiles(runtime, target);
		for (const file of files) if (file.error) errors.push(`无法解析技能配置：${file.path}`);
		const denied = files.flatMap((f) => strings(object(f.settings?.permissions).deny));
		const overrides = files.flatMap((f) => {
			const value = object(f.settings?.skills).config;
			return Array.isArray(value) ? value.map(object) : [];
		});
		const visited = new Set<string>();
		for (const root of this.roots(runtime, target)) {
			const walk = (dir: string, depth: number) => {
				if (!existsSync(dir) || depth > 20) return;
				try {
					const real = realpathSync(dir);
					if (visited.has(real)) return;
					visited.add(real);
					const path = join(dir, "SKILL.md");
					if (existsSync(path)) {
						const meta = metadata(this.readText(path), basename(dir));
						const enabled =
							runtime === "claude-code"
								? !denied.some(
										(rule) =>
											rule === "Skill" ||
											rule === "Skill(*)" ||
											rule === `Skill(${meta.name})` ||
											rule === `Skill(${meta.name} *)`,
									)
								: overrides
										.filter(
											(o) =>
												typeof o.path === "string" &&
												[resolve(o.path), resolve(o.path, "SKILL.md")].includes(resolve(path)),
										)
										.at(-1)?.enabled !== false;
						const editable = safe(path, root.path);
						items.push({
							runtime,
							scope: root.scope,
							...meta,
							path,
							enabled,
							editable,
							deletable: editable,
							shared: root.shared,
						});
						return;
					}
					for (const entry of readdirSync(dir)) {
						const next = join(dir, entry);
						if (statSync(next).isDirectory()) walk(next, depth + 1);
					}
				} catch {
					errors.push(`无法读取技能目录：${dir}`);
				}
			};
			walk(root.path, 0);
		}
		return { items, errors };
	}
	private readText(path: string): string {
		if (statSync(path).size > 1_000_000) throw new PierProtocolError("BAD_REQUEST", "技能文件超过 1 MB");
		return readFileSync(path, "utf8");
	}
	private async require(runtime: ResourceRuntime, path: string, target?: ExtensionTarget): Promise<SkillInfo> {
		const skill = (await this.list(runtime, target)).items.find((s) => s.path === path);
		if (!skill) throw new PierProtocolError("NOT_FOUND", "技能不存在，请刷新列表");
		return skill;
	}
	async read(runtime: ResourceRuntime, path: string, target?: ExtensionTarget): Promise<SkillDocument> {
		const skill = await this.require(runtime, path, target);
		const text = this.readText(path);
		return { skill, text, revision: revision(text) };
	}
	private destination(runtime: ResourceRuntime, scope: ResourceScope, name: string, target?: ExtensionTarget): string {
		ResourceNameSchema.parse(name);
		if (scope === "local") throw new PierProtocolError("BAD_REQUEST", "技能支持全局和项目范围");
		if (scope === "project" && !target) throw new PierProtocolError("BAD_REQUEST", "请先选择工作区");
		const workspacePath = target?.path ?? "";
		const root =
			scope === "project"
				? join(workspacePath, runtime === "pi" ? ".pi" : runtime === "codex" ? ".agents" : ".claude", "skills")
				: runtime === "pi"
					? join(this.options.agentDir, "skills")
					: runtime === "codex"
						? join(this.options.home, ".agents", "skills")
						: join(this.options.configs.configDir(runtime), "skills");
		const path = join(root, name, "SKILL.md");
		if (!safe(path, root)) throw new PierProtocolError("BAD_REQUEST", "不能写入符号链接或系统技能目录");
		return path;
	}
	async save(
		runtime: ResourceRuntime,
		scope: ResourceScope,
		name: string,
		text: string,
		target?: ExtensionTarget,
		path?: string,
		expectedRevision?: string,
	): Promise<SkillDocument> {
		validate(text);
		const destination = path ?? this.destination(runtime, scope, name, target);
		if (path) {
			const skill = await this.require(runtime, path, target);
			if (!skill.editable)
				throw new PierProtocolError("BAD_REQUEST", "包内、系统或符号链接技能只支持查看，请复制为独立技能后编辑");
			if (!expectedRevision) throw new PierProtocolError("BAD_REQUEST", "编辑技能需要文件版本");
			checkRevision(this.readText(path), expectedRevision);
		} else if (existsSync(dirname(destination))) throw new PierProtocolError("CONFLICT", "该技能目录已存在");
		writeText(destination, text);
		return this.read(runtime, destination, target);
	}
	async import(
		runtime: ResourceRuntime,
		scope: ResourceScope,
		sourcePath: string,
		name: string | undefined,
		target?: ExtensionTarget,
	): Promise<SkillDocument> {
		const source = sourcePath.startsWith("~/") ? join(this.options.home, sourcePath.slice(2)) : sourcePath;
		if (!isAbsolute(source))
			throw new PierProtocolError("BAD_REQUEST", "请使用这台电脑上技能目录或 SKILL.md 的绝对路径");
		const sourceDir = basename(source) === "SKILL.md" ? dirname(source) : source;
		const text = this.readText(join(sourceDir, "SKILL.md"));
		validate(text);
		const destination = this.destination(runtime, scope, name ?? metadata(text, basename(sourceDir)).name, target);
		if (existsSync(dirname(destination))) throw new PierProtocolError("CONFLICT", "该技能目录已存在");
		mkdirSync(dirname(dirname(destination)), { recursive: true });
		try {
			cpSync(sourceDir, dirname(destination), {
				recursive: true,
				dereference: false,
				errorOnExist: true,
				force: false,
			});
		} catch (error) {
			rmSync(dirname(destination), { recursive: true, force: true });
			throw error;
		}
		return this.read(runtime, destination, target);
	}
	async setEnabled(
		runtime: ResourceRuntime,
		path: string,
		enabled: boolean,
		target?: ExtensionTarget,
	): Promise<{ changed: boolean }> {
		const skill = await this.require(runtime, path, target);
		if (runtime === "pi") {
			await this.options.extensions.setEnabled("skills", path, enabled, target);
			return { changed: enabled !== skill.enabled };
		}
		const scope = skill.scope === "project" && target ? "project" : "user";
		const file = this.options.configs.read(runtime, scope, target?.path);
		if (runtime === "codex") {
			const current = object(file.settings?.skills).config;
			const entries = Array.isArray(current) ? current.map(object) : [];
			const other = entries.filter(
				(o) => typeof o.path !== "string" || ![resolve(o.path), resolve(o.path, "SKILL.md")].includes(resolve(path)),
			);
			return this.options.configs.update(runtime, scope, target?.path, [
				{ path: ["skills", "config"], value: [...other, { path, enabled }] },
			]);
		}
		const rules = [`Skill(${skill.name})`, `Skill(${skill.name} *)`];
		const denied = strings(object(file.settings?.permissions).deny).filter((r) => !rules.includes(r));
		if (
			enabled &&
			this.configFiles(runtime, target).some((f) =>
				strings(object(f.settings?.permissions).deny).some(
					(r) => r === "Skill" || r === "Skill(*)" || (f.scope !== scope && rules.includes(r)),
				),
			)
		) {
			throw new PierProtocolError("CONFLICT", "其他范围的权限规则仍禁止该技能，请在 Agent 配置中调整 deny 规则");
		}
		return this.options.configs.update(runtime, scope, target?.path, [
			{ path: ["permissions", "deny"], value: enabled ? denied : [...denied, ...rules] },
		]);
	}
	async delete(
		runtime: ResourceRuntime,
		path: string,
		target?: ExtensionTarget,
		expectedRevision?: string,
	): Promise<{ deleted: boolean }> {
		const skill = await this.require(runtime, path, target);
		if (!skill.deletable) throw new PierProtocolError("BAD_REQUEST", "此技能不能单独删除，请停用或移除所属扩展包");
		checkRevision(this.readText(path), expectedRevision);
		if (runtime === "pi") await this.options.extensions.delete(path, target, "skills");
		else {
			const source = dirname(path);
			const trash = join(this.options.trashDir, `${basename(source)}-${randomUUID()}`);
			mkdirSync(this.options.trashDir, { recursive: true });
			renameSync(source, trash);
		}
		return { deleted: true };
	}
}

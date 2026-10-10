import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { PierProtocolError } from "@pier/protocol";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}
export function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
export function revision(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}
export function checkRevision(text: string, expected?: string): void {
	if (expected !== undefined && revision(text) !== expected)
		throw new PierProtocolError("CONFLICT", "文件已被修改，请刷新后重试");
}
export function readJson(path: string): JsonObject {
	if (!existsSync(path)) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
		return value as JsonObject;
	} catch {
		throw new PierProtocolError("CONFLICT", `无法读取 JSON 配置：${path}，请先修复该文件`);
	}
}
export function writeText(path: string, text: string): void {
	// Preserve symlinked configuration files instead of replacing their links.
	if (existsSync(path)) path = realpathSync(path);
	mkdirSync(dirname(path), { recursive: true });
	const temp = `${path}.pier-${randomUUID()}`;
	try {
		writeFileSync(temp, text, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600, flag: "wx" });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}
export function writeJson(path: string, value: JsonObject): void {
	writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

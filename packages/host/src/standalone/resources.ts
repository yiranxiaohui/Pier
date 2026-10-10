import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

/** pi needs real paths for templates, docs and Photon; unpack the embedded data into private state. */
export function prepareResources(archive: string, stateDir: string): string {
	const bytes = readFileSync(archive);
	const digest = createHash("sha256").update(bytes).digest("hex");
	const root = join(stateDir, "runtime", "resources");
	const destination = join(root, digest);
	const marker = join(destination, ".complete");
	if (existsSync(marker) && readFileSync(marker, "utf8") === digest) return destination;
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const temporary = mkdtempSync(join(root, ".prepare-"));
	try {
		const files = JSON.parse(gunzipSync(bytes).toString("utf8")) as Record<string, string>;
		for (const [name, content] of Object.entries(files)) {
			if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) {
				throw new Error("Invalid embedded resource path");
			}
			const file = join(temporary, name);
			mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
			writeFileSync(file, Buffer.from(content, "base64"), { mode: 0o600 });
		}
		writeFileSync(join(temporary, ".complete"), digest, { mode: 0o600 });
		try {
			renameSync(temporary, destination);
		} catch (error) {
			// Another Host may have prepared this exact immutable bundle concurrently.
			if (!existsSync(marker) || readFileSync(marker, "utf8") !== digest) throw error;
		}
		return destination;
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
}

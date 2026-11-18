import { parse } from "yaml";

/**
 * YAML front matter of a Markdown file (`---` ... `---`), parsed the way pi's
 * `parseFrontmatter` does, so skills read the same without loading pi. Throws on invalid YAML.
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const normalized = (content.charCodeAt(0) === 0xfeff ? content.slice(1) : content)
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	if (!normalized.startsWith("---")) return { frontmatter: {}, body: normalized };
	const end = normalized.indexOf("\n---", 3);
	if (end === -1) return { frontmatter: {}, body: normalized };
	const yaml = normalized.slice(4, end);
	const body = normalized.slice(end + 4).trim();
	if (!yaml) return { frontmatter: {}, body };
	const parsed: unknown = parse(yaml);
	return { frontmatter: (parsed ?? {}) as Record<string, unknown>, body };
}

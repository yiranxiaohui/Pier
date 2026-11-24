import type { Root } from "mdast";
import { findAndReplace, type RegExpMatchObject } from "mdast-util-find-and-replace";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
// Token types and fields of GFM autolink literals.
import type {} from "micromark-extension-gfm-autolink-literal";
import {
	asciiAlpha,
	asciiControl,
	markdownLineEndingOrSpace,
	unicodePunctuation,
	unicodeWhitespace,
} from "micromark-util-character";
import type { Code, Construct, Effects, Event, Extension, State, TokenizeContext } from "micromark-util-types";
import type { Processor } from "unified";

/**
 * remark-gfm for chat text, with URLs that stop at full-width punctuation.
 *
 * A GFM autolink literal such as `http://host:8000` runs until whitespace. Chinese text
 * rarely puts a space after a URL, so `管理页是 **http://host:8000**，现在可以打开。` linked
 * the rest of the sentence, closing `**` included, and the bold was lost. Here a literal
 * URL also ends at non-ASCII punctuation and symbols (`，。、；：！？`, full-width brackets,
 * `「」`, `“”`, `…`, `——`), as linkify-it does, and ASCII punctuation such as `**` that
 * precedes them is trailing punctuation, as before whitespace. Letters of any script still
 * continue a URL, so `https://zh.wikipedia.org/wiki/中文` stays whole. Without non-ASCII
 * punctuation, text parses exactly as with remark-gfm.
 *
 * This is remark-gfm's parsing half (we never serialize markdown) with both parts of its
 * autolink literals replaced: the micromark constructs for `http(s)://` and `www.` (adapted
 * from micromark-extension-gfm-autolink-literal 2.1, MIT), which emit the same tokens so
 * mdast-util-gfm still builds the links, and the mdast transform that links URLs and email
 * addresses the tokenizer left as text (from mdast-util-gfm-autolink-literal 2.0, MIT).
 */
export function remarkGfmCjk(this: Processor): undefined {
	const data = this.data();
	data.micromarkExtensions = [...(data.micromarkExtensions ?? []), gfm(), autolinkLiterals];
	data.fromMarkdownExtensions = [
		...(data.fromMarkdownExtensions ?? []),
		// Only the autolink literal extension has a transform.
		gfmFromMarkdown().map((extension) =>
			extension.transforms ? { ...extension, transforms: [transformLiterals] } : extension,
		),
	];
}

/** Non-ASCII punctuation or symbols end a URL, like whitespace. */
function wideStop(code: Code): boolean {
	return code !== null && code > 127 && unicodePunctuation(code);
}

// --- micromark: tokenize `http(s)://` and `www.` literals ---------------------------------

const wwwPrefix: Construct = { tokenize: tokenizeWwwPrefix, partial: true };
const domain: Construct = { tokenize: tokenizeDomain, partial: true };
const path: Construct = { tokenize: tokenizePath, partial: true };
const trail: Construct = { tokenize: tokenizeTrail, partial: true };
// After GFM's email literal, which is tried first on the same letters.
const wwwAutolink: Construct = {
	name: "cjkWwwAutolink",
	tokenize: tokenizeWwwAutolink,
	previous: previousWww,
	add: "after",
};
const protocolAutolink: Construct = {
	name: "cjkProtocolAutolink",
	tokenize: tokenizeProtocolAutolink,
	previous: previousProtocol,
	add: "after",
};

const autolinkLiterals: Extension = {
	// GFM's own constructs for these, by name.
	disable: { null: ["wwwAutolink", "protocolAutolink"] },
	text: { 72: protocolAutolink, 104: protocolAutolink, 87: wwwAutolink, 119: wwwAutolink },
};

function tokenizeWwwAutolink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
	const self = this;
	return start;

	function start(code: Code) {
		if ((code !== 87 && code !== 119) || !previousWww.call(self, self.previous) || previousUnbalanced(self.events)) {
			return nok(code);
		}
		effects.enter("literalAutolink");
		effects.enter("literalAutolinkWww");
		// `www.` is only checked: it is part of the domain.
		return effects.check(wwwPrefix, effects.attempt(domain, effects.attempt(path, after), nok), nok)(code);
	}

	function after(code: Code) {
		effects.exit("literalAutolinkWww");
		effects.exit("literalAutolink");
		return ok(code);
	}
}

function tokenizeProtocolAutolink(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
	const self = this;
	let protocol = "";
	let slash = false;
	return start;

	function start(code: Code) {
		if (
			(code !== 72 && code !== 104) ||
			!previousProtocol.call(self, self.previous) ||
			previousUnbalanced(self.events)
		) {
			return nok(code);
		}
		effects.enter("literalAutolink");
		effects.enter("literalAutolinkHttp");
		return inProtocol(code);
	}

	function inProtocol(code: Code): State | undefined {
		if (code !== null && asciiAlpha(code) && protocol.length < 5) {
			protocol += String.fromCodePoint(code);
			effects.consume(code);
			return inProtocol;
		}
		const name = protocol.toLowerCase();
		if (code === 58 && (name === "http" || name === "https")) {
			effects.consume(code);
			return slashes;
		}
		return nok(code);
	}

	function slashes(code: Code): State | undefined {
		if (code !== 47) return nok(code);
		effects.consume(code);
		if (slash) return afterProtocol;
		slash = true;
		return slashes;
	}

	function afterProtocol(code: Code) {
		return code === null ||
			asciiControl(code) ||
			markdownLineEndingOrSpace(code) ||
			unicodeWhitespace(code) ||
			unicodePunctuation(code)
			? nok(code)
			: effects.attempt(domain, effects.attempt(path, after), nok)(code);
	}

	function after(code: Code) {
		effects.exit("literalAutolinkHttp");
		effects.exit("literalAutolink");
		return ok(code);
	}
}

function tokenizeWwwPrefix(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
	let size = 0;
	return inPrefix;

	function inPrefix(code: Code): State | undefined {
		if ((code === 87 || code === 119) && size < 3) {
			size++;
			effects.consume(code);
			return inPrefix;
		}
		if (code === 46 && size === 3) {
			effects.consume(code);
			return (next: Code) => (next === null ? nok(next) : ok(next));
		}
		return nok(code);
	}
}

/** Domain: anything but whitespace and punctuation (other than `-`, `.` and `_`). */
function tokenizeDomain(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
	let underscoreInLastSegment: boolean | undefined;
	let underscoreInLastLastSegment: boolean | undefined;
	let seen = false;
	return inDomain;

	function inDomain(code: Code): State | undefined {
		// `.` or `_`, unless trailing punctuation.
		if (code === 46 || code === 95) return effects.check(trail, end, atPunctuation)(code);
		if (
			code === null ||
			markdownLineEndingOrSpace(code) ||
			unicodeWhitespace(code) ||
			(code !== 45 && unicodePunctuation(code))
		) {
			return end(code);
		}
		seen = true;
		effects.consume(code);
		return inDomain;
	}

	function atPunctuation(code: Code) {
		if (code === 95) underscoreInLastSegment = true;
		else {
			underscoreInLastLastSegment = underscoreInLastSegment;
			underscoreInLastSegment = undefined;
		}
		effects.consume(code);
		return inDomain;
	}

	function end(code: Code) {
		return underscoreInLastLastSegment || underscoreInLastSegment || !seen ? nok(code) : ok(code);
	}
}

/** Path: anything up to whitespace or non-ASCII punctuation, without trailing punctuation. */
function tokenizePath(this: TokenizeContext, effects: Effects, ok: State): State {
	let open = 0;
	let close = 0;
	return inPath;

	function inPath(code: Code): State | undefined {
		if (code === 40) {
			open++;
			effects.consume(code);
			return inPath;
		}
		// A `)` closing a `(` in the path is not trailing.
		if (code === 41 && close < open) return atPunctuation(code);
		if (
			code === 33 ||
			code === 34 ||
			code === 38 ||
			code === 39 ||
			code === 41 ||
			code === 42 ||
			code === 44 ||
			code === 46 ||
			code === 58 ||
			code === 59 ||
			code === 60 ||
			code === 63 ||
			code === 93 ||
			code === 95 ||
			code === 126
		) {
			return effects.check(trail, ok, atPunctuation)(code);
		}
		if (code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code) || wideStop(code)) {
			return ok(code);
		}
		effects.consume(code);
		return inPath;
	}

	function atPunctuation(code: Code) {
		if (code === 41) close++;
		effects.consume(code);
		return inPath;
	}
}

/**
 * Trailing punctuation: `ok` when the punctuation here runs up to the end of the URL
 * (whitespace, `<`, non-ASCII punctuation), so it is not part of it; `nok` otherwise.
 */
function tokenizeTrail(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
	return inTrail;

	function inTrail(code: Code): State | undefined {
		if (
			code === 33 ||
			code === 34 ||
			code === 39 ||
			code === 41 ||
			code === 42 ||
			code === 44 ||
			code === 46 ||
			code === 58 ||
			code === 59 ||
			code === 63 ||
			code === 95 ||
			code === 126
		) {
			effects.consume(code);
			return inTrail;
		}
		// `&` + letters + `;` is a character reference, as a whole trailing.
		if (code === 38) {
			effects.consume(code);
			return (next: Code) => (next !== null && asciiAlpha(next) ? inReference(next) : nok(next));
		}
		// `]` is trailing unless a link resource or reference follows.
		if (code === 93) {
			effects.consume(code);
			return afterBracket;
		}
		if (code === 60 || code === null || markdownLineEndingOrSpace(code) || unicodeWhitespace(code) || wideStop(code)) {
			return ok(code);
		}
		return nok(code);
	}

	function afterBracket(code: Code) {
		return code === null || code === 40 || code === 91 || markdownLineEndingOrSpace(code) || unicodeWhitespace(code)
			? ok(code)
			: inTrail(code);
	}

	function inReference(code: Code): State | undefined {
		if (code === 59) {
			effects.consume(code);
			return inTrail;
		}
		if (code !== null && asciiAlpha(code)) {
			effects.consume(code);
			return inReference;
		}
		return nok(code);
	}
}

function previousWww(this: TokenizeContext, code: Code): boolean {
	return (
		code === null ||
		code === 40 ||
		code === 42 ||
		code === 95 ||
		code === 91 ||
		code === 93 ||
		code === 126 ||
		markdownLineEndingOrSpace(code)
	);
}

function previousProtocol(this: TokenizeContext, code: Code): boolean {
	return !asciiAlpha(code);
}

/** Whether an unclosed `[` or `![` precedes (a literal there could become a link label). */
function previousUnbalanced(events: Event[]): boolean {
	let index = events.length;
	let result = false;
	while (index--) {
		const token = events[index]?.[1];
		if (!token) continue;
		if ((token.type === "labelLink" || token.type === "labelImage") && !token._balanced) {
			result = true;
			break;
		}
		// Seen before without finding one.
		if (token._gfmAutolinkLiteralWalkedInto) break;
	}
	const last = events[events.length - 1];
	if (last && !result) last[1]._gfmAutolinkLiteralWalkedInto = true;
	return result;
}

// --- mdast: link URLs and email addresses left in text --------------------------------

/** remark-gfm's patterns, with the URL path ending at whitespace or non-ASCII punctuation. */
const URL_PATTERN = /(https?:\/\/|www(?=\.))([-.\w]+)((?:[!-~]|[^\s\p{P}\p{S}])*)/giu;
const EMAIL_PATTERN = /(?<=^|\s|\p{P}|\p{S})([-.\w+]+)@([-\w]+(?:\.[-\w]+)+)/gu;

function transformLiterals(tree: Root): undefined {
	findAndReplace(
		tree,
		[
			[URL_PATTERN, findUrl],
			[EMAIL_PATTERN, findEmail],
		],
		{ ignore: ["link", "linkReference"] },
	);
}

function findUrl(_: string, protocol: string, host: string, rest: string, match: RegExpMatchObject) {
	if (!previous(match)) return false;
	let prefix = "";
	if (/^w/i.test(protocol)) {
		host = protocol + host;
		protocol = "";
		prefix = "http://";
	}
	if (!correctDomain(host)) return false;
	const [url, tail] = splitUrl(host + rest);
	if (!url) return false;
	const link = literal(prefix + protocol + url, protocol + url);
	return tail ? [link, { type: "text" as const, value: tail }] : link;
}

function findEmail(_: string, atext: string, label: string, match: RegExpMatchObject) {
	if (!previous(match, true) || /[-\d_]$/.test(label)) return false;
	return literal(`mailto:${atext}@${label}`, `${atext}@${label}`);
}

function literal(url: string, text: string) {
	return { type: "link" as const, title: null, url, children: [{ type: "text" as const, value: text }] };
}

/** Preceded by nothing, whitespace or punctuation (but not `/` for an email). */
function previous(match: RegExpMatchObject, email = false): boolean {
	if (match.index === 0) return true;
	const code = match.input.charCodeAt(match.index - 1);
	return (unicodeWhitespace(code) || unicodePunctuation(code)) && !(email && code === 47);
}

function correctDomain(host: string): boolean {
	const parts = host.split(".");
	if (parts.length < 2) return false;
	return parts.slice(-2).every((part) => !part || (!part.includes("_") && /[a-zA-Z\d]/.test(part)));
}

/** Split trailing punctuation off, keeping `)` that close a `(` in the URL. */
function splitUrl(value: string): [string, string | undefined] {
	const trailing = /[!"&'),.:;<>?\]}]+$/.exec(value);
	if (!trailing) return [value, undefined];
	let url = value.slice(0, trailing.index);
	let tail = trailing[0];
	const opening = count(url, "(");
	let closing = count(url, ")");
	let index = tail.indexOf(")");
	while (index !== -1 && opening > closing) {
		url += tail.slice(0, index + 1);
		tail = tail.slice(index + 1);
		index = tail.indexOf(")");
		closing++;
	}
	return [url, tail];
}

function count(value: string, character: string): number {
	return value.split(character).length - 1;
}

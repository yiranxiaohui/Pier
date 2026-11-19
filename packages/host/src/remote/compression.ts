import { constants, deflateRawSync, inflateRawSync } from "node:zlib";
import type { FrameCompression } from "@pier/crypto";

/**
 * Raw DEFLATE for secure-channel frames (`CAP_DEFLATE`), from `node:zlib` (Node and Bun).
 *
 * Level 3 compresses a session snapshot to roughly a third in a few tens of milliseconds:
 * almost as small as the default level 6, and noticeably faster on large transcripts.
 */
export const zlibFrameCompression: FrameCompression = {
	deflate: (data) => deflateRawSync(data, { level: 3, strategy: constants.Z_DEFAULT_STRATEGY }),
	inflate: (data, maxBytes) => inflateRawSync(data, { maxOutputLength: maxBytes }),
};

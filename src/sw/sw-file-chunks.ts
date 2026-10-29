// sw-file-chunks.ts — the one store of the files this runtime is being sent in `file.put` chunks over the hub, shared by
// the hub runtime that takes the chunks (sw-hub.ts) and the command handler that puts a file back in the message that
// names it (sw-sessions.ts). In worker memory: an eviction loses it, and the client asks `file.have` and sends again.

import { FileChunks } from "../hub/runtime/file-chunks";
import { PDF_ATTACH_MAX } from "../attached-files";

/** How long a file sent ahead is kept after its last chunk or its last use: long enough to write the message. */
export const FILE_CHUNKS_TTL_MS = 15 * 60_000;

/** The files being sent, and those sent and not yet used. Up to three of the largest at once, in progress or done. */
export const fileChunks = new FileChunks({ maxFileBytes: PDF_ATTACH_MAX, maxTotalBytes: 3 * PDF_ATTACH_MAX, ttlMs: FILE_CHUNKS_TTL_MS }); // state: cache

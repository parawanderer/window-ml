// file-frame.ts — a file's bytes as `file.put` commands carry them over the hub: the chunk RAW after the command's JSON,
// how big a chunk may be, and how much a file may be (docs/spec/FILE_ATTACHMENTS.md, "Over the hub: chunks in an
// acknowledged window").
//
// Pure: the client (hub-connection.ts) frames and sizes, the runtime (hub-runtime.ts) unframes. A sealed command's body
// is opaque to the hub, so the frame needs no hub change.

/** The byte between a command's JSON and the raw bytes after it. JSON never holds one: `JSON.stringify` writes a zero
 *  code point as `\u0000`, and UTF-8 encodes no other character with a zero byte. */
const SEPARATOR = 0;

/** Most chunks sent and not yet answered. A runtime's queue on the hub is 16 MiB and a frame that does not fit closes
 *  the RUNTIME's connection, every session it serves with it: four chunks of under 1 MiB are a quarter of it. */
export const FILE_PUT_WINDOW = 4;

/** The share of the account's burst allowance one file may spend: the rate is shared with the runtime's own event
 *  publishing, so an upload past it would slow every session's live replies on the account. */
export const FILE_BURST_SHARE = 0.6;

/** The command's JSON, then the separator, then the chunk. */
export function frameChunk(json: Uint8Array, chunk: Uint8Array): Uint8Array {
    const out = new Uint8Array(json.length + 1 + chunk.length);
    out.set(json, 0);
    out[json.length] = SEPARATOR;
    out.set(chunk, json.length + 1);
    return out;
}

/** A sealed command's body split into its JSON and the bytes after it (null when there are none). */
export function unframe(body: Uint8Array): { json: Uint8Array; chunk: Uint8Array | null } {
    const at = body.indexOf(SEPARATOR);
    return at < 0 ? { json: body, chunk: null } : { json: body.subarray(0, at), chunk: body.subarray(at + 1) };
}

/**
 * How many bytes of a file one chunk carries: the hub's payload limit, less what sealing adds, the command's JSON, the
 * separator and a margin.
 * @param limit the hub's `maxPayloadBytes` (`Welcome.limits`)
 * @param overhead what sealing adds to an empty body (`HubClient.commandOverhead`)
 * @param jsonBytes the longest JSON header a chunk of this file will carry
 * @param margin bytes kept back for a seal that comes out longer than the one measured
 */
export function chunkSize(limit: number, overhead: number, jsonBytes: number, margin: number): number {
    return Math.max(0, limit - overhead - jsonBytes - 1 - margin);
}

/** The most one file may be over this hub: the runtime's own cap, or the share of the account's burst allowance when
 *  that is smaller. A hub that announces no allowance (0) leaves the runtime's cap. */
export function fileCap(runtimeMax: number, burstBytes: number): number {
    return burstBytes > 0 ? Math.min(runtimeMax, Math.floor(burstBytes * FILE_BURST_SHARE)) : runtimeMax;
}

/** A SHA-256 as lowercase hex, the form `file.put` names a file by. `digestOf` (backup-file.ts) is the same; it is
 *  not imported because that module loads the archive's SQLite, and this one goes in the chat page's bundle. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
    const d = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
    return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

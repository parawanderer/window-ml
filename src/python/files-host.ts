// files-host.ts — the offscreen document's side of Python's `/files`: one reader channel per worker-hosted run's
// worker, its session fixed to that run's, served over the synchronous channel (files-wire.ts).

import { FILES_CHUNK, type FilesChannel } from "./files-reader";
import { allocFilesShared, serveFiles } from "./files-wire";

/** Opens a channel on the reader's "files" volume; set by the reader's owner once it exists, and absent until then. */
let openChannel: (() => FilesChannel) | null = null;   // state: plumbing — the reader's factory, set once at start

/** Each served worker's channel and its request handler, by principal. */
const served = new Map<string, { channel: FilesChannel; handle: (msg: unknown) => boolean }>();   // state: plumbing — dies with the worker

/**
 * Give `/files` its reader. Until this is called no worker gets a mount, and Python sees no `/files` at all.
 * @param open opens a channel on the reader's "files" volume
 */
export function setFilesReader(open: (() => FilesChannel) | null): void {
    openChannel = open;
}

/**
 * At a worker's spawn, before any run is posted: a worker-hosted run's worker (`run:<hash>`) gets the channel's
 * memory and a channel whose session is that run's, for the worker's whole life. No other principal gets one: not
 * a page's, not the bench's, not `library`, not an install's candidate (`install:…`).
 * @param principal whose worker it is
 * @param w the worker, already holding its interrupt buffer
 */
export function attachFiles(principal: string, w: Worker): void {
    if (!openChannel || !principal.startsWith("run:") || typeof SharedArrayBuffer !== "function") return;
    const session = principal.slice("run:".length);
    if (!session) return;
    const shared = allocFilesShared();
    const channel = openChannel();
    channel.setSession(session);
    served.set(principal, { channel, handle: serveFiles(shared, channel).handle });
    // Where the run writes, as the reader gives it (`/files/agent`, ruling 86): the mount's working directory.
    w.postMessage({ filesShared: shared, ...(channel.home ? { filesHome: channel.home } : {}) });
}

/**
 * A message from a worker: true when it was a `/files` request (or an abandon), which is then served and needs nothing more.
 * @param principal whose worker sent it
 * @param data the message
 */
export function filesMessage(principal: string, data: unknown): boolean {
    return served.get(principal)?.handle(data) ?? false;
}

/**
 * A worker's end (killed, reaped, crashed): its channel closes every descriptor and aborts every open transaction, so
 * a file a dead kernel was writing never lands half-written.
 * @param principal whose worker ended
 */
export function detachFiles(principal: string): void {
    const s = served.get(principal);
    if (!s) return;
    served.delete(principal);
    try { s.channel.dispose(); } catch { /* the reader is gone too */ }
}

/**
 * A whole file of a served worker's session, read through its channel: the hide rule and the secret mask apply as they
 * do to the mount's reads, since it is the same reader (`ml.table` over a `/files/` path, docs/spec/ML_TABLE.md).
 * @param principal whose worker's session the file is read in
 * @param path the path under `/files/`, session-relative (`attached/<h>/<name>`, `agent/…`)
 * @param max the most bytes read; a larger file rejects with EFBIG before a byte of it is read
 * @returns the bytes
 * @throws the reader's `FsError` (ENOENT, EACCES for a hidden file, EISDIR, …), or one with code `ENOFILES` when this
 *   principal has no `/files`, or `EFBIG`
 */
export async function readWholeFile(principal: string, path: string, max: number): Promise<ArrayBuffer> {
    const s = served.get(principal);
    if (!s) throw { code: "ENOFILES", syscall: "open", path, message: "this sandbox has no /files" };
    const { fd, size } = await s.channel.open(path);
    try {
        if (size > max) throw { code: "EFBIG", syscall: "read", path, message: `'${path}' is ${size} bytes, past the ${max} a table read takes` };
        const out = new Uint8Array(size);
        let at = 0;
        while (at < size) {
            const n = await s.channel.read(fd, at, Math.min(FILES_CHUNK, size - at), out.subarray(at));
            if (n <= 0) break;
            at += n;
        }
        return out.buffer.slice(0, at);
    } finally {
        await s.channel.close(fd).catch(() => { /* the read already answered */ });
    }
}

// files-wire.ts — the synchronous channel between the Python worker's `/files` mount and the offscreen document's
// reader (route A, FILE_ATTACHMENTS.md "Host directories in the sandbox"): a posted request, a reply in shared memory,
// and a sliced `Atomics.wait` that a Stop ends.

import { FILES_CHUNK, type FilesChannel, type FsError, type FsErrorCode } from "./files-reader";

/** The reply header's words: the id the reply answers, its status (0, or an index into `FS_CODES`), the payload's length. */
export const RESP_ID = 0, RESP_STATUS = 1, RESP_LEN = 2;

/** The status codes a reply carries, by index; 0 is success. A code outside the list arrives as EIO. */
export const FS_CODES: readonly (FsErrorCode | "OK")[] = ["OK", "ENOENT", "ENOTDIR", "EISDIR", "EBADF", "EACCES", "EROFS", "EEXIST", "ENOSPC", "ENOTEMPTY", "EINVAL", "EIO"];

/** How long one slice of the wait is, ms: a Stop is seen within one slice (route A measured 300 of 300 at this size). */
export const WAIT_SLICE_MS = 20;

/** The shared memory of one channel: the reply header and the payload window (one chunk plus room for a JSON reply). */
export interface FilesShared {
    ctl: SharedArrayBuffer;
    data: SharedArrayBuffer;
}

/** Allocate a channel's shared memory, in the offscreen document; the worker gets both buffers once, at its start. */
export function allocFilesShared(): FilesShared {
    return { ctl: new SharedArrayBuffer(16), data: new SharedArrayBuffer(FILES_CHUNK + 64 * 1024) };
}

/** The operations a request may name: the channel's members, less the offscreen document's own `setSession`/`dispose`. */
export type FilesOp = "stat" | "opendir" | "open" | "read" | "fstat" | "close" | "begin" | "openWrite" | "write" | "truncate" | "closeWrite" | "rename" | "unlink" | "mkdir" | "rmdir" | "commitTx" | "abortTx";

/** One request, as the worker posts it: `bytes` only for a `write`. */
export interface FilesRequest {
    filesReq: { id: number; op: FilesOp; args: unknown[] };
    bytes?: ArrayBuffer;
}

/** A thrown reply: the status code, raised by the mount as the matching errno. */
export class FilesReplyError extends Error {
    constructor(readonly code: FsErrorCode, message: string) { super(message); }
}

/**
 * The worker's side: send one request and block until its reply, in slices, giving up when the interrupt flag reads 2
 * (a Stop). `onAbandon` is called with the abandoned id, and the caller raises EINTR.
 * @param shared the channel's memory
 * @param post the worker's own `postMessage`, captured
 * @param interrupt the interrupt buffer (offscreen.ts `ensureWorker`), or null where there is none
 * @returns `call(op, args, bytes?)`: the reply's JSON, or for `read` the byte count with the bytes at `data[0..n)`
 */
export function makeRequester(shared: FilesShared, post: (m: unknown, transfer?: Transferable[]) => void, interrupt: Int32Array | null) {
    const ctl = new Int32Array(shared.ctl), data = new Uint8Array(shared.data);
    const td = new TextDecoder();
    let seq = 0;
    /** Thrown when a Stop ends the wait: the mount raises EINTR, and Python's signal check raises KeyboardInterrupt. */
    class Interrupted extends Error {}
    function call(op: FilesOp, args: unknown[], bytes?: Uint8Array): unknown {
        const id = ++seq;
        const msg: FilesRequest = { filesReq: { id, op, args } };
        let transfer: Transferable[] = [];
        if (bytes) { const copy = bytes.slice(); msg.bytes = copy.buffer as ArrayBuffer; transfer = [copy.buffer as ArrayBuffer]; }
        post(msg, transfer);
        for (;;) {
            const cur = Atomics.load(ctl, RESP_ID);
            if (cur === id) break;
            if (interrupt && Atomics.load(interrupt, 0) === 2) { post({ filesAbandon: id }); throw new Interrupted(`interrupted during ${op}`); }
            Atomics.wait(ctl, RESP_ID, cur, WAIT_SLICE_MS);
        }
        const status = Atomics.load(ctl, RESP_STATUS), len = Atomics.load(ctl, RESP_LEN);
        if (status) {
            const code = (FS_CODES[status] ?? "EIO") as FsErrorCode;
            let message = code as string;
            try { message = String((JSON.parse(td.decode(data.slice(0, len))) as { message?: string }).message ?? code); } catch { /* the code alone */ }
            throw new FilesReplyError(code, message);
        }
        if (op === "read") return len;
        return len ? JSON.parse(td.decode(data.slice(0, len))) : undefined;
    }
    return { call, data, Interrupted };
}

/** Every op a request may name; anything else (a prototype name, `setSession`, `dispose`) is never called. */
const FILES_OPS: ReadonlySet<string> = new Set<FilesOp>(["stat", "opendir", "open", "read", "fstat", "close", "begin", "openWrite", "write", "truncate", "closeWrite", "rename", "unlink", "mkdir", "rmdir", "commitTx", "abortTx"]);

/** The ops whose answer is a new descriptor or txn, released again when the request was abandoned. */
const OPENS: Partial<Record<FilesOp, (v: any, ch: FilesChannel) => Promise<unknown>>> = {
    open: (v, ch) => ch.close(v.fd),
    openWrite: (v, ch) => ch.closeWrite(v.wfd),
    begin: (v, ch) => ch.abortTx(v),
};

/**
 * The offscreen document's side: answer one worker's requests over `channel`, one at a time, in order. A reply is
 * written only while its id is the newest the worker sent, so an answer to a request the worker abandoned never lands
 * in the window a later request reads; a descriptor or txn such an answer opened is released again.
 * @param shared the channel's memory (the same buffers the worker holds)
 * @param channel the reader's channel for this worker
 * @returns `handle(msg)` for a message from the worker, true when it was the channel's
 */
export function serveFiles(shared: FilesShared, channel: FilesChannel) {
    const ctl = new Int32Array(shared.ctl), data = new Uint8Array(shared.data);
    const te = new TextEncoder();
    // A fixed buffer the reader copies into, never one per chunk (ranged.ipynb): copied to `data` only if still wanted.
    // Replaced only when a request still in flight is abandoned, since its late copy may land in it.
    let scratch = new Uint8Array(FILES_CHUNK);   // state: plumbing — the reader's copy target
    let newest = 0;   // state: plumbing — the newest request id the worker sent; dies with the channel
    const abandoned = new Set<number>();   // state: plumbing — abandoned ids not yet served
    let chain: Promise<void> = Promise.resolve();   // state: plumbing — one request at a time, in order
    // The request being served and how to stop waiting for it. A STOP MUST NOT WAIT ON THE READER: when the worker
    // abandons the request in flight, the queue moves past it at once, so a read that never returns holds nothing
    // after the first Stop. Its late answer is dropped (`reply` checks the id) and what it opened is released.
    let inflight: { id: number; skip: () => void } | null = null;   // state: plumbing

    function reply(id: number, status: number, payload: Uint8Array) {
        if (id !== newest || abandoned.has(id)) return;
        data.set(payload, 0);
        Atomics.store(ctl, RESP_STATUS, status);
        Atomics.store(ctl, RESP_LEN, payload.length);
        Atomics.store(ctl, RESP_ID, id);
        Atomics.notify(ctl, RESP_ID);
    }
    async function serve(id: number, op: FilesOp, args: unknown[], bytes?: ArrayBuffer) {
        try {
            if (op === "read") {
                const [fd, position, length] = args as [number, number, number];
                const buf = scratch;
                const n = await channel.read(fd, position, Math.min(length, FILES_CHUNK), buf);
                reply(id, 0, buf.subarray(0, n));
                return;
            }
            const fn = (channel as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[op];
            const callArgs = op === "write" ? [args[0], args[1], new Uint8Array(bytes ?? new ArrayBuffer(0))] : args;
            const value = await fn.apply(channel, callArgs);
            if (abandoned.has(id) || id !== newest) { await OPENS[op]?.(value, channel)?.catch(() => { /* the channel already dropped it */ }); return; }
            reply(id, 0, value === undefined ? new Uint8Array(0) : te.encode(JSON.stringify(value)));
        } catch (e) {
            const err = e as Partial<FsError>;
            const status = Math.max(1, FS_CODES.indexOf((err?.code ?? "EIO") as FsErrorCode));
            reply(id, status, te.encode(JSON.stringify({ message: String(err?.message ?? err?.code ?? e) })));
        } finally { abandoned.delete(id); }
    }
    function handle(msg: unknown): boolean {
        const m = msg as Partial<FilesRequest> & { filesAbandon?: number };
        if (typeof m?.filesAbandon === "number") {
            if (m.filesAbandon !== newest) return true;
            abandoned.add(m.filesAbandon);
            if (inflight?.id === m.filesAbandon) { scratch = new Uint8Array(FILES_CHUNK); inflight.skip(); }
            return true;
        }
        const req = m?.filesReq;
        if (!req || typeof req.id !== "number" || typeof req.op !== "string" || !Array.isArray(req.args)) return false;
        // A full worker runs any JavaScript, so it can post anything: only a listed op is called, and never `setSession`.
        if (!FILES_OPS.has(req.op)) return true;
        newest = Math.max(newest, req.id);
        const { id, op, args } = req;
        chain = chain.then(() => new Promise<void>((done) => {
            inflight = { id, skip: done };
            serve(id, op, args, m.bytes).finally(() => { if (inflight?.id === id) inflight = null; done(); });
        }));
        return true;
    }
    return { handle };
}

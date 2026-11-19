// files-mount.ts — Python's `/files`: an Emscripten file system type whose every operation is a request to the
// offscreen document's ranged reader over the synchronous channel (files-wire.ts), so no file is ever held whole.

import { FILES_CHUNK } from "./files-reader";
import { FilesReplyError, type FilesOp } from "./files-wire";

/** Where the mount sits in the Python worker's file system. */
export const FILES_AT = "/files";

/** Read chunks the mount keeps, in fixed slots of one chunk each (32 × 512 KiB = 16 MiB, #1999 "The bounds"). */
export const READ_CACHE_SLOTS = 32;

/** The open(2) flag bits the mount reads (Emscripten's values, the Linux ones). */
const O_ACCMODE = 3, O_TRUNC = 0o1000, O_APPEND = 0o2000;
const S_IFDIR = 0o40000, S_IFREG = 0o100000;

/** One request over the channel: the reply's JSON, or for `read` the count with the bytes in `data`. */
type Call = (op: FilesOp, args: unknown[], bytes?: Uint8Array) => unknown;

/** What the mount needs from the worker: Emscripten's FS, its errno table, the channel's request and payload window. */
export interface FilesMountDeps {
    FS: any;
    ERRNO_CODES: Record<string, number>;
    call: Call;
    data: Uint8Array;
    /** The requester's class for an interrupted wait (a Stop): raised as EINTR. */
    Interrupted: new (...a: any[]) => Error;
    /** When a file's commit or a txn's abort fails after the stream is gone: the cell's log, never the model's reply. */
    onLost?: (path: string, why: string) => void;
}

/** A file's stat as the reader gives it. */
interface Stat { kind: "file" | "dir"; size: number; mtimeMs: number; hidden: boolean; readonly: boolean }

/**
 * Build the `/files` type and the per-cell reset. The session is never the mount's: the offscreen document sets the
 * channel's per cell, and every descriptor this mount holds answers EBADF under any other.
 * @param deps the worker's FS, errno table and channel
 * @returns `type` for `FS.mount`, `remount()` for each cell's start, and `stats` for tests
 */
export function makeFilesMount(deps: FilesMountDeps) {
    const { FS, ERRNO_CODES, call, data, Interrupted } = deps;
    const stats = { requests: 0, cacheHits: 0 };

    /** One request, its refusal raised as the errno Python sees. */
    function req(op: FilesOp, args: unknown[], bytes?: Uint8Array): any {
        stats.requests++;
        try { return call(op, args, bytes); }
        catch (e) {
            if (e instanceof FilesReplyError) throw new FS.ErrnoError(ERRNO_CODES[e.code] ?? ERRNO_CODES.EIO);
            if (e instanceof Interrupted) throw new FS.ErrnoError(ERRNO_CODES.EINTR);
            throw e;
        }
    }
    /** Run `fn` in a txn of one, committed when it returns and aborted when it throws. */
    function once<T>(fn: (txn: number) => T): T {
        const txn = req("begin", []) as number;
        let out: T;
        try { out = fn(txn); }
        catch (e) { try { req("abortTx", [txn]); } catch { /* the channel aborts it at its end */ } throw e; }
        req("commitTx", [txn]);
        return out;
    }

    // THE READ CACHE: fixed slots, never a buffer per chunk (#1999, ranged.ipynb). Keyed by descriptor and chunk, and
    // emptied at every cell, so a descriptor a later cell reaches is asked again under that cell's session.
    const slots = Array.from({ length: READ_CACHE_SLOTS }, () => ({ key: "", n: 0, used: 0, buf: null as Uint8Array | null }));   // state: cache — read chunks, emptied per cell
    let tick = 0;   // state: cache — the slots' LRU clock
    function chunk(fd: number, index: number): { buf: Uint8Array; n: number } {
        const key = `${fd}:${index}`;
        for (const s of slots) if (s.key === key) { s.used = ++tick; stats.cacheHits++; return { buf: s.buf!, n: s.n }; }
        const n = req("read", [fd, index * FILES_CHUNK, FILES_CHUNK]) as number;
        const s = slots.reduce((a, b) => (a.used <= b.used ? a : b));
        s.buf ??= new Uint8Array(FILES_CHUNK);
        s.buf.set(data.subarray(0, n), 0);
        s.key = key; s.n = n; s.used = ++tick;
        return { buf: s.buf, n };
    }
    function dropCache(fd?: number) { for (const s of slots) if (fd === undefined || s.key.startsWith(`${fd}:`)) { s.key = ""; s.used = 0; } }

    /** A node's session-relative path, from its place in the tree (a rename moves a node, so it is never stored). */
    function pathOf(node: any): string {
        const parts: string[] = [];
        for (let n = node; n !== n.mount.root; n = n.parent) parts.unshift(n.name);
        return parts.join("/");
    }
    /** A child's path under a directory's (the root's is ""). */
    const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
    /** Whether a path is one the agent may write: under `agent/`, never `agent` itself. */
    const writable = (p: string) => p.startsWith("agent/");

    // Every node carries write bits: Emscripten checks the mode before it calls the mount and would answer EACCES, where
    // the refusal is EROFS ("The layout"). What may be written is decided here and by the reader, never by the mode.
    const modeOf = (st: Stat) => (st.kind === "dir" ? S_IFDIR | 0o755 : S_IFREG | 0o644);
    function makeNode(parent: any, name: string, st: Stat): any {
        const node = FS.createNode(parent, name, modeOf(st), 0);
        node.node_ops = type.node_ops;
        node.stream_ops = type.stream_ops;
        node.st = st;
        node.kids = null;   // stat by child name, from the last listing
        return node;
    }
    /** Forget what this mount knows of a node and its directory, after anything changed it. */
    function stale(node: any) { node.st = null; if (node.parent) node.parent.kids = null; }

    /** Write a stream's coalesced bytes, if any (Python's small writes become one request per chunk). */
    function flush(stream: any) {
        const w = stream.wbuf;
        if (!w || !w.len) return;
        const len = w.len;
        w.len = 0;
        put(stream, () => req("write", [stream.wfd, w.pos, len], w.buf.subarray(0, len)));
    }
    /**
     * One change to a writer's pending part. A refused one (ENOSPC, the channel gone) FAILS the writer: every later
     * change raises the same errno, and its close aborts, so a file is never committed with part of what was written.
     */
    function put(stream: any, change: () => void) {
        if (stream.failed) throw new FS.ErrnoError(stream.failed);
        try { change(); }
        catch (e) { stream.failed = (e as { errno?: number })?.errno ?? ERRNO_CODES.EIO; throw e; }
    }

    const type: any = {
        mount(_m: any) {
            return makeNode(null, "/", { kind: "dir", size: 0, mtimeMs: Date.now(), hidden: false, readonly: true });
        },
        node_ops: {
            getattr(node: any) {
                const p = pathOf(node);
                const st: Stat = node.st ?? (node.st = req("stat", [p]) as Stat);
                const size = node.writer ? node.writer.size : st.kind === "dir" ? 4096 : st.size;
                const t = new Date(st.mtimeMs);
                return { dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0, rdev: 0, size, atime: t, mtime: t, ctime: t, blksize: 4096, blocks: Math.ceil(size / 4096) };
            },
            setattr(node: any, attr: { size?: number }) {
                if (attr.size === undefined) return;   // modes and times are the reader's, not the agent's
                const w = node.writer;
                if (w) { flush(w); put(w, () => req("truncate", [w.wfd, attr.size])); w.size = attr.size; return; }
                const p = pathOf(node);
                once((txn) => {
                    const { wfd } = req("openWrite", [p, "r+", txn]);
                    req("truncate", [wfd, attr.size]);
                    req("closeWrite", [wfd]);
                });
                stale(node);
            },
            lookup(parent: any, name: string) {
                const p = join(pathOf(parent), name);
                const st = (parent.kids?.get(name) as Stat | undefined) ?? (req("stat", [p]) as Stat);
                return makeNode(parent, name, st);
            },
            mknod(parent: any, name: string, mode: number) {
                const p = join(pathOf(parent), name);
                if (!writable(p)) throw new FS.ErrnoError(ERRNO_CODES.EROFS);
                const now = Date.now();
                if (FS.isDir(mode)) {
                    once((txn) => req("mkdir", [p, txn]));
                    parent.kids = null;
                    return makeNode(parent, name, { kind: "dir", size: 0, mtimeMs: now, hidden: false, readonly: false });
                }
                // A new file exists for the reader only once a stream writes it: the open that follows asks for "w".
                const node = makeNode(parent, name, { kind: "file", size: 0, mtimeMs: now, hidden: false, readonly: false });
                node.fresh = true;
                parent.kids = null;
                return node;
            },
            rename(old: any, newDir: any, newName: string) {
                const from = pathOf(old);
                const to = join(pathOf(newDir), newName);
                once((txn) => req("rename", [from, to, txn]));
                old.parent.kids = null; newDir.kids = null;
            },
            unlink(parent: any, name: string) {
                once((txn) => req("unlink", [join(pathOf(parent), name), txn]));
                parent.kids = null;
            },
            rmdir(parent: any, name: string) {
                once((txn) => req("rmdir", [join(pathOf(parent), name), txn]));
                parent.kids = null;
            },
            readdir(node: any) {
                const p = pathOf(node);
                const kids = new Map<string, Stat>();
                let cursor: string | undefined;
                do {
                    const page = req("opendir", [p, { limit: 1000, ...(cursor ? { cursor } : {}) }]) as { entries: Array<{ name: string } & Stat>; next?: string };
                    for (const e of page.entries) kids.set(e.name, e);
                    cursor = page.next;
                } while (cursor);
                node.kids = kids;
                return [".", "..", ...kids.keys()];
            },
            symlink() { throw new FS.ErrnoError(ERRNO_CODES.EPERM); },
            readlink() { throw new FS.ErrnoError(ERRNO_CODES.EINVAL); },
        },
        stream_ops: {
            open(stream: any) {
                const node = stream.node;
                if (FS.isDir(node.mode)) return;
                const p = pathOf(node);
                if ((stream.flags & O_ACCMODE) === 0) {
                    const r = req("open", [p]) as { fd: number; size: number };
                    stream.fd_ = r.fd; stream.size = r.size;
                    return;
                }
                if (!writable(p)) throw new FS.ErrnoError(ERRNO_CODES.EROFS);
                if (node.writer) throw new FS.ErrnoError(ERRNO_CODES.EBUSY);   // one writer per file in a mount
                const flag = node.fresh || stream.flags & O_TRUNC ? "w" : stream.flags & O_APPEND ? "a" : "r+";
                const txn = req("begin", []) as number;
                let w: { wfd: number; size: number };
                try { w = req("openWrite", [p, flag, txn]); }
                catch (e) { try { req("abortTx", [txn]); } catch { /* */ } throw e; }
                node.fresh = false;
                stream.wfd = w.wfd; stream.txn = txn; stream.size = w.size; stream.wbuf = null;
                node.writer = stream;
            },
            close(stream: any) {
                const node = stream.node;
                if (stream.fd_ !== undefined) { dropCache(stream.fd_); try { req("close", [stream.fd_]); } catch { /* closed by its channel */ } return; }
                if (stream.wfd === undefined) return;
                node.writer = null;
                const p = pathOf(node);
                // RULING 75: a file commits when it is closed. A close that cannot commit aborts, so no txn outlives it;
                // a writer a refused change failed aborts without a word, its errno already raised where it happened.
                if (stream.failed) {
                    try { req("abortTx", [stream.txn]); } catch (a) { deps.onLost?.(p, String((a as Error)?.message ?? a)); }
                    stale(node);
                    return;
                }
                try {
                    flush(stream);
                    req("closeWrite", [stream.wfd]);
                    req("commitTx", [stream.txn]);
                } catch (e) {
                    try { req("abortTx", [stream.txn]); } catch (a) { deps.onLost?.(p, String((a as Error)?.message ?? a)); }
                    throw e;
                } finally { stale(node); }
            },
            read(stream: any, buffer: Uint8Array, offset: number, length: number, position: number): number {
                if (stream.wfd !== undefined) {
                    // Through the writer: its pending part, uncached, after this stream's own coalesced bytes.
                    flush(stream);
                    let got = 0;
                    while (got < length) {
                        const n = req("read", [stream.wfd, position + got, Math.min(FILES_CHUNK, length - got)]) as number;
                        if (!n) break;
                        buffer.set(data.subarray(0, n), offset + got);
                        got += n;
                    }
                    return got;
                }
                let got = 0;
                while (got < length) {
                    const at = position + got;
                    if (at >= stream.size) break;
                    const index = Math.floor(at / FILES_CHUNK), within = at - index * FILES_CHUNK;
                    const c = chunk(stream.fd_, index);
                    if (within >= c.n) break;
                    const k = Math.min(c.n - within, length - got);
                    buffer.set(c.buf.subarray(within, within + k), offset + got);
                    got += k;
                }
                return got;
            },
            write(stream: any, buffer: Uint8Array, offset: number, length: number, position: number): number {
                if (stream.wfd === undefined) throw new FS.ErrnoError(ERRNO_CODES.EBADF);
                if (stream.failed) throw new FS.ErrnoError(stream.failed);
                const src = buffer.subarray(offset, offset + length);
                let w = stream.wbuf;
                if (w && w.len && position !== w.pos + w.len) flush(stream);
                if (length >= FILES_CHUNK) {
                    flush(stream);
                    for (let i = 0; i < length; i += FILES_CHUNK) put(stream, () => req("write", [stream.wfd, position + i, Math.min(FILES_CHUNK, length - i)], src.subarray(i, i + FILES_CHUNK)));
                } else {
                    w = stream.wbuf ??= { pos: 0, len: 0, buf: new Uint8Array(FILES_CHUNK) };
                    if (w.len + length > FILES_CHUNK) flush(stream);
                    if (!w.len) w.pos = position;
                    w.buf.set(src, w.len);
                    w.len += length;
                }
                stream.size = Math.max(stream.size, position + length);
                return length;
            },
            llseek(stream: any, offset: number, whence: number): number {
                const base = whence === 1 ? stream.position : whence === 2 ? stream.size : 0;
                const at = base + offset;
                if (at < 0) throw new FS.ErrnoError(ERRNO_CODES.EINVAL);
                return at;
            },
        },
    };

    /**
     * At a cell's start: drop what the last cell's session left in the mount (its nodes and stats, the read cache) and
     * mount afresh. Open streams keep their descriptors, which the channel judges against the new cell's session.
     */
    function remount() {
        dropCache();
        try { FS.unmount(FILES_AT); } catch { /* not mounted yet */ }
        FS.mkdirTree(FILES_AT);
        FS.mount(type, {}, FILES_AT);
    }
    return { type, remount, stats, flush };
}

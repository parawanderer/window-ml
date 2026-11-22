// ranged-reader.ts — the ONE ranged reader under `/files` (FILE_ATTACHMENTS.md, "`/files/` read by range, and
// `ml.fs`", slice 1): a session's files read by range through channels, nothing loaded whole, for every front end.

import { maskOverlap, maskSecretBytes, type SecretForm } from "../secret-mask";
import { FILES_CHUNK, type DirPage, type FileStat, type FilesChannel, type FsError, type FsErrorCode, type Txn, type WriteFlags } from "../python/files-reader";

/** One file the person attached to a session, as the shelf holds it: what the reader lists under `attached/<handle>/<name>`. */
export interface AttachedFile {
    /** The file's handle, the `@file:` id without its prefix: the folder it is listed in. */
    handle: string;
    /** Its cleaned name, the one entry in that folder. */
    name: string;
    /** The value-store key of its bytes. */
    key: string;
    bytes: number;
    /** The SHA-256 of its bytes: an attachment never changes, so this is its version. */
    sha256: string;
    /** When it was attached, ms since the epoch. */
    attachedMs: number;
}

/** Where the reader's bytes come from: the shelf's files for a session, and a stored Blob by key. A Blob holds no bytes
 *  until a range of it is read, so a source never loads a file to answer either. */
export interface FilesSource {
    /** The files `session` holds, in any order; empty for a session that holds none. */
    attached(session: string): Promise<readonly AttachedFile[]>;
    /** The stored bytes under `key`, for a session that holds them; throws when they are gone or not the session's. */
    blob(key: string, session: string): Promise<Blob>;
    /** The secrets' forms now, asked at every read so a value registered mid-session masks the next one; throws when
     *  they cannot be read, and the read then fails rather than serve unmasked bytes. */
    secretForms(): Promise<readonly SecretForm[]>;
}

/** Whether a path of a session's files is hidden (POLICIES.md, "Hiding files", ruling 34): asked at every open and
 *  every read, so a mark made mid-session stops reads through a descriptor already open. */
export type HideRule = (session: string, path: string) => boolean;

/** The volumes a channel may be opened on: `files` now; `history` (SESSION_HISTORY_STORE.md §6b) once it has one. */
export type VolumeName = "files";

/** Where a run writes and Python's working directory (ruling 86). */
export const FILES_HOME = "/files/agent";

/** The most entries one directory page holds, whatever the caller asks: a page must fit one sealed hub message. */
export const DIR_PAGE_MAX = 500;

/** The cursor's prefix: a page's `next` is this and the last name it listed. */
const CURSOR = "c:";

/** A node of a volume, as a channel resolves a path: a directory, or a file whose bytes are a Blob read by range. */
interface VNode {
    kind: "file" | "dir";
    size: number;
    mtimeMs: number;
    birthtimeMs: number;
    readonly: boolean;
    /** A file's version, which an open pins. */
    version?: string;
    /** A file's bytes. */
    blob?: () => Promise<Blob>;
    /** A directory's entries, by name. */
    children?: () => Promise<string[]>;
}

/** A volume: the tree a channel reads, resolved one path at a time for one session. `/history/` is a second one. */
interface Volume {
    /** The node at a canonical path, or null when there is none. Throws ENOTDIR when a file is passed through. */
    node(session: string, path: string): Promise<VNode | null>;
}

/** A Node-shaped error, the only thing a refused call rejects with. Its message names the call and the path as the
 *  caller spelled it, never a key, a server or anything the source said. */
function fsError(code: FsErrorCode, syscall: string, path?: string, message?: string): FsError {
    return { code, syscall, ...(path === undefined ? {} : { path }), message: message ?? `${code}: ${syscall}${path === undefined ? "" : ` '${path}'`}` };
}

/** Whether a value is an error this module made, so a source's own error is never passed through. */
function isFsError(e: unknown): e is FsError {
    return !!e && typeof e === "object" && typeof (e as FsError).code === "string" && typeof (e as FsError).syscall === "string" && !(e instanceof Error);
}

/**
 * A session-relative path as the reader accepts it: `""` for the root, else segments joined by `/`, none empty, `.`
 * or `..`, no leading or trailing slash. Anything else is ENOENT, as a path that names no file is: the front end
 * canonicalises, and the reader never resolves a path on a caller's behalf.
 * @param p the path
 * @param syscall the call, for the error
 */
function canonical(p: unknown, syscall: string): string {
    if (typeof p !== "string" || p.startsWith("/") || p.endsWith("/") || p.includes("\0")) throw fsError("ENOENT", syscall, typeof p === "string" ? p : undefined);
    if (p === "") return p;
    for (const seg of p.split("/")) if (seg === "" || seg === "." || seg === "..") throw fsError("ENOENT", syscall, p);
    return p;
}

/**
 * The `files` volume over the shelf: the root holds `attached/` and `agent/`; `attached/<handle>/` holds that
 * attachment, read-only; `agent/` is the run's own space, empty until the write side lands (slice 3). A folder's
 * times are its newest attachment's, or the reader's start when there is none.
 */
function filesVolume(source: FilesSource, startedMs: number): Volume {
    const dir = (mtimeMs: number, readonly: boolean, children: () => Promise<string[]>): VNode =>
        ({ kind: "dir", size: 0, mtimeMs, birthtimeMs: mtimeMs, readonly, children });
    return {
        async node(session, path) {
            const files = await source.attached(session);
            const newest = files.reduce((m, f) => Math.max(m, f.attachedMs), 0) || startedMs;
            if (path === "") return dir(newest, true, async () => ["agent", "attached"]);
            if (path === "agent") return dir(startedMs, false, async () => []);
            if (path === "attached") return dir(newest, true, async () => [...new Set(files.map((f) => f.handle))]);
            const [top, handle, name, ...rest] = path.split("/");
            if (top !== "attached") return null;
            const f = files.find((g) => g.handle === handle);
            if (!f) return null;
            if (name === undefined) return dir(f.attachedMs, true, async () => [f.name]);
            if (name !== f.name) return null;
            if (rest.length) throw fsError("ENOTDIR", "stat", path);
            return { kind: "file", size: f.bytes, mtimeMs: f.attachedMs, birthtimeMs: f.attachedMs, readonly: true, version: f.sha256, blob: () => source.blob(f.key, session) };
        },
    };
}

/** An open read descriptor: the session it was opened under, the path, and the version it pinned. */
interface ReadFd {
    session: string;
    path: string;
    node: VNode;
    blob: Blob;
}

/** What the reader needs: its source, the hide rule, and a clock. */
export interface RangedReaderDeps {
    source: FilesSource;
    hidden?: HideRule;
    now?: () => number;
}

/**
 * The ranged reader: one per offscreen document, handing out a channel per front end connection. Every descriptor and
 * transaction belongs to the channel that made it and the session it was made under; the channel's end closes them.
 * Bytes are read by range from stored Blobs into the caller's buffer, never a whole file and never a buffer per chunk.
 * The write side answers EROFS until slice 3 (ruling 54).
 */
export class RangedReader {
    private readonly volumes: Record<VolumeName, Volume>;
    private readonly hidden: HideRule;
    private readonly source: FilesSource;
    /** Descriptor and transaction numbers, shared by every channel, so a number from one channel is never valid in another. */
    private nextId = 3; // state: plumbing

    constructor(deps: RangedReaderDeps) {
        const startedMs = (deps.now ?? Date.now)();
        this.volumes = { files: filesVolume(deps.source, startedMs) };
        this.hidden = deps.hidden ?? (() => false);
        this.source = deps.source;
    }

    /**
     * A channel on a volume, with no session until the offscreen document sets one.
     * @param volume which tree it reads
     */
    openChannel(volume: VolumeName): FilesChannel {
        const vol = this.volumes[volume];
        if (!vol) throw new Error(`no volume ${String(volume)}`);
        return this.channel(vol);
    }

    /** {@link openChannel}'s channel, over a resolved volume. */
    private channel(vol: Volume): FilesChannel {
        const reader = this;
        let session: string | null = null;
        let disposed = false;
        const fds = new Map<number, ReadFd>(); // state: plumbing — the channel's open descriptors, closed at its end
        const txns = new Map<Txn, string>(); // state: plumbing — the channel's open transactions, by session

        /** The session, or EBADF when there is none or the channel has ended. */
        const live = (syscall: string): string => {
            if (disposed || session === null) throw fsError("EBADF", syscall, undefined, "no session");
            return session;
        };
        /** Run `fn` for the current session; every rejection is an {@link FsError}, never a source's error. */
        const call = async <T>(syscall: string, fn: (s: string) => Promise<T> | T): Promise<T> => {
            const s = live(syscall);
            try { return await fn(s); } catch (e) { throw isFsError(e) ? e : fsError("EIO", syscall, undefined, `EIO: ${syscall}: the file's bytes could not be read`); }
        };
        const fdOf = (s: string, fd: number, syscall: string): ReadFd => {
            const f = fds.get(fd);
            if (!f || f.session !== s) throw fsError("EBADF", syscall, undefined, `bad descriptor ${fd}`);
            return f;
        };
        const txnOf = (s: string, t: unknown, syscall: string): Txn => {
            if (typeof t !== "number" || txns.get(t) !== s) throw fsError("EBADF", syscall, undefined, `bad transaction ${String(t)}`);
            return t;
        };
        /** Resolve a path, translating a pass-through-a-file into this call's ENOTDIR. */
        const resolve = async (s: string, p: string, syscall: string): Promise<VNode | null> => {
            try { return await vol.node(s, p); } catch (e) { if (isFsError(e) && e.code === "ENOTDIR") throw fsError("ENOTDIR", syscall, p); throw e; }
        };
        const statOf = (s: string, p: string, n: VNode): FileStat =>
            ({ kind: n.kind, size: n.size, mtimeMs: n.mtimeMs, birthtimeMs: n.birthtimeMs, hidden: reader.hidden(s, p), readonly: n.readonly });
        const hiddenRefusal = (syscall: string, p: string): FsError => fsError("EACCES", syscall, p, `EACCES: '${p}' is hidden`);
        /** A write verb's answer until the write side lands: the path checked as any call checks it, then EROFS. */
        const readOnly = async (syscall: string, path: unknown, t: unknown): Promise<never> => call(syscall, (s) => {
            txnOf(s, t, syscall);
            const p = canonical(path, syscall);
            throw fsError("EROFS", syscall, p, "read-only file system");
        });

        return {
            get home() { return session === null || disposed ? undefined : FILES_HOME; },
            setSession(hash) {
                if (disposed) return;
                const next = typeof hash === "string" && hash ? hash : null;
                // A session change closes what the channel had open, so a descriptor never comes back to life.
                if (next !== session) { fds.clear(); txns.clear(); }
                session = next;
            },
            stat: (path, opts) => call("stat", async (s) => {
                if (opts?.txn != null) txnOf(s, opts.txn, "stat");
                const p = canonical(path, "stat");
                const n = await resolve(s, p, "stat");
                if (!n) throw fsError("ENOENT", "stat", p);
                return statOf(s, p, n);
            }),
            opendir: (path, opts) => call("opendir", async (s): Promise<DirPage> => {
                if (opts?.txn != null) txnOf(s, opts.txn, "opendir");
                const p = canonical(path, "opendir");
                const n = await resolve(s, p, "opendir");
                if (!n) throw fsError("ENOENT", "opendir", p);
                if (n.kind !== "dir") throw fsError("ENOTDIR", "opendir", p);
                if (!Number.isInteger(opts?.limit) || opts.limit < 1) throw fsError("EINVAL", "opendir", p);
                let names = (await n.children!()).sort();
                if (opts.cursor !== undefined) {
                    if (typeof opts.cursor !== "string" || !opts.cursor.startsWith(CURSOR)) throw fsError("EINVAL", "opendir", p);
                    const after = opts.cursor.slice(CURSOR.length);
                    names = names.filter((x) => x > after);
                }
                const page = names.slice(0, Math.min(opts.limit, DIR_PAGE_MAX));
                const entries: DirPage["entries"] = [];
                for (const name of page) {
                    const q = p === "" ? name : `${p}/${name}`;
                    const c = await resolve(s, q, "opendir");
                    if (c) entries.push({ name, ...statOf(s, q, c) });
                }
                return { entries, ...(names.length > page.length ? { next: CURSOR + page[page.length - 1] } : {}) };
            }),
            open: (path, opts) => call("open", async (s) => {
                if (opts?.txn != null) txnOf(s, opts.txn, "open");
                const p = canonical(path, "open");
                const n = await resolve(s, p, "open");
                if (!n) throw fsError("ENOENT", "open", p);
                if (n.kind === "dir") throw fsError("EISDIR", "open", p);
                if (reader.hidden(s, p)) throw hiddenRefusal("open", p);
                const blob = await n.blob!();
                // The channel may have ended, or its session changed, while the Blob was found.
                live("open");
                if (session !== s) throw fsError("EBADF", "open", undefined, "no session");
                const fd = reader.nextId++;
                fds.set(fd, { session: s, path: p, node: n, blob });
                return { fd, size: n.size, version: n.version! };
            }),
            read: (fd, position, length, dest) => call("read", async (s) => {
                const f = fdOf(s, fd, "read");
                if (!Number.isInteger(position) || position < 0 || !Number.isInteger(length) || length < 0 || length > FILES_CHUNK || !(dest instanceof Uint8Array)) throw fsError("EINVAL", "read");
                if (reader.hidden(s, f.path)) throw hiddenRefusal("read", f.path);
                const n = Math.min(length, f.blob.size - position, dest.length);
                if (n <= 0) return 0;
                // The scrub inside the mount's read (FILE_ATTACHMENTS.md, "Python's view: two mounts"): the range is
                // read widened on each side by the longest form less one byte, clamped to the file, so a match that
                // overlaps it is seen whole; its bytes become `*`, and only the range is copied out. The forms are held
                // for this read only.
                const forms = await reader.source.secretForms();
                if (!Array.isArray(forms) || forms.some((x) => !x || typeof x.find !== "string")) throw new Error("malformed forms");
                const lap = maskOverlap(forms);
                const from = Math.max(0, position - lap);
                const window = new Uint8Array(await f.blob.slice(from, Math.min(f.blob.size, position + n + lap)).arrayBuffer());
                maskSecretBytes(window, forms);
                const bytes = window.subarray(position - from, position - from + n);
                // A descriptor closed, or a channel ended, while the range was read writes nothing into `dest`: the
                // window may already be another request's.
                if (fds.get(fd) !== f || disposed || session !== s) throw fsError("EBADF", "read", undefined, `bad descriptor ${fd}`);
                dest.set(bytes.subarray(0, n));
                return n;
            }),
            fstat: (fd) => call("fstat", (s) => { const f = fdOf(s, fd, "fstat"); return statOf(s, f.path, f.node); }),
            close: (fd) => call("close", (s) => { fdOf(s, fd, "close"); fds.delete(fd); }),
            begin: () => call("begin", (s) => { const t = reader.nextId++; txns.set(t, s); return t; }),
            openWrite: (path, _flags: WriteFlags, txn) => readOnly("open", path, txn),
            write: (wfd) => call("write", () => { throw fsError("EBADF", "write", undefined, `bad descriptor ${wfd}`); }),
            truncate: (wfd) => call("ftruncate", () => { throw fsError("EBADF", "ftruncate", undefined, `bad descriptor ${wfd}`); }),
            closeWrite: (wfd) => call("close", () => { throw fsError("EBADF", "close", undefined, `bad descriptor ${wfd}`); }),
            rename: async (from, to, txn) => call("rename", (s) => {
                txnOf(s, txn, "rename");
                canonical(to, "rename");
                throw fsError("EROFS", "rename", canonical(from, "rename"), "read-only file system");
            }),
            unlink: (path, txn) => readOnly("unlink", path, txn),
            mkdir: (path, txn) => readOnly("mkdir", path, txn),
            rmdir: (path, txn) => readOnly("rmdir", path, txn),
            commitTx: (txn) => call("commit", (s) => { txns.delete(txnOf(s, txn, "commit")); }),
            abortTx: (txn) => call("abort", (s) => { txns.delete(txnOf(s, txn, "abort")); }),
            dispose() {
                disposed = true;
                session = null;
                fds.clear();
                txns.clear();
            },
        };
    }
}

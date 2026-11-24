// ranged-reader.ts — the ONE ranged reader under `/files` (FILE_ATTACHMENTS.md, "`/files/` read by range, and
// `ml.fs`", slice 1): a session's files read by range through channels, nothing loaded whole, for every front end.

import { maskOverlap, maskSecretBytes, type SecretForm } from "../secret-mask";
import { FILES_CHUNK, type DirPage, type FileStat, type FilesChannel, type FsError, type FsErrorCode, type Txn, type WriteFlags } from "../python/files-reader";
import { AgentFilesError, type AgentFiles, type AgentOp, type LostWrite } from "./agent-files";

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
 *  every read, so a mark made mid-session stops reads through a descriptor already open. A rule that rejects hides the
 *  path: a list that cannot be read never lets a read past it. */
export type HideRule = (session: string, path: string) => boolean | Promise<boolean>;

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

/** What the reader needs of the store of run-made files (agent-files.ts). */
export type AgentStore = Pick<AgentFiles, "node" | "children" | "blob" | "usage" | "commit">;

/** The last segment of a path. */
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * The `files` volume over the shelf: the root holds `attached/` and `agent/`; `attached/<handle>/` holds that
 * attachment, read-only; `agent/` is the run's own space, the files its runs made (`agent`, agent-files.ts), empty
 * where there is no such store. A folder's times are its newest attachment's, or the reader's start when there is none.
 */
function filesVolume(source: FilesSource, startedMs: number, agent?: AgentStore): Volume {
    const dir = (mtimeMs: number, readonly: boolean, children: () => Promise<string[]>): VNode =>
        ({ kind: "dir", size: 0, mtimeMs, birthtimeMs: mtimeMs, readonly, children });
    return {
        async node(session, path) {
            if (path === "agent") return dir(startedMs, false, async () => (agent ? (await agent.children(session, "")).map((n) => baseName(n.path)) : []));
            if (path.startsWith("agent/")) {
                if (!agent) return null;
                const rel = path.slice("agent/".length);
                const n = await agent.node(session, rel);
                if (!n) {
                    // A path through a file is ENOTDIR, as in attached/.
                    for (let up = rel; up.includes("/");) {
                        up = up.slice(0, up.lastIndexOf("/"));
                        const a = await agent.node(session, up);
                        if (a) { if (a.kind === "file") throw fsError("ENOTDIR", "stat", path); break; }
                    }
                    return null;
                }
                if (n.kind === "dir") return dir(n.mtimeMs, false, async () => (await agent.children(session, rel)).map((c) => baseName(c.path)));
                const key = n.blob!;
                return { kind: "file", size: n.size, mtimeMs: n.mtimeMs, birthtimeMs: n.birthtimeMs, readonly: false, version: n.version!, blob: () => agent.blob(key) };
            }
            const files = await source.attached(session);
            const newest = files.reduce((m, f) => Math.max(m, f.attachedMs), 0) || startedMs;
            if (path === "") return dir(newest, true, async () => ["agent", "attached"]);
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

/** What the reader needs: its source, the hide rule, a clock, and for the write side the store of run-made files, the
 *  quota and where a discarded write is reported. With no `agent` store every write answers EROFS. */
export interface RangedReaderDeps {
    source: FilesSource;
    hidden?: HideRule;
    now?: () => number;
    /** Where the files a session's runs make are kept (agent-files.ts). */
    agent?: AgentStore;
    /** The most bytes a session's run-made files may take (the `filesQuotaMB` setting), asked at each `openWrite`. */
    quotaBytes?: (session: string) => Promise<number>;
    /** A file whose pending part was discarded because its channel went with the file not committed. */
    onLost?: (rec: LostWrite) => void;
}

/**
 * What ENOSPC says: the file, the quota, and the two ways out (FILE_ATTACHMENTS.md, "Writes"). The quota is the
 * person's setting, raised only on their word, so the model is told to ask, not to retry.
 */
const noSpace = (w: { path: string; quota: number }): string =>
    `ENOSPC: '${w.path}' would take this session's files past their quota of ${Math.round(w.quota / 1048576)} MiB. Remove files under /files/agent/ (os.remove in Python), or ask the person to raise filesQuotaMB (change_setting).`;

/** A write descriptor: its pending part, the transaction it lands with, and what its file took before (for the quota). */
interface Writer {
    session: string;
    txn: Txn;
    /** The canonical path (`agent/…`). */
    path: string;
    data: Blob;
    /** The file's stored size when it was opened, which its commit replaces. */
    was: number;
    quota: number;
    sealed: boolean;
}

/** One open transaction: its session and its changes in order, a writer standing for its file's put. */
interface TxnState { session: string; items: Array<Writer | AgentOp> }

/**
 * Whether a transaction's own queued changes leave `dir` (relative to `agent/`) a folder: true after its mkdir, false
 * after its rmdir or a rename away, the stored path it was renamed from when what is stored there decides, and
 * undefined when the transaction did not touch it and what is stored decides.
 */
function pendingDir(items: TxnState["items"], dir: string): boolean | string | undefined {
    let made: boolean | string | undefined;
    for (const [k, i] of items.entries()) {
        if ("sealed" in i) continue;
        if (i.op === "mkdir" && i.path === dir) made = true;
        else if (i.op === "rmdir" && i.path === dir) made = false;
        else if (i.op === "rename" && i.from === dir) made = false;
        // A rename onto it: `dir` is now what `from` was at that point of the transaction.
        else if (i.op === "rename" && i.to === dir) made = pendingDir(items.slice(0, k), i.from) ?? i.from;
    }
    return made;
}

/** Zeros, a chunk at a time, for a write past the end or a truncate that grows: a Blob of references, never a whole buffer. */
const ZERO_CHUNK = new Blob([new Uint8Array(FILES_CHUNK)]);
function zeros(n: number): Blob {
    const parts: Blob[] = [];
    for (; n > FILES_CHUNK; n -= FILES_CHUNK) parts.push(ZERO_CHUNK);
    if (n > 0) parts.push(ZERO_CHUNK.slice(0, n));
    return new Blob(parts);
}

/** `data` with `bytes` written at `position`: slices of the old Blob around the new bytes, zero-filled past the end. */
function overwrite(data: Blob, position: number, bytes: Uint8Array): Blob {
    const head = position <= data.size ? data.slice(0, position) : new Blob([data, zeros(position - data.size)]);
    return new Blob([head, bytes as BlobPart, data.slice(position + bytes.length)]);
}

/**
 * The ranged reader: one per offscreen document, handing out a channel per front end connection. Every descriptor and
 * transaction belongs to the channel that made it and the session it was made under; the channel's end closes them.
 * Bytes are read by range from stored Blobs into the caller's buffer, never a whole file and never a buffer per chunk.
 * Writes land under `agent/` only, in the store of run-made files, each transaction at its commit; with no store, or
 * anywhere else, a write answers EROFS.
 */
export class RangedReader {
    private readonly volumes: Record<VolumeName, Volume>;
    private readonly hidden: HideRule;
    private readonly source: FilesSource;
    /** Descriptor and transaction numbers, shared by every channel, so a number from one channel is never valid in another. */
    private nextId = 3; // state: plumbing

    constructor(deps: RangedReaderDeps) {
        const startedMs = (deps.now ?? Date.now)();
        this.volumes = { files: filesVolume(deps.source, startedMs, deps.agent) };
        this.hidden = deps.hidden ?? (() => false);
        this.source = deps.source;
        this.deps = deps;
    }

    private readonly deps: RangedReaderDeps;
    /** Every open writer, by session, across channels: what the quota adds to the stored files. */
    private readonly writers = new Map<string, Set<Writer>>(); // state: plumbing — pending parts, gone with their channel
    /**
     * Each session's stored total: read at each `openWrite`, and again after each commit succeeds. A commit's own quota
     * check uses the figure already here; what another channel committed since is caught by the store's `maxBytes`.
     */
    private readonly stored = new Map<string, number>(); // state: cache — re-read from agent-files at every open and after every commit

    /** Whether `w` growing to `size` keeps its session within its quota, with every other pending part counted. */
    private fits(w: Writer, size: number): boolean {
        let total = this.stored.get(w.session) ?? 0;
        for (const o of this.writers.get(w.session) ?? []) total += (o === w ? size : o.data.size) - o.was;
        return total <= w.quota;
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
        /** The rule's answer for one path, hidden when the rule throws or rejects. */
        const isHidden = async (s: string, p: string): Promise<boolean> => { try { return await reader.hidden(s, p); } catch { return true; } };
        const statOf = async (s: string, p: string, n: VNode): Promise<FileStat> =>
            ({ kind: n.kind, size: n.size, mtimeMs: n.mtimeMs, birthtimeMs: n.birthtimeMs, hidden: await isHidden(s, p), readonly: n.readonly });
        const hiddenRefusal = (syscall: string, p: string): FsError => fsError("EACCES", syscall, p, `EACCES: '${p}' is hidden`);
        const wfds = new Map<number, Writer>(); // state: plumbing — the channel's write descriptors, discarded at its end
        const txs = new Map<Txn, TxnState>(); // state: plumbing — what each open transaction will commit
        const agent = reader.deps.agent;
        /** A path a write may name: under `agent/`, with a store to keep it; else EROFS (the root, `attached/`). Hidden is EACCES. */
        const writable = async (s: string, path: unknown, syscall: string): Promise<string> => {
            const p = canonical(path, syscall);
            if (!agent || !p.startsWith("agent/")) throw fsError("EROFS", syscall, p, "read-only file system");
            if (await isHidden(s, p)) throw hiddenRefusal(syscall, p);
            return p;
        };
        const stateOf = (s: string, t: unknown, syscall: string): TxnState => {
            const id = txnOf(s, t, syscall);
            let st = txs.get(id);
            if (!st) txs.set(id, st = { session: s, items: [] });
            return st;
        };
        const writerOf = (s: string, wfd: unknown, syscall: string): Writer => {
            const w = typeof wfd === "number" ? wfds.get(wfd) : undefined;
            if (!w || w.session !== s || w.sealed) throw fsError("EBADF", syscall, undefined, `bad descriptor ${String(wfd)}`);
            return w;
        };
        const forget = (w: Writer) => { reader.writers.get(w.session)?.delete(w); };
        /** Drop a transaction's pending parts, the files still open and the ones sealed by their close alike; `lost`
         *  reports each file, as a channel's end does. */
        const discard = (id: Txn, lost: boolean) => {
            const st = txs.get(id);
            txs.delete(id);
            txns.delete(id);
            for (const [fd, w] of wfds) if (w.txn === id) wfds.delete(fd);
            for (const w of st?.items ?? []) {
                if (!("sealed" in w)) continue;
                forget(w);
                if (lost) { try { reader.deps.onLost?.({ session: w.session, path: w.path, at: (reader.deps.now ?? Date.now)(), reason: "channel-ended" }); } catch { /* a report must not stop the end */ } }
            }
            return st;
        };
        /** A change of names: checked as a write is, then kept for the commit, which checks it against what is stored. */
        const change = (syscall: string, t: unknown, op: (s: string) => Promise<AgentOp>) => call(syscall, async (s) => {
            txnOf(s, t, syscall);
            const o = await op(s);
            // The rule was asked meanwhile: the transaction, or the channel's session, may have gone.
            live(syscall);
            stateOf(s, t, syscall).items.push(o);
        });
        const rel = (p: string) => p.slice("agent/".length);

        return {
            get home() { return session === null || disposed ? undefined : FILES_HOME; },
            setSession(hash) {
                if (disposed) return;
                const next = typeof hash === "string" && hash ? hash : null;
                // A session change closes what the channel had open, so a descriptor never comes back to life; a file
                // not committed is discarded and reported, as at the channel's end.
                if (next !== session) { for (const id of [...txs.keys()]) discard(id, true); fds.clear(); txns.clear(); }
                session = next;
            },
            stat: (path, opts) => call("stat", async (s) => {
                if (opts?.txn != null) txnOf(s, opts.txn, "stat");
                const p = canonical(path, "stat");
                const n = await resolve(s, p, "stat");
                if (!n) throw fsError("ENOENT", "stat", p);
                return await statOf(s, p, n);
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
                    if (c) entries.push({ name, ...await statOf(s, q, c) });
                }
                return { entries, ...(names.length > page.length ? { next: CURSOR + page[page.length - 1] } : {}) };
            }),
            open: (path, opts) => call("open", async (s) => {
                if (opts?.txn != null) txnOf(s, opts.txn, "open");
                const p = canonical(path, "open");
                const n = await resolve(s, p, "open");
                if (!n) throw fsError("ENOENT", "open", p);
                if (n.kind === "dir") throw fsError("EISDIR", "open", p);
                if (await isHidden(s, p)) throw hiddenRefusal("open", p);
                const blob = await n.blob!();
                // The channel may have ended, or its session changed, while the Blob was found.
                live("open");
                if (session !== s) throw fsError("EBADF", "open", undefined, "no session");
                const fd = reader.nextId++;
                fds.set(fd, { session: s, path: p, node: n, blob });
                return { fd, size: n.size, version: n.version! };
            }),
            read: (fd, position, length, dest) => call("read", async (s) => {
                const w = wfds.get(fd);
                const f: { path: string; blob: Blob } = w && w.session === s ? { path: w.path, get blob() { return w.data; } } : fdOf(s, fd, "read");
                if (!Number.isInteger(position) || position < 0 || !Number.isInteger(length) || length < 0 || length > FILES_CHUNK || !(dest instanceof Uint8Array)) throw fsError("EINVAL", "read");
                if (await isHidden(s, f.path)) throw hiddenRefusal("read", f.path);
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
                if ((w ? wfds.get(fd) !== w : fds.get(fd) !== f) || disposed || session !== s) throw fsError("EBADF", "read", undefined, `bad descriptor ${fd}`);
                dest.set(bytes.subarray(0, n));
                return n;
            }),
            fstat: (fd) => call("fstat", async (s) => {
                const w = wfds.get(fd);
                if (w && w.session === s) return { kind: "file" as const, size: w.data.size, mtimeMs: (reader.deps.now ?? Date.now)(), birthtimeMs: 0, hidden: await isHidden(s, w.path), readonly: false };
                const f = fdOf(s, fd, "fstat");
                return statOf(s, f.path, f.node);
            }),
            close: (fd) => call("close", (s) => { fdOf(s, fd, "close"); fds.delete(fd); }),
            begin: () => call("begin", (s) => { const t = reader.nextId++; txns.set(t, s); return t; }),
            openWrite: (path, flags: WriteFlags, txn) => call("open", async (s) => {
                const st = stateOf(s, txn, "open");
                const p = await writable(s, path, "open");
                if (!["w", "a", "r+", "x"].includes(flags)) throw fsError("EINVAL", "open", p);
                const n = await resolve(s, p, "open");
                if (n?.kind === "dir") throw fsError("EISDIR", "open", p);
                if (n && flags === "x") throw fsError("EEXIST", "open", p);
                if (!n) {
                    if (flags === "r+") throw fsError("ENOENT", "open", p);
                    // A folder this transaction made counts: its commit applies the mkdir before the file.
                    const parent = p.slice(0, p.lastIndexOf("/"));
                    const made = pendingDir(st.items, rel(parent));
                    const up = made === undefined ? await resolve(s, parent, "open") : typeof made === "string" ? await resolve(s, `agent/${made}`, "open") : made ? { kind: "dir" } : null;
                    if (!up) throw fsError("ENOENT", "open", p);
                    if (up.kind !== "dir") throw fsError("ENOTDIR", "open", p);
                }
                const data = n && flags !== "w" ? await n.blob!() : new Blob([]);
                const quota = await (reader.deps.quotaBytes ?? (async () => Infinity))(s);
                reader.stored.set(s, await agent!.usage(s));
                live("open");
                if (session !== s || txs.get(txn) !== st) throw fsError("EBADF", "open", undefined, "no session");
                const w: Writer = { session: s, txn, path: p, data, was: n?.size ?? 0, quota, sealed: false };
                const wfd = reader.nextId++;
                wfds.set(wfd, w);
                st.items.push(w);
                let set = reader.writers.get(s);
                if (!set) reader.writers.set(s, set = new Set());
                set.add(w);
                return { wfd, size: data.size };
            }),
            write: (wfd, position, bytes) => call("write", (s) => {
                const w = writerOf(s, wfd, "write");
                if (!Number.isInteger(position) || position < 0 || !(bytes instanceof Uint8Array) || bytes.length > FILES_CHUNK) throw fsError("EINVAL", "write", w.path);
                const size = Math.max(w.data.size, position + bytes.length);
                if (!reader.fits(w, size)) throw fsError("ENOSPC", "write", w.path, noSpace(w));
                // A copy: the caller's buffer is reused for the next chunk.
                w.data = overwrite(w.data, position, bytes.slice());
            }),
            truncate: (wfd, length) => call("ftruncate", (s) => {
                const w = writerOf(s, wfd, "ftruncate");
                if (!Number.isInteger(length) || length < 0) throw fsError("EINVAL", "ftruncate", w.path);
                if (!reader.fits(w, length)) throw fsError("ENOSPC", "ftruncate", w.path, noSpace(w));
                w.data = length <= w.data.size ? w.data.slice(0, length) : new Blob([w.data, zeros(length - w.data.size)]);
            }),
            closeWrite: (wfd) => call("close", (s) => {
                const w = writerOf(s, wfd, "close");
                w.sealed = true;
                wfds.delete(wfd as number);
            }),
            rename: (from, to, txn) => change("rename", txn, async (s) => {
                const a = await writable(s, from, "rename"), b = await writable(s, to, "rename");
                return { op: "rename", from: rel(a), to: rel(b) };
            }),
            unlink: (path, txn) => change("unlink", txn, async (s) => ({ op: "unlink", path: rel(await writable(s, path, "unlink")) })),
            mkdir: (path, txn) => change("mkdir", txn, async (s) => {
                const p = canonical(path, "mkdir");
                if (p === "agent") throw fsError("EEXIST", "mkdir", p);
                return { op: "mkdir", path: rel(await writable(s, p, "mkdir")) };
            }),
            rmdir: (path, txn) => change("rmdir", txn, async (s) => ({ op: "rmdir", path: rel(await writable(s, path, "rmdir")) })),
            commitTx: (txn) => call("commit", async (s) => {
                const id = txnOf(s, txn, "commit");
                const st = txs.get(id);
                if (!st?.items.length) { discard(id, false); return; }
                // A file still open has nothing to commit yet: it commits at its close (ruling 75).
                if (st.items.some((i) => "sealed" in i && !i.sealed)) throw fsError("EINVAL", "commit", undefined, "EINVAL: a file of this transaction is still open");
                const writers = st.items.filter((i): i is Writer => "sealed" in i);
                for (const w of writers) if (!reader.fits(w, w.data.size)) throw fsError("ENOSPC", "commit", w.path, noSpace(w));
                // The hide rule again: a path hidden since its file was opened is not written, as it is no longer read.
                for (const i of st.items) {
                    const named = "sealed" in i ? [i.path] : i.op === "rename" ? [`agent/${i.from}`, `agent/${i.to}`] : [`agent/${i.path}`];
                    for (const p of named) if (await isHidden(s, p)) throw hiddenRefusal("commit", p);
                }
                live("commit");
                if (txs.get(id) !== st) throw fsError("EBADF", "commit", undefined, `bad transaction ${String(txn)}`);
                const ops: AgentOp[] = st.items.map((i) => ("sealed" in i ? { op: "put", path: rel(i.path), data: i.data } : i));
                txs.delete(id);
                txns.delete(id);
                // The quota again, inside the store's transaction: what another channel committed since this one's
                // files were opened counts.
                const quota = writers.length ? Math.min(...writers.map((w) => w.quota)) : undefined;
                try { await agent!.commit(s, ops, quota !== undefined && Number.isFinite(quota) ? { maxBytes: quota } : {}); }
                catch (e) {
                    for (const w of writers) forget(w);
                    if (e instanceof AgentFilesError && e.code === "ENOSPC") throw fsError("ENOSPC", "commit", `agent/${e.path}`, noSpace({ path: `agent/${e.path}`, quota: quota! }));
                    if (e instanceof AgentFilesError) throw fsError(e.code, "commit", `agent/${e.path}`);
                    throw e;
                }
                // What is stored now, for every other pending part's next chunk: the store's figure, or, when it cannot
                // be read, the last one plus what this commit grew by, never nothing (which would read as an empty store).
                const grew = writers.reduce((n, w) => n + w.data.size - w.was, 0);
                for (const w of writers) forget(w);
                const now = await agent!.usage(s).catch(() => (reader.stored.get(s) ?? 0) + grew);
                reader.stored.set(s, now);
            }),
            abortTx: (txn) => call("abort", (s) => { discard(txnOf(s, txn, "abort"), false); }),
            dispose() {
                // A file not committed when its channel goes is discarded, and reported (FILE_ATTACHMENTS.md, "A worker
                // evicted mid-file"); the previous version stands.
                for (const id of [...txs.keys()]) discard(id, true);
                disposed = true;
                session = null;
                fds.clear();
                txns.clear();
            },
        };
    }
}

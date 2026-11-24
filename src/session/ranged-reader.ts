// ranged-reader.ts — the ONE ranged reader under `/files` (FILE_ATTACHMENTS.md, "`/files/` read by range, and
// `ml.fs`", slice 1): a session's files read by range through channels, nothing loaded whole, for every front end.

import { maskName, maskOverlap, maskSecretBytes, type SecretForm } from "../secret-mask";
import { GITHUB_TOKEN_PUT } from "../secret-scrub";
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

/** The cursor's prefix: a page's `next` is this, then the last entry it listed as its ordinal among the entries
 *  sharing its shown name, `:`, and that shown name. Never a stored name (FILE_ATTACHMENTS.md, "Names under `/files`"). */
const CURSOR = "c:";

/** A cursor's ordinal and shown name. */
const CURSOR_SHAPE = /^c:(\d{1,6}):([\s\S]*)$/;

/** The markers a name a run makes under `agent/` may not hold unless it names a file already there, besides every
 *  form's own `put`: the shown form of a masked name, which a create would otherwise make a second file under. */
const RESERVED = ["[REDACTED", GITHUB_TOKEN_PUT];

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
    /** The stored path, which the hide rule is asked about. */
    path: string;
    /** The path as the caller wrote it, the only one an error names. */
    given: string;
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
const noSpace = (w: { given: string; quota: number }): string =>
    `ENOSPC: '${w.given}' would take this session's files past their quota of ${Math.round(w.quota / 1048576)} MiB. Remove files under /files/agent/ (os.remove in Python), or ask the person to raise filesQuotaMB (change_setting).`;

/** A write descriptor: its pending part, the transaction it lands with, and what its file took before (for the quota). */
interface Writer {
    session: string;
    txn: Txn;
    /** The stored path (`agent/…`), which the commit writes. */
    path: string;
    /** The path as the caller wrote it, the only one an error or a report names. */
    given: string;
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

    /** A random salt for {@link tie}, drawn once per reader. */
    private readonly salt = crypto.getRandomValues(new Uint32Array(1))[0]; // state: fixed — one per reader life

    /**
     * The last tie-break between entries sharing a shown name and a birth time: a salted hash of the stored name, which
     * orders them the same way through a reader's life and says nothing of how their names compare.
     * @param raw the stored name
     */
    tie(raw: string): number {
        let h = this.salt ^ 0x811c9dc5;
        for (let i = 0; i < raw.length; i++) h = Math.imul(h ^ raw.charCodeAt(i), 0x01000193);
        return h >>> 0;
    }

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
        /** Resolve a stored path, translating a pass-through-a-file into this call's ENOTDIR. */
        const resolve = async (s: string, p: string, syscall: string): Promise<VNode | null> => {
            try { return await vol.node(s, p); } catch (e) { if (isFsError(e) && e.code === "ENOTDIR") throw fsError("ENOTDIR", syscall, p); throw e; }
        };
        /**
         * A path as a caller writes it, resolved to the stored path (FILE_ATTACHMENTS.md, "Names under `/files`"): each
         * segment is the child stored under exactly that name when there is one, else the one child whose SHOWN name
         * ({@link maskName}) it is; two or more is EACCES, naming the path as written and how many. A segment matching
         * nothing is kept as written, so a create makes it. Every error names `p`, never a stored name. The forms are
         * asked only when an exact match misses.
         * @returns the stored path, and its node or null
         */
        const lookup = async (s: string, p: string, syscall: string): Promise<{ path: string; node: VNode | null }> => {
            const direct = await resolve(s, p, syscall).catch((e) => { if (isFsError(e)) throw fsError(e.code, syscall, p); throw e; });
            if (direct || p === "") return { path: p, node: direct };
            const segs = p.split("/");
            let forms: readonly SecretForm[] | undefined;
            let at = "";
            let node: VNode | null = await resolve(s, "", syscall);
            for (const [i, seg] of segs.entries()) {
                if (!node) return { path: [at, ...segs.slice(i)].filter(Boolean).join("/"), node: null };
                if (node.kind !== "dir") throw fsError("ENOTDIR", syscall, p);
                const names = await node.children!();
                let name = seg;
                if (!names.includes(seg)) {
                    forms ??= await formsNow();
                    const hits = names.filter((n) => maskName(n, forms!) === seg);
                    if (hits.length > 1) throw fsError("EACCES", syscall, p, `EACCES: '${p}' is ambiguous, ${hits.length} files`);
                    if (hits.length === 1) name = hits[0];
                }
                at = at ? `${at}/${name}` : name;
                node = await resolve(s, at, syscall).catch((e) => { if (isFsError(e)) throw fsError(e.code, syscall, p); throw e; });
            }
            return { path: at, node };
        };
        /** The rule's answer for one path, hidden when the rule throws or rejects. */
        const isHidden = async (s: string, p: string): Promise<boolean> => { try { return await reader.hidden(s, p); } catch { return true; } };
        /** The secrets' forms now, asked at each call that shows or matches a name; malformed is a failed call. */
        const formsNow = async (): Promise<readonly SecretForm[]> => {
            const forms = await reader.source.secretForms();
            if (!Array.isArray(forms) || forms.some((x) => !x || typeof x.find !== "string")) throw new Error("malformed forms");
            return forms;
        };
        const statOf = async (s: string, p: string, n: VNode): Promise<FileStat> =>
            ({ kind: n.kind, size: n.size, mtimeMs: n.mtimeMs, birthtimeMs: n.birthtimeMs, hidden: await isHidden(s, p), readonly: n.readonly });
        const hiddenRefusal = (syscall: string, p: string): FsError => fsError("EACCES", syscall, p, `EACCES: '${p}' is hidden`);
        const wfds = new Map<number, Writer>(); // state: plumbing — the channel's write descriptors, discarded at its end
        const txs = new Map<Txn, TxnState>(); // state: plumbing — what each open transaction will commit
        const agent = reader.deps.agent;
        /**
         * A path a write may name: under `agent/`, with a store to keep it; else EROFS (the root, `attached/`). Resolved
         * as a read resolves it, so a shown name addresses its file. A path naming no file whose last segment holds a
         * marker a shown name can carry (`[REDACTED`, the GitHub token's, any form's `put`) is EACCES, reserved: it
         * would make a second file under a shown name. Hidden is EACCES.
         * @returns the stored path, the path as written, and the node there or null
         */
        const writable = async (s: string, path: unknown, syscall: string): Promise<{ path: string; given: string; node: VNode | null }> => {
            const given = canonical(path, syscall);
            if (!agent || !given.startsWith("agent/")) throw fsError("EROFS", syscall, given, "read-only file system");
            const { path: p, node } = await lookup(s, given, syscall);
            if (!node) {
                const last = baseName(given);
                const puts = [...RESERVED, ...(await formsNow()).map((f) => f.put).filter((x): x is string => !!x)];
                if (puts.some((m) => last.includes(m))) throw fsError("EACCES", syscall, given, `EACCES: '${given}' is reserved: it holds a marker a masked name is shown with`);
            }
            if (await isHidden(s, p)) throw hiddenRefusal(syscall, given);
            return { path: p, given, node };
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
                if (lost) { try { reader.deps.onLost?.({ session: w.session, path: w.given, at: (reader.deps.now ?? Date.now)(), reason: "channel-ended" }); } catch { /* a report must not stop the end */ } }
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
        /** Each queued change's stored paths and how its call wrote them, for the commit's errors. */
        const givenOf = new WeakMap<AgentOp, Array<[string, string]>>(); // state: plumbing — gone with the op
        const named = (op: AgentOp, ...ends: Array<{ path: string; given: string }>): AgentOp => { givenOf.set(op, ends.map((e) => [e.path, e.given])); return op; };

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
                const { path: q, node: n } = await lookup(s, p, "stat");
                if (!n) throw fsError("ENOENT", "stat", p);
                return await statOf(s, q, n);
            }),
            opendir: (path, opts) => call("opendir", async (s): Promise<DirPage> => {
                if (opts?.txn != null) txnOf(s, opts.txn, "opendir");
                const p = canonical(path, "opendir");
                const { path: dirPath, node: n } = await lookup(s, p, "opendir");
                if (!n) throw fsError("ENOENT", "opendir", p);
                if (n.kind !== "dir") throw fsError("ENOTDIR", "opendir", p);
                if (!Number.isInteger(opts?.limit) || opts.limit < 1) throw fsError("EINVAL", "opendir", p);
                let after: { ord: number; shown: string } | undefined;
                if (opts.cursor !== undefined) {
                    const m = typeof opts.cursor === "string" ? CURSOR_SHAPE.exec(opts.cursor) : null;
                    if (!m) throw fsError("EINVAL", "opendir", p);
                    after = { ord: Number(m[1]), shown: m[2] };
                }
                // Every name is listed as shown, sorted by what is shown: a stored name never decides an order, so a
                // cell cannot read a secret from where its own files sort beside it. Entries sharing a shown name are
                // all listed, in the order they were made (then a salted hash, never the name), and paged by ordinal.
                const forms = await formsNow();
                const stored = await n.children!();
                const kids: Array<{ raw: string; shown: string; node: VNode | null; ord: number }> = [];
                for (const raw of stored) kids.push({ raw, shown: maskName(raw, forms), node: null, ord: 0 });
                const groups = new Map<string, typeof kids>();
                for (const k of kids) { const g = groups.get(k.shown); if (g) g.push(k); else groups.set(k.shown, [k]); }
                for (const g of groups.values()) {
                    if (g.length < 2) continue;
                    for (const k of g) k.node = await resolve(s, dirPath === "" ? k.raw : `${dirPath}/${k.raw}`, "opendir");
                    g.sort((a, b) => (a.node?.birthtimeMs ?? 0) - (b.node?.birthtimeMs ?? 0) || reader.tie(a.raw) - reader.tie(b.raw));
                    g.forEach((k, i) => { k.ord = i; });
                }
                let order = kids.sort((a, b) => (a.shown < b.shown ? -1 : a.shown > b.shown ? 1 : a.ord - b.ord));
                if (after) order = order.filter((k) => k.shown > after!.shown || (k.shown === after!.shown && k.ord > after!.ord));
                const page = order.slice(0, Math.min(opts.limit, DIR_PAGE_MAX));
                const entries: DirPage["entries"] = [];
                for (const k of page) {
                    const q = dirPath === "" ? k.raw : `${dirPath}/${k.raw}`;
                    const c = k.node ?? await resolve(s, q, "opendir");
                    if (c) entries.push({ name: k.shown, ...await statOf(s, q, c) });
                }
                const last = page[page.length - 1];
                return { entries, ...(order.length > page.length ? { next: `${CURSOR}${last.ord}:${last.shown}` } : {}) };
            }),
            open: (path, opts) => call("open", async (s) => {
                if (opts?.txn != null) txnOf(s, opts.txn, "open");
                const p = canonical(path, "open");
                const { path: q, node: n } = await lookup(s, p, "open");
                if (!n) throw fsError("ENOENT", "open", p);
                if (n.kind === "dir") throw fsError("EISDIR", "open", p);
                if (await isHidden(s, q)) throw hiddenRefusal("open", p);
                const blob = await n.blob!();
                // The channel may have ended, or its session changed, while the Blob was found.
                live("open");
                if (session !== s) throw fsError("EBADF", "open", undefined, "no session");
                const fd = reader.nextId++;
                fds.set(fd, { session: s, path: q, given: p, node: n, blob });
                return { fd, size: n.size, version: n.version! };
            }),
            read: (fd, position, length, dest) => call("read", async (s) => {
                const w = wfds.get(fd);
                const f: { path: string; given: string; blob: Blob } = w && w.session === s ? { path: w.path, given: w.given, get blob() { return w.data; } } : fdOf(s, fd, "read");
                if (!Number.isInteger(position) || position < 0 || !Number.isInteger(length) || length < 0 || length > FILES_CHUNK || !(dest instanceof Uint8Array)) throw fsError("EINVAL", "read");
                if (await isHidden(s, f.path)) throw hiddenRefusal("read", f.given);
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
                const { path: p, given, node: n } = await writable(s, path, "open");
                if (!["w", "a", "r+", "x"].includes(flags)) throw fsError("EINVAL", "open", given);
                if (n?.kind === "dir") throw fsError("EISDIR", "open", given);
                if (n && flags === "x") throw fsError("EEXIST", "open", given);
                if (!n) {
                    if (flags === "r+") throw fsError("ENOENT", "open", given);
                    // A folder this transaction made counts: its commit applies the mkdir before the file.
                    const parent = p.slice(0, p.lastIndexOf("/"));
                    const made = pendingDir(st.items, rel(parent));
                    const up = made === undefined ? await resolve(s, parent, "open").catch(() => null) : typeof made === "string" ? await resolve(s, `agent/${made}`, "open").catch(() => null) : made ? { kind: "dir" } : null;
                    if (!up) throw fsError("ENOENT", "open", given);
                    if (up.kind !== "dir") throw fsError("ENOTDIR", "open", given);
                }
                const data = n && flags !== "w" ? await n.blob!() : new Blob([]);
                const quota = await (reader.deps.quotaBytes ?? (async () => Infinity))(s);
                reader.stored.set(s, await agent!.usage(s));
                live("open");
                if (session !== s || txs.get(txn) !== st) throw fsError("EBADF", "open", undefined, "no session");
                const w: Writer = { session: s, txn, path: p, given, data, was: n?.size ?? 0, quota, sealed: false };
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
                if (!Number.isInteger(position) || position < 0 || !(bytes instanceof Uint8Array) || bytes.length > FILES_CHUNK) throw fsError("EINVAL", "write", w.given);
                const size = Math.max(w.data.size, position + bytes.length);
                if (!reader.fits(w, size)) throw fsError("ENOSPC", "write", w.given, noSpace(w));
                // A copy: the caller's buffer is reused for the next chunk.
                w.data = overwrite(w.data, position, bytes.slice());
            }),
            truncate: (wfd, length) => call("ftruncate", (s) => {
                const w = writerOf(s, wfd, "ftruncate");
                if (!Number.isInteger(length) || length < 0) throw fsError("EINVAL", "ftruncate", w.given);
                if (!reader.fits(w, length)) throw fsError("ENOSPC", "ftruncate", w.given, noSpace(w));
                w.data = length <= w.data.size ? w.data.slice(0, length) : new Blob([w.data, zeros(length - w.data.size)]);
            }),
            closeWrite: (wfd) => call("close", (s) => {
                const w = writerOf(s, wfd, "close");
                w.sealed = true;
                wfds.delete(wfd as number);
            }),
            rename: (from, to, txn) => change("rename", txn, async (s) => {
                const a = await writable(s, from, "rename"), b = await writable(s, to, "rename");
                return named({ op: "rename", from: rel(a.path), to: rel(b.path) }, a, b);
            }),
            unlink: (path, txn) => change("unlink", txn, async (s) => { const a = await writable(s, path, "unlink"); return named({ op: "unlink", path: rel(a.path) }, a); }),
            mkdir: (path, txn) => change("mkdir", txn, async (s) => {
                const p = canonical(path, "mkdir");
                if (p === "agent") throw fsError("EEXIST", "mkdir", p);
                const a = await writable(s, p, "mkdir");
                return named({ op: "mkdir", path: rel(a.path) }, a);
            }),
            rmdir: (path, txn) => change("rmdir", txn, async (s) => { const a = await writable(s, path, "rmdir"); return named({ op: "rmdir", path: rel(a.path) }, a); }),
            commitTx: (txn) => call("commit", async (s) => {
                const id = txnOf(s, txn, "commit");
                const st = txs.get(id);
                if (!st?.items.length) { discard(id, false); return; }
                // A file still open has nothing to commit yet: it commits at its close (ruling 75).
                if (st.items.some((i) => "sealed" in i && !i.sealed)) throw fsError("EINVAL", "commit", undefined, "EINVAL: a file of this transaction is still open");
                const writers = st.items.filter((i): i is Writer => "sealed" in i);
                for (const w of writers) if (!reader.fits(w, w.data.size)) throw fsError("ENOSPC", "commit", w.given, noSpace(w));
                // What an error of this commit names for a stored path: the path as its call wrote it.
                const written = new Map<string, string>();
                for (const i of st.items) for (const [k, v] of "sealed" in i ? [[i.path, i.given]] : givenOf.get(i) ?? []) if (!written.has(k)) written.set(k, v);
                const shownPath = (stored: string): string => written.get(stored) ?? "agent/…";
                // The hide rule again: a path hidden since its file was opened is not written, as it is no longer read.
                for (const i of st.items) {
                    const paths = "sealed" in i ? [i.path] : i.op === "rename" ? [`agent/${i.from}`, `agent/${i.to}`] : [`agent/${i.path}`];
                    for (const p of paths) if (await isHidden(s, p)) throw hiddenRefusal("commit", shownPath(p));
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
                    if (e instanceof AgentFilesError && e.code === "ENOSPC") throw fsError("ENOSPC", "commit", shownPath(`agent/${e.path}`), noSpace({ given: shownPath(`agent/${e.path}`), quota: quota! }));
                    if (e instanceof AgentFilesError) throw fsError(e.code, "commit", shownPath(`agent/${e.path}`));
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

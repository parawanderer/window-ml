// agent-files.ts — the files a session's runs keep under `/files/agent/` (FILE_ATTACHMENTS.md, "Writes"): one IndexedDB
// database, opened from any extension realm, holding each file's stored Blob and a node per file and folder.

// The offscreen document's ranged reader writes it (ranged-reader.ts, at a transaction's commit) and reads it; the service
// worker opens the same database to delete a session's files when the session is deleted, and to answer the state
// inspector. A commit is ONE IndexedDB transaction over nodes and blobs, so a file is never half there. A file's version
// is minted at its commit, not hashed: hashing would read the whole file into memory. The person's attachments are not
// here; they are value-store rows (value-store.ts) and do not count toward the quota.

/** The database's name: its own, beside the value store's, so its lifetime (the session's) is not the value store's budget. */
export const AGENT_FILES_DB = "ml-agent-files";

const DB_VERSION = 1;
const NODES = "nodes";
const BLOBS = "blobs";
const LOST = "lost";

/** One file or folder a session's runs made, at `path` relative to `agent/` (`notes/w.npy`; never empty). */
export interface AgentNode {
    session: string;
    path: string;
    /** The folder it is in, relative to `agent/` (`""` for `agent/` itself): the index a listing reads. */
    parent: string;
    kind: "file" | "dir";
    size: number;
    mtimeMs: number;
    birthtimeMs: number;
    /** A file's version, minted at each commit. */
    version?: string;
    /** A file's key in the blob store. */
    blob?: string;
}

/** One change of a commit, applied in order, each against what the ones before it left. */
export type AgentOp =
    | { op: "put"; path: string; data: Blob }
    | { op: "mkdir"; path: string }
    | { op: "rmdir"; path: string }
    | { op: "unlink"; path: string }
    | { op: "rename"; from: string; to: string };

/** A file whose pending part was discarded before it could commit: its writer went (FILE_ATTACHMENTS.md, "A worker evicted mid-file"). */
export interface LostWrite {
    session: string;
    /** The file's path, relative to `/files/` (`agent/w.npy`). */
    path: string;
    at: number;
    /** Why it was discarded: `channel-ended` when the front end's channel closed with the file still open. */
    reason: "channel-ended";
}

/** The most discard notes one session keeps: the newest win. */
export const LOST_KEPT = 50;

/** A commit refused by what is stored: the errno and the path (relative to `agent/`) it names. */
export class AgentFilesError extends Error {
    constructor(readonly code: "ENOENT" | "EEXIST" | "ENOTDIR" | "EISDIR" | "ENOTEMPTY" | "EINVAL" | "ENOSPC", readonly path: string) {
        super(`${code}: ${path}`);
    }
}

/** Settle an IDBRequest as a promise. */
const done = <T>(req: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
/** Settle a transaction as a promise. */
const committed = (tx: IDBTransaction): Promise<void> => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

/** The folder a path is in (`""` for a top-level name). */
export const parentOf = (path: string): string => { const i = path.lastIndexOf("/"); return i < 0 ? "" : path.slice(0, i); };

/** A fresh version or blob key: random, so two commits of one path never share one. */
const mint = (prefix: string): string => prefix + [...crypto.getRandomValues(new Uint8Array(8))].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * THE STORE of a session's run-made files. Every method opens its own transaction, so the service worker and the
 * offscreen document may both use it.
 */
export class AgentFiles {
    private db: Promise<IDBDatabase> | null = null;   // state: cache — a handle to the database
    private readonly idb: IDBFactory | undefined;
    private readonly dbName: string;
    private readonly now: () => number;

    constructor(o: { idb?: IDBFactory; dbName?: string; now?: () => number } = {}) {
        // Resolved at the first open, not here: a realm without IndexedDB may still build the reader that holds this.
        this.idb = o.idb;
        this.dbName = o.dbName ?? AGENT_FILES_DB;
        this.now = o.now ?? Date.now;
    }

    private open(): Promise<IDBDatabase> {
        if (!this.db) this.db = new Promise((res, rej) => {
            const req = (this.idb ?? indexedDB).open(this.dbName, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                const nodes = db.createObjectStore(NODES, { keyPath: ["session", "path"] });
                nodes.createIndex("session", "session");
                nodes.createIndex("parent", ["session", "parent"]);
                db.createObjectStore(BLOBS);
                db.createObjectStore(LOST, { autoIncrement: true }).createIndex("session", "session");
            };
            req.onsuccess = () => res(req.result);
            req.onerror = () => { this.db = null; rej(req.error); };
        });
        return this.db;
    }

    /** The node at `path` (relative to `agent/`), or null. */
    async node(session: string, path: string): Promise<AgentNode | null> {
        const db = await this.open();
        return (await done(db.transaction(NODES).objectStore(NODES).get([session, path])) as AgentNode | undefined) ?? null;
    }

    /** The nodes directly in the folder `dir` (relative to `agent/`, `""` for `agent/` itself). */
    async children(session: string, dir: string): Promise<AgentNode[]> {
        const db = await this.open();
        return await done(db.transaction(NODES).objectStore(NODES).index("parent").getAll([session, dir])) as AgentNode[];
    }

    /** Every node of a session. */
    async all(session: string): Promise<AgentNode[]> {
        const db = await this.open();
        return await done(db.transaction(NODES).objectStore(NODES).index("session").getAll(session)) as AgentNode[];
    }

    /** What a session's files take, at their stored size: what the quota counts. */
    async usage(session: string): Promise<number> {
        return (await this.stats(session)).bytes;
    }

    /**
     * How many files a session's runs made under `agent/`, folders not counted, and what they take: one read of the
     * session's nodes, never a walk of its folders. What the files panel's header shows.
     * @param session the session
     */
    async stats(session: string): Promise<{ files: number; bytes: number }> {
        let files = 0, bytes = 0;
        for (const x of await this.all(session)) if (x.kind === "file") { files++; bytes += x.size; }
        return { files, bytes };
    }

    /** A stored file's bytes, by its node's `blob`. Throws when they are gone. */
    async blob(key: string): Promise<Blob> {
        const db = await this.open();
        const b = await done(db.transaction(BLOBS).objectStore(BLOBS).get(key)) as Blob | undefined;
        if (!b) throw new Error("the file's bytes are gone");
        return b;
    }

    /** Every session that has files here, for the orphan sweep. */
    async sessions(): Promise<string[]> {
        const db = await this.open();
        const keys = await done(db.transaction(NODES).objectStore(NODES).getAllKeys()) as unknown as [string, string][];
        return [...new Set(keys.map((k) => k[0]))];
    }

    /**
     * Apply `ops` for one session as ONE transaction: every change lands, or none does (an error aborts it, and the
     * stored files are as they were). A folder must exist before something is put in it; `agent/` itself always does.
     * The LAST commit of a path wins: a put replaces whatever the path holds now, whoever wrote it. With `maxBytes`, the
     * session's files after the commit are measured inside the same transaction, so a commit landing between this
     * one's check and its write cannot take the session past it.
     * @throws {AgentFilesError} the first change what is stored refuses; ENOSPC, naming the last file put, past `maxBytes`
     */
    async commit(session: string, ops: readonly AgentOp[], opts: { maxBytes?: number } = {}): Promise<void> {
        if (!ops.length) return;
        const db = await this.open();
        const tx = db.transaction([NODES, BLOBS], "readwrite");
        const nodes = tx.objectStore(NODES), blobs = tx.objectStore(BLOBS);
        const at = this.now();
        const get = async (p: string) => (await done(nodes.get([session, p])) as AgentNode | undefined) ?? null;
        const dirOk = async (p: string) => {
            if (p === "") return;
            const d = await get(p);
            if (!d) throw new AgentFilesError("ENOENT", p);
            if (d.kind !== "dir") throw new AgentFilesError("ENOTDIR", p);
        };
        const hasKids = async (p: string) => (await done(nodes.index("parent").count([session, p]))) > 0;
        const dropFile = (n: AgentNode) => { if (n.blob) blobs.delete(n.blob); };
        const work = (async () => {
            for (const o of ops) {
                if (o.op === "put") {
                    await dirOk(parentOf(o.path));
                    const old = await get(o.path);
                    if (old?.kind === "dir") throw new AgentFilesError("EISDIR", o.path);
                    if (old) dropFile(old);
                    const key = mint("b");
                    blobs.put(o.data, key);
                    nodes.put({ session, path: o.path, parent: parentOf(o.path), kind: "file", size: o.data.size, mtimeMs: at, birthtimeMs: old?.birthtimeMs ?? at, version: mint("w"), blob: key } satisfies AgentNode);
                } else if (o.op === "mkdir") {
                    await dirOk(parentOf(o.path));
                    if (await get(o.path)) throw new AgentFilesError("EEXIST", o.path);
                    nodes.put({ session, path: o.path, parent: parentOf(o.path), kind: "dir", size: 0, mtimeMs: at, birthtimeMs: at } satisfies AgentNode);
                } else if (o.op === "rmdir") {
                    const d = await get(o.path);
                    if (!d) throw new AgentFilesError("ENOENT", o.path);
                    if (d.kind !== "dir") throw new AgentFilesError("ENOTDIR", o.path);
                    if (await hasKids(o.path)) throw new AgentFilesError("ENOTEMPTY", o.path);
                    nodes.delete([session, o.path]);
                } else if (o.op === "unlink") {
                    const f = await get(o.path);
                    if (!f) throw new AgentFilesError("ENOENT", o.path);
                    if (f.kind === "dir") throw new AgentFilesError("EISDIR", o.path);
                    dropFile(f);
                    nodes.delete([session, o.path]);
                } else {
                    const { from, to } = o;
                    const src = await get(from);
                    if (!src) throw new AgentFilesError("ENOENT", from);
                    if (from === to) continue;
                    if (to.startsWith(from + "/")) throw new AgentFilesError("EINVAL", to);
                    await dirOk(parentOf(to));
                    const dst = await get(to);
                    if (dst) {
                        if (src.kind === "file" && dst.kind === "dir") throw new AgentFilesError("EISDIR", to);
                        if (src.kind === "dir" && dst.kind === "file") throw new AgentFilesError("ENOTDIR", to);
                        if (dst.kind === "dir" && await hasKids(to)) throw new AgentFilesError("ENOTEMPTY", to);
                        dropFile(dst);
                        nodes.delete([session, to]);
                    }
                    // A folder moves with everything under it.
                    const moved = src.kind === "dir" ? (await done(nodes.index("session").getAll(session)) as AgentNode[]).filter((n) => n.path.startsWith(from + "/")) : [];
                    for (const n of [src, ...moved]) {
                        nodes.delete([session, n.path]);
                        const path = to + n.path.slice(from.length);
                        nodes.put({ ...n, path, parent: parentOf(path), ...(n === src ? { mtimeMs: at } : {}) });
                    }
                }
            }
            const lastPut = [...ops].reverse().find((o): o is Extract<AgentOp, { op: "put" }> => o.op === "put");
            if (opts.maxBytes !== undefined && lastPut) {
                const all = await done(nodes.index("session").getAll(session)) as AgentNode[];
                if (all.reduce((n, x) => n + (x.kind === "file" ? x.size : 0), 0) > opts.maxBytes) throw new AgentFilesError("ENOSPC", lastPut.path);
            }
        })();
        try { await work; } catch (e) { try { tx.abort(); } catch { /* finished */ } await committed(tx).catch(() => {}); throw e; }
        await committed(tx);
    }

    /** Delete every file and folder of a session: the session was deleted. Returns how many nodes went. */
    async forgetSession(session: string): Promise<number> {
        const db = await this.open();
        const tx = db.transaction([NODES, BLOBS, LOST], "readwrite");
        const nodes = tx.objectStore(NODES);
        const all = await done(nodes.index("session").getAll(session)) as AgentNode[];
        for (const n of all) { if (n.blob) tx.objectStore(BLOBS).delete(n.blob); nodes.delete([session, n.path]); }
        const lost = tx.objectStore(LOST);
        for (const k of await done(lost.index("session").getAllKeys(session))) lost.delete(k);
        await committed(tx);
        return all.length;
    }

    /** Note a discarded write, keeping at most {@link LOST_KEPT} per session (the oldest go). */
    async noteLost(rec: LostWrite): Promise<void> {
        const db = await this.open();
        const tx = db.transaction(LOST, "readwrite");
        const lost = tx.objectStore(LOST);
        lost.add(rec);
        const keys = await done(lost.index("session").getAllKeys(rec.session));
        // Keys are ascending, the new note's included: the oldest are first.
        for (const k of keys.slice(0, Math.max(0, keys.length - LOST_KEPT))) lost.delete(k);
        await committed(tx);
    }

    /** A session's discard notes, oldest first. */
    async lost(session: string): Promise<LostWrite[]> {
        const db = await this.open();
        return await done(db.transaction(LOST).objectStore(LOST).index("session").getAll(session)) as LostWrite[];
    }
}

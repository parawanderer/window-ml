// files-channel-fake.mjs — an in-memory test double of the `/files` reader channel (`FilesChannel`, src/python/files-reader.ts), for the Python mount's tests.

/** The chunk bound, as in files-reader.ts (`FILES_CHUNK`): a read or write over it is EINVAL. */
const CHUNK = 512 * 1024;

/**
  * A fake `/files` reader: an in-memory store per session behind any number of `channel()` objects, with the layout
  * (root, `attached/` and `agent/` itself read-only; a run writes only in its own folder `agent/<folder>/`, and every other
  * model's folder answers ENOENT as if it were missing), transactions, hidden paths and a per-session quota.
  * @param {{ quotaBytes?: number, hidden?: string[], folderOf?: (session: string) => string }} [opts] `hidden` paths are hidden in every session; `folderOf` names a session's own folder (default `m1`).
  * @returns {{
  *   channel(): any,
  *   seed(session: string, path: string, bytes: Uint8Array | string): void,
  *   committed(session: string, path: string): Uint8Array | undefined,
  *   list(session: string): string[],
  *   hide(session: string, path: string): void,
  *   log: any[][],
  * }}
  */
export function makeFakeFiles({ quotaBytes = 1 << 30, hidden = [], folderOf = () => "m1" } = {}) {
    /** @type {any[][]} */
    const log = [];
    /** @type {Map<string, { files: Map<string, any>, dirs: Set<string> }>} */
    const stores = new Map();
    /** @type {Map<string, Set<string>>} */
    const hiddenBy = new Map();
    const hiddenAll = new Set(hidden);
    /** @type {Map<number, any>} */
    const txns = new Map();
    /** @type {Map<number, any>} */
    const fds = new Map();
    let nextTxn = 1;
    let nextFd = 3;
    let clock = 1_700_000_000_000;
    let ver = 0;
    const tick = () => ++clock;
    const enc = new TextEncoder();

    const err = (code, syscall, path, message) => {
        const e = { code, syscall, message: message ?? `${code}: ${syscall}${path === undefined ? "" : ` '${path}'`}` };
        if (path !== undefined) e.path = path;
        return e;
    };
    const store = (s) => {
        let st = stores.get(s);
        if (!st) stores.set(s, (st = { files: new Map(), dirs: new Set(["", "attached", "agent", ownDir(s)]) }));
        return st;
    };
    const parentOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
    const ownDir = (s) => "agent/" + folderOf(s);
    const underAgent = (p) => p.startsWith("agent/");
    /** Strictly below the session's own folder. */
    const underOwn = (s, p) => p.startsWith(ownDir(s) + "/");
    /** The path is inside another model's folder (or is it): `agent/<x>` with x not the session's own. */
    const inOther = (s, p) => underAgent(p) && p.split("/")[1] !== folderOf(s);
    const isHidden = (s, p) => {
        for (const h of [...hiddenAll, ...(hiddenBy.get(s) ?? [])]) if (p === h || p.startsWith(h + "/")) return true;
        return false;
    };
    /** Canonical path or ENOENT. */
    const canon = (p, syscall) => {
        if (typeof p !== "string" || p.startsWith("/") || p.endsWith("/")) throw err("ENOENT", syscall, p);
        if (p === "") return p;
        for (const seg of p.split("/")) if (seg === "" || seg === "." || seg === "..") throw err("ENOENT", syscall, p);
        return p;
    };
    const kindOf = (v, p) => (v.files.has(p) ? "file" : v.dirs.has(p) ? "dir" : null);
    const hasChildren = (v, d) => {
        for (const p of v.files.keys()) if (p.startsWith(d + "/")) return true;
        for (const p of v.dirs) if (p.startsWith(d + "/")) return true;
        return false;
    };

    /** Apply one staged op to a view (a clone); `finalize` stamps committed versions. */
    const applyOp = (v, op, finalize) => {
        if (op.op === "put") {
            const old = v.files.get(op.path);
            v.files.set(op.path, {
                bytes: finalize ? op.data.bytes.slice() : op.data.bytes,
                mtimeMs: op.data.mtimeMs,
                birthtimeMs: old?.birthtimeMs ?? op.data.birthtimeMs,
                version: finalize ? String(++ver) : `txn:${op.txn}`,
            });
        } else if (op.op === "mkdir") v.dirs.add(op.path);
        else if (op.op === "rmdir") v.dirs.delete(op.path);
        else if (op.op === "unlink") v.files.delete(op.path);
        else if (op.op === "rename") {
            const { from, to } = op;
            if (v.files.has(from)) {
                v.files.set(to, v.files.get(from));
                v.files.delete(from);
            } else {
                const mv = (p) => to + p.slice(from.length);
                for (const p of [...v.files.keys()]) if (p.startsWith(from + "/")) { v.files.set(mv(p), v.files.get(p)); v.files.delete(p); }
                for (const d of [...v.dirs]) if (d === from || d.startsWith(from + "/")) { v.dirs.delete(d); v.dirs.add(mv(d)); }
            }
        }
    };
    /** The committed state, or a clone of it with the txn's staged ops replayed over it. */
    const viewOf = (s, t) => {
        const st = store(s);
        if (!t) return st;
        const v = { files: new Map(st.files), dirs: new Set(st.dirs) };
        for (const op of t.ops) applyOp(v, op, false);
        return v;
    };

    const usage = (s, override) => {
        const st = store(s);
        let n = 0;
        for (const [p, e] of st.files) if (underAgent(p)) n += e.bytes.length;
        for (const t of txns.values()) {
            if (t.session !== s) continue;
            const latest = new Map();
            for (const op of t.ops) if (op.op === "put") latest.set(op.path, op.data);
            for (const [p, d] of latest) {
                const len = override && override.data === d ? override.len : d.bytes.length;
                n += Math.max(0, len - (st.files.get(p)?.bytes.length ?? 0));
            }
        }
        return n;
    };

    const statOf = (s, v, p, syscall) => {
        const k = kindOf(v, p);
        if (!k) throw err("ENOENT", syscall, p);
        const e = k === "file" ? v.files.get(p) : null;
        return {
            kind: k,
            size: e ? e.bytes.length : 0,
            mtimeMs: e ? e.mtimeMs : 1_700_000_000_000,
            birthtimeMs: e ? e.birthtimeMs : 1_700_000_000_000,
            hidden: isHidden(s, p),
            readonly: !(underOwn(s, p) || p === ownDir(s)),
        };
    };

    /** @param {any[]} args */
    const strip = (args) => args.filter((a) => !(a instanceof Uint8Array));

    function channel() {
        /** @type {string | null} */
        let session = null;
        let attemptTxn;
        let disposed = false;
        const mine = new Set();

        /** Log, capture the session synchronously, run `fn(session)`, answer a promise. */
        const call = (member, args, fn) => {
            log.push([member, ...strip(args)]);
            try {
                if (disposed || session === null) throw err("EBADF", member, undefined, "no session");
                return Promise.resolve(fn(session));
            } catch (e) {
                return Promise.reject(e);
            }
        };
        const getTxn = (s, id, syscall) => {
            const t = txns.get(id);
            if (!t || t.session !== s) throw err("EBADF", syscall, undefined, `bad transaction ${id}`);
            return t;
        };
        const getFd = (s, fd, syscall) => {
            const f = fds.get(fd);
            if (!f || f.session !== s || f.sealed) throw err("EBADF", syscall, undefined, `bad descriptor ${fd}`);
            if (f.kind === "w" && !txns.has(f.txn.id)) throw err("EBADF", syscall);
            return f;
        };
        /** Another model's folder, or anything under it: indistinguishable from a missing path. */
        const unseen = (s, p, syscall) => {
            if (inOther(s, p)) throw err("ENOENT", syscall, p);
        };
        /** Judge a write-class target: EROFS at the root and in attached/, ENOENT in another model's existing folder, EACCES outside the own folder. */
        const writable = (s, v, p, syscall) => {
            if (p !== "agent" && !underAgent(p)) throw err("EROFS", syscall, p, "read-only file system");
            if (inOther(s, p) && v.dirs.has("agent/" + p.split("/")[1])) throw err("ENOENT", syscall, p);
            if (underOwn(s, p)) return;
            if (p === ownDir(s) && syscall === "mkdir") throw err("EEXIST", syscall, p);
            throw err("EACCES", syscall, p, `EACCES: '${p}' is outside this run's folder`);
        };
        const parentDir = (v, p, syscall) => {
            const k = kindOf(v, parentOf(p));
            if (k === "dir") return;
            throw err(k === "file" ? "ENOTDIR" : "ENOENT", syscall, p);
        };
        const checkIo = (position, length, syscall) => {
            if (!Number.isInteger(position) || position < 0 || !Number.isInteger(length) || length < 0 || length > CHUNK) throw err("EINVAL", syscall);
        };
        const txnOf = (s, opts, syscall) => (opts && opts.txn != null ? getTxn(s, opts.txn, syscall) : undefined);

        return {
            /** The session's own folder as a path (`/files/agent/<folder>`), undefined before `setSession`. */
            get home() {
                return session === null ? undefined : "/files/" + ownDir(session);
            },
            setSession(hash, opts) {
                session = hash;
                attemptTxn = opts?.attemptTxn;
            },
            stat(path, opts) {
                return call("stat", [path, opts], (s) => {
                    const p = canon(path, "stat");
                    unseen(s, p, "stat");
                    return statOf(s, viewOf(s, txnOf(s, opts, "stat")), p, "stat");
                });
            },
            opendir(path, opts) {
                return call("opendir", [path, opts], (s) => {
                    const p = canon(path, "opendir");
                    unseen(s, p, "opendir");
                    const v = viewOf(s, txnOf(s, opts, "opendir"));
                    const k = kindOf(v, p);
                    if (!k) throw err("ENOENT", "opendir", p);
                    if (k === "file") throw err("ENOTDIR", "opendir", p);
                    if (!Number.isInteger(opts?.limit) || opts.limit < 1) throw err("EINVAL", "opendir", p);
                    const prefix = p === "" ? "" : p + "/";
                    const names = new Set();
                    for (const q of [...v.files.keys(), ...v.dirs]) {
                        if (q === "" || !q.startsWith(prefix)) continue;
                        const rest = q.slice(prefix.length);
                        if (rest === "" || rest.includes("/")) continue;
                        if (p === "agent" && rest !== folderOf(s)) continue;
                        names.add(rest);
                    }
                    let sorted = [...names].sort();
                    const cur = opts.cursor;
                    if (cur !== undefined) {
                        if (typeof cur !== "string" || !cur.startsWith("c:")) throw err("EINVAL", "opendir", p);
                        const after = cur.slice(2);
                        sorted = sorted.filter((n) => n > after);
                    }
                    const page = sorted.slice(0, opts.limit);
                    const out = { entries: page.map((name) => ({ name, ...statOf(s, v, prefix + name, "opendir") })) };
                    if (sorted.length > page.length) out.next = "c:" + page[page.length - 1];
                    return out;
                });
            },
            open(path, opts) {
                return call("open", [path, opts], (s) => {
                    const p = canon(path, "open");
                    unseen(s, p, "open");
                    const t = txnOf(s, opts, "open");
                    const v = viewOf(s, t);
                    const k = kindOf(v, p);
                    if (!k) throw err("ENOENT", "open", p);
                    if (k === "dir") throw err("EISDIR", "open", p);
                    if (isHidden(s, p)) throw err("EACCES", "open", p, `EACCES: '${p}' is hidden`);
                    const e = v.files.get(p);
                    const fd = nextFd++;
                    fds.set(fd, { kind: "r", session: s, path: p, bytes: t ? e.bytes.slice() : e.bytes, ent: e, chan: mine });
                    mine.add(fd);
                    return { fd, size: e.bytes.length, version: e.version };
                });
            },
            read(fd, position, length, dest) {
                return call("read", [fd, position, length, dest], (s) => {
                    const f = getFd(s, fd, "read");
                    checkIo(position, length, "read");
                    if (isHidden(s, f.path)) throw err("EACCES", "read", f.path, `EACCES: '${f.path}' is hidden`);
                    const bytes = f.kind === "w" ? f.data.bytes : f.bytes;
                    if (position >= bytes.length) return 0;
                    const n = Math.min(length, bytes.length - position, dest.length);
                    dest.set(bytes.subarray(position, position + n));
                    return n;
                });
            },
            fstat(fd) {
                return call("fstat", [fd], (s) => {
                    const f = getFd(s, fd, "fstat");
                    const d = f.kind === "w" ? f.data : f.ent;
                    return {
                        kind: "file",
                        size: (f.kind === "w" ? f.data.bytes : f.bytes).length,
                        mtimeMs: d.mtimeMs,
                        birthtimeMs: d.birthtimeMs,
                        hidden: isHidden(s, f.path),
                        readonly: !underOwn(s, f.path),
                    };
                });
            },
            close(fd) {
                return call("close", [fd], (s) => {
                    const f = getFd(s, fd, "close");
                    if (f.kind !== "r") throw err("EBADF", "close");
                    fds.delete(fd);
                });
            },
            begin() {
                return call("begin", [], (s) => {
                    const id = nextTxn++;
                    txns.set(id, { id, session: s, ops: [], chan: mine });
                    return id;
                });
            },
            openWrite(path, flags, txn) {
                return call("openWrite", [path, flags, txn], (s) => {
                    const p = canon(path, "open");
                    if (!["w", "a", "r+", "x"].includes(flags)) throw err("EINVAL", "open", p);
                    const t = getTxn(s, attemptTxn != null ? attemptTxn : txn, "open");
                    const v = viewOf(s, t);
                    writable(s, v, p, "open");
                    const k = kindOf(v, p);
                    if (k === "dir") throw err("EISDIR", "open", p);
                    parentDir(v, p, "open");
                    if (flags === "x" && k) throw err("EEXIST", "open", p);
                    if (flags === "r+" && !k) throw err("ENOENT", "open", p);
                    const old = v.files.get(p);
                    const keep = (flags === "a" || flags === "r+") && old;
                    const data = {
                        bytes: keep ? old.bytes.slice() : new Uint8Array(0),
                        mtimeMs: keep ? old.mtimeMs : tick(),
                        birthtimeMs: old ? old.birthtimeMs : tick(),
                    };
                    t.ops.push({ op: "put", path: p, data, txn: t.id });
                    const wfd = nextFd++;
                    fds.set(wfd, { kind: "w", session: s, path: p, data, txn: t, sealed: false });
                    mine.add(wfd);
                    return { wfd, size: data.bytes.length };
                });
            },
            write(wfd, position, bytes) {
                return call("write", [wfd, position, bytes], (s) => {
                    const f = getFd(s, wfd, "write");
                    if (f.kind !== "w") throw err("EBADF", "write");
                    if (!(bytes instanceof Uint8Array)) throw err("EINVAL", "write");
                    checkIo(position, bytes.length, "write");
                    const end = position + bytes.length;
                    const newLen = Math.max(f.data.bytes.length, end);
                    if (usage(s, { data: f.data, len: newLen }) > quotaBytes) throw err("ENOSPC", "write", f.path);
                    if (newLen > f.data.bytes.length) {
                        const nb = new Uint8Array(newLen);
                        nb.set(f.data.bytes);
                        f.data.bytes = nb;
                    }
                    f.data.bytes.set(bytes, position);
                    f.data.mtimeMs = tick();
                });
            },
            truncate(wfd, length) {
                return call("truncate", [wfd, length], (s) => {
                    const f = getFd(s, wfd, "truncate");
                    if (f.kind !== "w") throw err("EBADF", "truncate");
                    if (!Number.isInteger(length) || length < 0) throw err("EINVAL", "truncate");
                    if (usage(s, { data: f.data, len: length }) > quotaBytes) throw err("ENOSPC", "truncate", f.path);
                    const nb = new Uint8Array(length);
                    nb.set(f.data.bytes.subarray(0, length));
                    f.data.bytes = nb;
                    f.data.mtimeMs = tick();
                });
            },
            closeWrite(wfd) {
                return call("closeWrite", [wfd], (s) => {
                    const f = getFd(s, wfd, "closeWrite");
                    if (f.kind !== "w") throw err("EBADF", "closeWrite");
                    f.sealed = true;
                });
            },
            rename(from, to, txn) {
                return call("rename", [from, to, txn], (s) => {
                    const a = canon(from, "rename");
                    const b = canon(to, "rename");
                    const t = getTxn(s, txn, "rename");
                    const v = viewOf(s, t);
                    writable(s, v, a, "rename");
                    writable(s, v, b, "rename");
                    const ka = kindOf(v, a);
                    if (!ka) throw err("ENOENT", "rename", a);
                    parentDir(v, b, "rename");
                    if (a === b) return;
                    if (ka === "dir" && b.startsWith(a + "/")) throw err("EINVAL", "rename", a);
                    const kb = kindOf(v, b);
                    if (kb) {
                        if (ka === "file" && kb === "dir") throw err("EISDIR", "rename", b);
                        if (ka === "dir" && kb === "file") throw err("ENOTDIR", "rename", b);
                        if (kb === "dir" && hasChildren(v, b)) throw err("ENOTEMPTY", "rename", b);
                    }
                    t.ops.push({ op: "rename", from: a, to: b });
                });
            },
            unlink(path, txn) {
                return call("unlink", [path, txn], (s) => {
                    const p = canon(path, "unlink");
                    const t = getTxn(s, txn, "unlink");
                    writable(s, viewOf(s, t), p, "unlink");
                    const k = kindOf(viewOf(s, t), p);
                    if (!k) throw err("ENOENT", "unlink", p);
                    if (k === "dir") throw err("EISDIR", "unlink", p);
                    t.ops.push({ op: "unlink", path: p });
                });
            },
            mkdir(path, txn) {
                return call("mkdir", [path, txn], (s) => {
                    const p = canon(path, "mkdir");
                    const t = getTxn(s, txn, "mkdir");
                    const v = viewOf(s, t);
                    writable(s, v, p, "mkdir");
                    parentDir(v, p, "mkdir");
                    if (kindOf(v, p)) throw err("EEXIST", "mkdir", p);
                    t.ops.push({ op: "mkdir", path: p });
                });
            },
            rmdir(path, txn) {
                return call("rmdir", [path, txn], (s) => {
                    const p = canon(path, "rmdir");
                    const t = getTxn(s, txn, "rmdir");
                    const v = viewOf(s, t);
                    writable(s, v, p, "rmdir");
                    const k = kindOf(v, p);
                    if (!k) throw err("ENOENT", "rmdir", p);
                    if (k === "file") throw err("ENOTDIR", "rmdir", p);
                    if (hasChildren(v, p)) throw err("ENOTEMPTY", "rmdir", p);
                    t.ops.push({ op: "rmdir", path: p });
                });
            },
            commitTx(txn) {
                return call("commitTx", [txn], (s) => {
                    const t = getTxn(s, txn, "commitTx");
                    for (const f of fds.values()) if (f.kind === "w" && f.txn === t && !f.sealed) throw err("EINVAL", "commitTx", undefined, "a write descriptor is still open");
                    const st = store(s);
                    const v = { files: new Map(st.files), dirs: new Set(st.dirs) };
                    for (const op of t.ops) applyOp(v, op, true);
                    stores.set(s, v);
                    txns.delete(t.id);
                    for (const [n, f] of [...fds]) if (f.kind === "w" && f.txn === t) fds.delete(n);
                });
            },
            abortTx(txn) {
                return call("abortTx", [txn], (s) => {
                    const t = getTxn(s, txn, "abortTx");
                    txns.delete(t.id);
                    for (const [n, f] of [...fds]) if (f.kind === "w" && f.txn === t) fds.delete(n);
                });
            },
            dispose() {
                disposed = true;
                for (const n of mine) fds.delete(n);
                for (const [id, t] of [...txns]) if (t.chan === mine) txns.delete(id);
            },
        };
    }

    return {
        channel,
        seed(session, path, bytes) {
            const p = canon(path, "seed");
            const st = store(session);
            for (let d = parentOf(p); d !== ""; d = parentOf(d)) st.dirs.add(d);
            const b = typeof bytes === "string" ? enc.encode(bytes) : bytes.slice();
            const old = st.files.get(p);
            st.files.set(p, { bytes: b, mtimeMs: tick(), birthtimeMs: old?.birthtimeMs ?? tick(), version: String(++ver) });
        },
        committed(session, path) {
            return store(session).files.get(path)?.bytes.slice();
        },
        list(session) {
            return [...store(session).files.keys()].sort();
        },
        hide(session, path) {
            if (!hiddenBy.has(session)) hiddenBy.set(session, new Set());
            hiddenBy.get(session).add(path);
        },
        log,
    };
}

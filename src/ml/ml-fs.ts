// ml-fs.ts — `ml.fs`: Node's `fs/promises`, with a session's files as its disk, over the reader's channel (FILE_ATTACHMENTS.md, "`ml.fs`: Node's `fs/promises`, with a session's files as its disk").

// Built inside the isolated world of a worker-built run (bundled by isolated-kit.ts), where every channel call goes to
// the worker (iso-channel.ts), which sends the read ops alone to the offscreen document's reader, its session the run's.
// This module only shapes what Node's callers expect: paths resolved lexically under one root, Node's argument forms,
// `Stats`, `Dirent`, `FileHandle`, and errors with Node's `code`, `syscall` and `path`. It decides nothing about access:
// the reader checks every path and the worker every op, so a script that reaches the channel without this module gets
// nothing more. Every byte it reads was masked inside the reader's read (secret-mask.ts), text and binary alike.
// The write members reject with EROFS until the write side lands (slice 3), as the reader does.

/** The reader's read ops: the only ones the worker forwards (iso-channel.ts) and the offscreen document serves (fs-serve.ts). */
export const FS_READ_OPS = ["stat", "opendir", "open", "read", "fstat", "close"] as const;
/** One of the reader's read ops: the name an `ml.fs` channel request carries. */
export type FsReadOp = typeof FS_READ_OPS[number];

/** One channel call: resolves with the reader's answer, rejects with an `Error` whose `code` is the reader's. */
export type FsTransport = (op: FsReadOp, args: unknown[]) => Promise<unknown>;

/** The most bytes `readFile` returns whole: past it, read by range (`open` and `handle.read`). */
export const ML_FS_READFILE_MAX = 8 * 1024 * 1024;

/** The most bytes one `handle.read` moves: the reader's chunk (files-reader.ts `FILES_CHUNK`). */
export const ML_FS_READ_MAX = 512 * 1024;

/** The most entries a recursive `readdir` lists before it refuses: a bound on one call's work, far past any real tree. */
export const ML_FS_READDIR_MAX = 100_000;

/** The root every path resolves under, as `realpath` and error texts give it. */
const ROOT = "/files";

/** One directory page, as the reader pages them (ranged-reader.ts `DIR_PAGE_MAX`). */
const PAGE = 500;

/** The text of each error code, as Node words it. */
const DESC: Record<string, string> = {
    ENOENT: "no such file or directory", ENOTDIR: "not a directory", EISDIR: "illegal operation on a directory",
    EBADF: "bad file descriptor", EACCES: "permission denied", EROFS: "read-only file system", EEXIST: "file already exists",
    ENOSPC: "no space left on device", ENOTEMPTY: "directory not empty", EINVAL: "invalid argument", EIO: "i/o error",
};

/** The encodings a read decodes to; anything else is refused by name. */
const ENCODINGS = ["utf8", "utf-8", "latin1", "base64", "hex"] as const;
type Encoding = typeof ENCODINGS[number];

/** Node's `fs.constants`, the access modes and the read-only open flag. */
const CONSTANTS = Object.freeze({ F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0 });

/** The members narrower than Node, each with the form that works (FILE_ATTACHMENTS.md, "Narrower than Node"). */
const UNSUPPORTED: Record<string, string> = {
    createWriteStream: "use open() with handle.write()",
    watch: "nothing watches the session's files", watchFile: "nothing watches the session's files", unwatchFile: "nothing watches the session's files",
    chmod: "the session's files have no modes", chown: "the session's files have no owners", lchown: "the session's files have no owners",
    utimes: "the session's files keep their own times", lutimes: "the session's files keep their own times", fchmod: "the session's files have no modes",
    symlink: "the session's files have no links", link: "the session's files have no links", readlink: "the session's files have no links",
    mkdtemp: "make a folder under /files/agent with mkdir", statfs: "the quota is the filesQuotaMB setting",
};

/** The write members, each rejected with EROFS under Node's syscall name until the write side lands. */
const WRITES: Record<string, string> = {
    writeFile: "open", appendFile: "open", truncate: "open", mkdir: "mkdir", rmdir: "rmdir", rm: "rm", unlink: "unlink",
    rename: "rename", copyFile: "copyfile", cp: "cp",
};

/** An `Error` shaped as Node's: `code`, `syscall` and, when the call named one, `path`. */
type NodeError = Error & { code: string; syscall?: string; path?: string };

/**
 * A Node-shaped error. The message is Node's form, built here from the code: never a text the channel sent.
 * @param code the error code
 * @param syscall the call, as Node names it
 * @param path the path as the caller wrote it, if any
 */
function nodeError(code: string, syscall: string, path?: string): NodeError {
    const e = new Error(`${code}: ${DESC[code] ?? DESC.EIO}, ${syscall}${path === undefined ? "" : ` '${path}'`}`) as NodeError;
    e.code = code;
    e.syscall = syscall;
    if (path !== undefined) e.path = path;
    return e;
}

/** An error with a code of its own (ERR_*), as Node's argument checks throw. */
function codeError(code: string, message: string, Kind: ErrorConstructor = Error): NodeError {
    const e = new Kind(message) as NodeError;
    e.code = code;
    return e;
}

/** The refusal of a member or form `ml.fs` does not have. */
const unsupported = (what: string, instead: string) => codeError("ERR_ML_FS_UNSUPPORTED", `ml.fs: ${what} is not supported: ${instead}.`);

/**
 * A channel failure as the caller's error: a reader code becomes Node's error for this call; anything without one (the
 * worker's own sentence: a budget, a malformed request) is passed on as it is.
 */
function asNodeError(e: unknown, syscall: string, path?: string): Error {
    const code = (e as { code?: unknown })?.code;
    if (typeof code === "string" && code in DESC) return nodeError(code, syscall, path);
    return e instanceof Error ? e : new Error(String(e));
}

/** A path as the caller gave it, checked as Node checks it. */
function pathArg(p: unknown): string {
    if (p instanceof Uint8Array) p = new TextDecoder().decode(p);
    if (typeof p !== "string") throw codeError("ERR_INVALID_ARG_TYPE", `The "path" argument must be of type string or an instance of Buffer or URL. Received ${p === null ? "null" : typeof p}`, TypeError);
    if (p.includes("\0")) throw codeError("ERR_INVALID_ARG_VALUE", "The argument 'path' must be a string, Uint8Array, or URL without null bytes.", TypeError);
    return p;
}

/**
 * Resolve a path under the one root: relative against `/files/`, `..` lexically and stopping at the root, and `/files/x`
 * the same file as `/x`.
 * @param p the path as given
 * @returns the reader's session-relative path, and whether it ended in a slash (which a file does not satisfy)
 */
export function resolveFsPath(p: string): { rel: string; dirOnly: boolean } {
    const segs: string[] = [];
    for (const s of (p.startsWith("/") ? p : `${ROOT}/${p}`).split("/")) {
        if (s === "" || s === ".") continue;
        if (s === "..") segs.pop(); else segs.push(s);
    }
    if (segs[0] === "files") segs.shift();
    return { rel: segs.join("/"), dirOnly: /\/\.?$/.test(p) && p !== "/" };
}

/** The encoding an options argument names, or null for bytes; refuses one this API does not decode. */
function encodingOf(options: unknown): Encoding | null {
    const enc = typeof options === "string" ? options : options && typeof options === "object" ? (options as { encoding?: unknown }).encoding : undefined;
    if (enc === undefined || enc === null || enc === "buffer") return null;
    const e = String(enc).toLowerCase();
    if ((ENCODINGS as readonly string[]).includes(e)) return e as Encoding;
    throw unsupported(`the encoding ${JSON.stringify(enc)}`, `supported: ${ENCODINGS.join(", ")}, or none for bytes`);
}

/** Bytes decoded as Node's `Buffer.toString` does: invalid UTF-8 becomes U+FFFD, and a BOM is kept. */
function decode(b: Uint8Array, enc: Encoding): string {
    if (enc === "utf8" || enc === "utf-8") return new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    if (enc === "latin1") return s;
    if (enc === "base64") return toB64(b);
    let h = "";
    for (const x of b) h += x.toString(16).padStart(2, "0");
    return h;
}

/** The base64 alphabet. Coded here rather than with `atob`/`btoa`: the world's globals are not this module's to rely on. */
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

/** A base64 payload as bytes. */
function fromB64(s: string): Uint8Array {
    const t = s.replace(/=+$/, "");
    const out = new Uint8Array(Math.floor(t.length * 3 / 4));
    let bits = 0, n = 0, at = 0;
    for (const c of t) {
        bits = (bits << 6) | (B64_INDEX.get(c) ?? 0); n += 6;
        if (n >= 8) { n -= 8; out[at++] = (bits >> n) & 0xff; }
    }
    return out;
}

/** Bytes as base64, as Node's `Buffer.toString("base64")` writes them. */
function toB64(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i += 3) {
        const x = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
        s += B64[(x >> 18) & 63] + B64[(x >> 12) & 63] + (i + 1 < b.length ? B64[(x >> 6) & 63] : "=") + (i + 2 < b.length ? B64[x & 63] : "=");
    }
    return s;
}

/** What the reader says a path is (files-reader.ts `FileStat`). */
interface ReaderStat { kind: "file" | "dir"; size: number; mtimeMs: number; birthtimeMs: number; hidden?: boolean; readonly?: boolean }

/** Node's `Stats`, with the fields the reader knows; one it cannot answer (`ino`, `uid`, `atimeMs`, …) is absent, never zero. */
export class Stats {
    size: number; mtimeMs: number; birthtimeMs: number; mtime: Date; birthtime: Date;
    readonly #dir: boolean;
    constructor(s: ReaderStat) {
        this.#dir = s.kind === "dir";
        this.size = s.size; this.mtimeMs = s.mtimeMs; this.birthtimeMs = s.birthtimeMs;
        this.mtime = new Date(s.mtimeMs); this.birthtime = new Date(s.birthtimeMs);
    }
    isFile(): boolean { return !this.#dir; }
    isDirectory(): boolean { return this.#dir; }
    isSymbolicLink(): boolean { return false; }
    isBlockDevice(): boolean { return false; }
    isCharacterDevice(): boolean { return false; }
    isFIFO(): boolean { return false; }
    isSocket(): boolean { return false; }
}

/** Node's `Dirent`: a name, the directory it was listed under as the caller wrote it, and its kind. */
export class Dirent {
    name: string; parentPath: string; path: string;
    readonly #dir: boolean;
    constructor(name: string, parentPath: string, dir: boolean) { this.name = name; this.parentPath = parentPath; this.path = parentPath; this.#dir = dir; }
    isFile(): boolean { return !this.#dir; }
    isDirectory(): boolean { return this.#dir; }
    isSymbolicLink(): boolean { return false; }
    isBlockDevice(): boolean { return false; }
    isCharacterDevice(): boolean { return false; }
    isFIFO(): boolean { return false; }
    isSocket(): boolean { return false; }
}

/** A path joined as Node's `path.join` joins a listed name onto the directory the caller named. */
const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

/** A member's last argument is a callback: the callback form, refused at the call. */
function noCallback(name: string, args: unknown[]): void {
    if (typeof args[args.length - 1] === "function") throw unsupported(`the callback form of ${name}`, "use the promise form, await ml.fs." + name + "(…)");
}

/**
 * Make `ml.fs` over a channel.
 * @param call the channel to the reader, through the worker
 * @returns the `fs/promises` object, frozen, with `promises` itself and every narrower member refusing by name
 */
export function mlFs(call: FsTransport): Record<string, unknown> {
    /** A reader op for a call that names `path`, its failure as Node's error for `syscall`. */
    const ask = async <T>(op: FsReadOp, args: unknown[], syscall: string, path?: string): Promise<T> => {
        try { return await call(op, args) as T; } catch (e) { throw asNodeError(e, syscall, path); }
    };

    /** stat one resolved path; a trailing slash on a file is ENOTDIR, as Node's. */
    const statOf = async (given: string, syscall: string): Promise<ReaderStat> => {
        const { rel, dirOnly } = resolveFsPath(given);
        const s = await ask<ReaderStat>("stat", [rel], syscall, given);
        if (dirOnly && s.kind !== "dir") throw nodeError("ENOTDIR", syscall, given);
        return s;
    };

    /** Every entry of one directory, page by page. */
    const listAll = async (rel: string, given: string): Promise<Array<{ name: string } & ReaderStat>> => {
        const out: Array<{ name: string } & ReaderStat> = [];
        let cursor: string | undefined;
        do {
            const page = await ask<{ entries: Array<{ name: string } & ReaderStat>; next?: string }>("opendir", [rel, { limit: PAGE, ...(cursor ? { cursor } : {}) }], "scandir", given);
            out.push(...page.entries);
            if (out.length > ML_FS_READDIR_MAX) throw codeError("ERR_ML_FS_TOO_MANY", `ml.fs: more than ${ML_FS_READDIR_MAX.toLocaleString("en-US")} entries under '${given}'; list a smaller folder, or page it with opendir().`);
            cursor = page.next;
        } while (cursor);
        return out;
    };

    /** Read `fd` from `position` to its end, refusing past `ML_FS_READFILE_MAX`; `signal` is checked between chunks. */
    const readAll = async (fd: number, from: number, size: number, given: string | undefined, signal?: AbortSignal): Promise<Uint8Array> => {
        if (size - from > ML_FS_READFILE_MAX)
            throw codeError("ERR_FS_FILE_TOO_LARGE", `File size (${size}) is greater than ${ML_FS_READFILE_MAX / 1024 / 1024} MiB, the most ml.fs.readFile returns whole: read it by range with ml.fs.open() and handle.read(), or line by line with handle.readLines().`, RangeError);
        const parts: Uint8Array[] = [];
        let pos = from, total = 0;
        for (;;) {
            if (signal?.aborted) throw Object.assign(new Error("The operation was aborted"), { name: "AbortError", code: "ABORT_ERR" });
            const r = await ask<{ n: number; b64: string }>("read", [fd, pos, ML_FS_READ_MAX], "read", given);
            if (!r.n) break;
            const b = fromB64(r.b64).subarray(0, r.n);
            parts.push(b); pos += r.n; total += r.n;
            if (total > ML_FS_READFILE_MAX) throw codeError("ERR_FS_FILE_TOO_LARGE", `File size is greater than ${ML_FS_READFILE_MAX / 1024 / 1024} MiB.`, RangeError);
        }
        const out = new Uint8Array(total);
        let at = 0;
        for (const p of parts) { out.set(p, at); at += p.length; }
        return out;
    };

    /** Node's `FileHandle`, read-only: its own position, and EBADF once closed. */
    class FileHandle {
        readonly fd: number;
        #pos = 0; #closed = false;
        readonly #size: number; readonly #dir: boolean;
        constructor(fd: number, size: number, dir: boolean) { this.fd = fd; this.#size = size; this.#dir = dir; }
        #live(syscall: string): void {
            if (this.#closed) throw nodeError("EBADF", syscall);
            if (this.#dir) throw nodeError("EISDIR", syscall);
        }
        /** Node's three forms: `(buffer, offset?, length?, position?)`, `(buffer, options)`, `(options?)`. */
        async read(a?: unknown, b?: unknown, c?: unknown, d?: unknown): Promise<{ bytesRead: number; buffer: Uint8Array }> {
            noCallback("read", [a, b, c, d].filter((x) => x !== undefined));
            let buffer: Uint8Array, offset: number, length: number, position: unknown;
            if (ArrayBuffer.isView(a)) {
                buffer = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
                if (b && typeof b === "object") {
                    const o = b as { offset?: number; length?: number; position?: unknown };
                    offset = o.offset ?? 0; length = o.length ?? buffer.byteLength - offset; position = o.position ?? null;
                } else { offset = (b as number) ?? 0; length = (c as number) ?? buffer.byteLength - offset; position = d ?? null; }
            } else {
                const o = (a ?? {}) as { buffer?: ArrayBufferView; offset?: number; length?: number; position?: unknown };
                const v = o.buffer ?? new Uint8Array(16384);
                buffer = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
                offset = o.offset ?? 0; length = o.length ?? buffer.byteLength - offset; position = o.position ?? null;
            }
            if (!Number.isInteger(offset) || offset < 0 || offset > buffer.byteLength) throw codeError("ERR_OUT_OF_RANGE", `The value of "offset" is out of range. It must be >= 0 && <= ${buffer.byteLength}. Received ${offset}`, RangeError);
            if (!Number.isInteger(length) || length < 0 || offset + length > buffer.byteLength) throw codeError("ERR_OUT_OF_RANGE", `The value of "length" is out of range. It must be >= 0 && <= ${buffer.byteLength - offset}. Received ${length}`, RangeError);
            this.#live("read");
            if (length === 0) return { bytesRead: 0, buffer };
            const at = typeof position === "bigint" ? Number(position) : typeof position === "number" && position >= 0 ? position : null;
            const r = await ask<{ n: number; b64: string }>("read", [this.fd, at ?? this.#pos, Math.min(length, ML_FS_READ_MAX)], "read");
            const bytes = r.n ? fromB64(r.b64).subarray(0, r.n) : new Uint8Array(0);
            buffer.set(bytes, offset);
            if (at === null) this.#pos += bytes.length;
            return { bytesRead: bytes.length, buffer };
        }
        /** The rest of the file from this handle's position, as `readFile` gives it. */
        async readFile(options?: unknown): Promise<Uint8Array | string> {
            noCallback("readFile", [options]);
            const enc = encodingOf(options);
            this.#live("read");
            const b = await readAll(this.fd, this.#pos, this.#size, undefined, (options as { signal?: AbortSignal })?.signal);
            this.#pos += b.length;
            return enc ? decode(b, enc) : b;
        }
        /**
         * The file's lines, read chunk by chunk from this handle's position; `\n`, `\r\n` and a lone `\r` end a line, as
         * Node's readline does, and the handle closes at the end. The handle's version was pinned at open, so a file
         * written meanwhile does not make it longer: the iteration always ends.
         */
        readLines(options?: unknown): AsyncIterableIterator<string> {
            const enc = encodingOf(options ?? "utf8") ?? "utf8";
            const self = this;
            async function* lines(): AsyncGenerator<string> {
                const td = enc === "utf8" || enc === "utf-8" ? new TextDecoder("utf-8", { ignoreBOM: true }) : null;
                let carry = "";
                try {
                    for (;;) {
                        const { bytesRead, buffer } = await self.read({ buffer: new Uint8Array(ML_FS_READ_MAX) });
                        const text = bytesRead ? (td ? td.decode(buffer.subarray(0, bytesRead), { stream: true }) : decode(buffer.subarray(0, bytesRead), enc)) : (td ? td.decode() : "");
                        carry += text;
                        // A `\r` at the end may be the first half of `\r\n`: held until the next chunk says.
                        const parts = carry.split(/\r\n|\n|\r(?!$)/);
                        carry = parts.pop() ?? "";
                        if (!bytesRead && carry.endsWith("\r")) carry = carry.slice(0, -1) + "\n";
                        for (const l of parts) yield l;
                        if (!bytesRead) break;
                    }
                    const rest = carry.split(/\r\n|\n|\r/);
                    if (rest[rest.length - 1] === "") rest.pop();
                    for (const l of rest) yield l;
                } finally { await self.close(); }
            }
            return lines();
        }
        async stat(): Promise<Stats> {
            if (this.#closed) throw nodeError("EBADF", "fstat");
            return new Stats(await ask<ReaderStat>("fstat", [this.fd], "fstat"));
        }
        /** Closes the handle; closing it again resolves, as Node's does. */
        async close(): Promise<void> {
            if (this.#closed) return;
            this.#closed = true;
            if (!this.#dir) await ask("close", [this.fd], "close");
        }
        async write(): Promise<never> { throw nodeError("EBADF", "write"); }
        async writeFile(): Promise<never> { throw nodeError("EBADF", "write"); }
        async appendFile(): Promise<never> { throw nodeError("EBADF", "write"); }
        async truncate(): Promise<never> { throw nodeError("EBADF", "ftruncate"); }
        async [Symbol.asyncDispose](): Promise<void> { await this.close(); }
    }

    /** Node's `Dir`, paging the reader's listing. */
    class Dir {
        readonly path: string;
        #rel: string; #page: Array<{ name: string } & ReaderStat> = []; #next: string | undefined; #started = false; #closed = false;
        constructor(given: string, rel: string) { this.path = given; this.#rel = rel; }
        async read(): Promise<Dirent | null> {
            if (this.#closed) throw codeError("ERR_DIR_CLOSED", "Directory handle was closed");
            while (!this.#page.length && (!this.#started || this.#next)) {
                const page = await ask<{ entries: Array<{ name: string } & ReaderStat>; next?: string }>("opendir", [this.#rel, { limit: PAGE, ...(this.#next ? { cursor: this.#next } : {}) }], "opendir", this.path);
                this.#started = true; this.#page = page.entries; this.#next = page.next;
            }
            const e = this.#page.shift();
            return e ? new Dirent(e.name, this.path, e.kind === "dir") : null;
        }
        async close(): Promise<void> {
            if (this.#closed) throw codeError("ERR_DIR_CLOSED", "Directory handle was closed");
            this.#closed = true;
        }
        async *[Symbol.asyncIterator](): AsyncGenerator<Dirent> {
            try { for (let e = await this.read(); e; e = await this.read()) yield e; } finally { if (!this.#closed) await this.close(); }
        }
    }

    /** Open for reading; any other flag writes, which is EROFS until the write side lands. */
    async function open(path: unknown, flags: unknown = "r"): Promise<FileHandle> {
        const given = pathArg(path);
        if (flags !== "r" && flags !== 0 && flags !== undefined) throw nodeError("EROFS", "open", given);
        const { rel, dirOnly } = resolveFsPath(given);
        let o: { fd: number; size: number };
        try { o = await call("open", [rel]) as { fd: number; size: number }; } catch (e) {
            // A folder opens, as Node's does; reading it is EISDIR.
            if ((e as { code?: unknown })?.code === "EISDIR") return new FileHandle(-1, 0, true);
            throw asNodeError(e, "open", given);
        }
        if (dirOnly) { await call("close", [o.fd]).catch(() => undefined); throw nodeError("ENOTDIR", "open", given); }
        return new FileHandle(o.fd, o.size, false);
    }

    /** The EventEmitter and stream members a ReadStream has and this one does not: each refuses by name. */
    const STREAM_NOT = ["on", "once", "off", "addListener", "removeListener", "removeAllListeners", "emit", "pipe", "unpipe", "read", "pause", "resume", "setEncoding", "wrap"];

    /**
     * Node's `createReadStream`, narrower: an async iterable of chunks (`for await (const chunk of stream)`), read from
     * `start` to `end` inclusive in chunks of `highWaterMark` (default 64 KiB, at most one reader chunk), decoded when
     * `encoding` is given. No EventEmitter and no `pipe`: those throw ERR_ML_FS_UNSUPPORTED. It opens at the first chunk,
     * as Node's opens after it returns, so an error (ENOENT) is thrown by the iteration; it closes at the end or a `break`.
     */
    function createReadStream(path: unknown, options?: unknown): Record<string, unknown> {
        const given = pathArg(path);
        const o = (typeof options === "string" ? { encoding: options } : options ?? {}) as { start?: number; end?: number; encoding?: unknown; highWaterMark?: number; flags?: unknown };
        const enc = encodingOf(o.encoding);
        if (o.flags !== undefined && o.flags !== "r") throw nodeError("EROFS", "open", given);
        const start = o.start ?? 0, end = o.end ?? Infinity;
        if (!Number.isSafeInteger(start) || start < 0) throw codeError("ERR_OUT_OF_RANGE", `The value of "start" is out of range. It must be >= 0 && <= 9007199254740991. Received ${start}`, RangeError);
        if (end !== Infinity && (!Number.isSafeInteger(end) || end < start)) throw codeError("ERR_OUT_OF_RANGE", `The value of "end" is out of range. It must be >= ${start} && <= 9007199254740991. Received ${end}`, RangeError);
        const hwm = Math.max(1, Math.min(o.highWaterMark ?? 64 * 1024, ML_FS_READ_MAX));
        let handle: FileHandle | null = null, done = false, read = 0;
        const stream: Record<string, unknown> = { path: given, get bytesRead() { return read; } };
        const finish = async () => { done = true; const h = handle; handle = null; await h?.close(); };
        stream[Symbol.asyncIterator as unknown as string] = async function* () {
            const td = enc === "utf8" || enc === "utf-8" ? new TextDecoder("utf-8", { ignoreBOM: true }) : null;
            try {
                if (done) return;
                handle = await open(given);
                for (let pos = start; pos <= end && !done;) {
                    const want = Math.min(hwm, end === Infinity ? hwm : end - pos + 1);
                    const { bytesRead, buffer } = await handle.read(new Uint8Array(want), 0, want, pos);
                    if (!bytesRead) break;
                    pos += bytesRead;
                    read += bytesRead;
                    const b = buffer.subarray(0, bytesRead);
                    yield enc ? (td ? td.decode(b, { stream: true }) : decode(b, enc)) : b;
                }
                const tail = td?.decode() ?? "";
                if (tail) yield tail;
            } finally { await finish(); }
        };
        stream.close = stream.destroy = () => { void finish(); };
        for (const k of STREAM_NOT) stream[k] = () => { throw unsupported(`a ReadStream's ${k}()`, "iterate it: for await (const chunk of ml.fs.createReadStream(path))"); };
        return Object.freeze(stream);
    }

    const members: Record<string, (...a: any[]) => Promise<unknown>> = {
        async readFile(path: unknown, options?: unknown) {
            const enc = encodingOf(options);
            const flag = options && typeof options === "object" ? (options as { flag?: unknown }).flag : undefined;
            const given = pathArg(path);
            if (flag !== undefined && flag !== "r") throw nodeError("EROFS", "open", given);
            const h = await open(given);
            try {
                if (h.fd < 0) throw nodeError("EISDIR", "read", given);
                const b = await h.readFile(options && typeof options === "object" ? { signal: (options as { signal?: AbortSignal }).signal } : undefined) as Uint8Array;
                return enc ? decode(b, enc) : b;
            } finally { await h.close(); }
        },
        async readdir(path: unknown, options?: unknown) {
            const given = pathArg(path);
            const o = (typeof options === "string" ? { encoding: options } : options ?? {}) as { withFileTypes?: boolean; recursive?: boolean; encoding?: unknown };
            if (o.encoding !== undefined && o.encoding !== null && o.encoding !== "buffer") encodingOf(o.encoding);
            const { rel } = resolveFsPath(given);
            const s = await ask<ReaderStat>("stat", [rel], "scandir", given);
            if (s.kind !== "dir") throw nodeError("ENOTDIR", "scandir", given);
            const out: Array<string | Dirent> = [];
            const walk = async (r: string, shown: string, prefix: string) => {
                for (const e of await listAll(r, given)) {
                    const isDir = e.kind === "dir";
                    out.push(o.withFileTypes ? new Dirent(e.name, shown, isDir) : prefix + e.name);
                    if (out.length > ML_FS_READDIR_MAX) throw codeError("ERR_ML_FS_TOO_MANY", `ml.fs: more than ${ML_FS_READDIR_MAX.toLocaleString("en-US")} entries under '${given}'; list a smaller folder, or page it with opendir().`);
                    if (o.recursive && isDir) await walk(r ? `${r}/${e.name}` : e.name, joinPath(shown, e.name), `${prefix}${e.name}/`);
                }
            };
            await walk(rel, given, "");
            return out;
        },
        async opendir(path: unknown) {
            const given = pathArg(path);
            const { rel } = resolveFsPath(given);
            const s = await ask<ReaderStat>("stat", [rel], "opendir", given);
            if (s.kind !== "dir") throw nodeError("ENOTDIR", "opendir", given);
            return new Dir(given, rel);
        },
        async stat(path: unknown) { const given = pathArg(path); return new Stats(await statOf(given, "stat")); },
        async lstat(path: unknown) { const given = pathArg(path); return new Stats(await statOf(given, "lstat")); },
        async access(path: unknown, mode: unknown = CONSTANTS.F_OK) {
            const given = pathArg(path);
            const s = await statOf(given, "access");
            const m = typeof mode === "number" ? mode : 0;
            if (m & CONSTANTS.W_OK) throw nodeError("EROFS", "access", given);
            if (m & CONSTANTS.X_OK && s.kind !== "dir") throw nodeError("EACCES", "access", given);
        },
        async realpath(path: unknown) {
            const given = pathArg(path);
            const { rel } = resolveFsPath(given);
            await statOf(given, "realpath");
            return rel ? `${ROOT}/${rel}` : ROOT;
        },
        open: (path: unknown, flags?: unknown) => open(path, flags),
    };
    for (const [name, syscall] of Object.entries(WRITES))
        members[name] = async (path: unknown) => { throw nodeError("EROFS", syscall, typeof path === "string" ? path : undefined); };

    const fs: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(members)) {
        // Not async: a callback form is refused at the call, before any promise exists.
        fs[name] = (...args: unknown[]) => { noCallback(name, args); return fn(...args); };
    }
    for (const [name, instead] of Object.entries(UNSUPPORTED)) fs[name] = () => { throw unsupported(`ml.fs.${name}`, instead); };
    fs.createReadStream = (path: unknown, options?: unknown) => { noCallback("createReadStream", [path, options]); return createReadStream(path, options); };
    fs.constants = CONSTANTS;
    const proxy: Record<string, unknown> = new Proxy(Object.freeze(fs), {
        get(t, k) {
            if (k === "promises") return proxy;
            if (typeof k === "string" && k.endsWith("Sync")) return () => { throw unsupported(`ml.fs.${k}`, `use await ml.fs.${k.slice(0, -4)}(…)`); };
            return Reflect.get(t, k);
        },
        set() { return false; },
        defineProperty() { return false; },
        deleteProperty() { return false; },
    });
    return proxy;
}

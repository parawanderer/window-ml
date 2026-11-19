// files-reader.ts — the shape of the ONE ranged reader under `/files`, as its front ends call it (FILE_ATTACHMENTS.md,
// "`/files/` read by range, and `ml.fs`"; v3 as agreed between the session-store and async lanes, 2026-11-19).

/** A Node-shaped file system error: what every refused call of the reader rejects with, and nothing else. */
export interface FsError {
    code: FsErrorCode;
    syscall: string;
    /** The path as the caller spelled it, when the call named one. */
    path?: string;
    message: string;
}

/** The error codes the reader answers with; each maps one to one onto an errno in the Python mount. */
export type FsErrorCode = "ENOENT" | "ENOTDIR" | "EISDIR" | "EBADF" | "EACCES" | "EROFS" | "EEXIST" | "ENOSPC" | "ENOTEMPTY" | "EINVAL" | "EIO";

/** What `stat` answers for one path. `hidden` files are listed but their bytes are never read (EACCES). */
export interface FileStat {
    kind: "file" | "dir";
    size: number;
    mtimeMs: number;
    birthtimeMs: number;
    hidden: boolean;
    readonly: boolean;
}

/** One page of a directory's listing: each entry carries its stat; `next` is the cursor of the page after it. */
export interface DirPage {
    entries: Array<{ name: string } & FileStat>;
    next?: string;
}

/** How `openWrite` starts the pending part: empty, seeded by reference with the version it replaces, or only if new. */
export type WriteFlags = "w" | "a" | "r+" | "x";

/** A transaction: the writes and name changes that land together on `commitTx`, or not at all. */
export type Txn = number;

/**
 * One front end's connection to the reader: paths are session-relative and canonical (`attached/<h>/<name>`,
 * `agent/…`, `""` for the root). The session is the channel's, set by the offscreen document per cell and never by
 * the caller; a descriptor opened under one session answers EBADF under any other, and every call does while it is null.
 * Read descriptors and write descriptors share one number space, and `read`/`fstat` take either.
 */
export interface FilesChannel {
    /**
     * Where a model run writes and Python's working directory, absolute, valid after `setSession`: `/files/agent`
     * (ruling 86, which withdrew ruling 81's folder per model). The reader's to say, never a caller's.
     */
    readonly home?: string;
    /** The session of the cell in flight, or null between cells; `attemptTxn` joins every `openWrite` to that txn. */
    setSession(hash: string | null, opts?: { attemptTxn?: Txn }): void;
    stat(path: string, opts?: { txn?: Txn }): Promise<FileStat>;
    opendir(path: string, opts: { cursor?: string; limit: number; txn?: Txn }): Promise<DirPage>;
    /** Open for reading: the descriptor pins the version it opened. */
    open(path: string, opts?: { txn?: Txn }): Promise<{ fd: number; size: number; version: string }>;
    /** Copy at most `length` (≤ 512 KiB) bytes from `position` into `dest`; 0 at the end. Through a writer, its pending part. */
    read(fd: number, position: number, length: number, dest: Uint8Array): Promise<number>;
    fstat(fd: number): Promise<FileStat>;
    close(fd: number): Promise<void>;
    begin(): Promise<Txn>;
    openWrite(path: string, flags: WriteFlags, txn: Txn): Promise<{ wfd: number; size: number }>;
    /** Write `bytes` (≤ 512 KiB) at `position`; past the end zero-fills. ENOSPC leaves the txn open. */
    write(wfd: number, position: number, bytes: Uint8Array): Promise<void>;
    truncate(wfd: number, length: number): Promise<void>;
    /** Seal the file inside its txn; it lands only with `commitTx`. */
    closeWrite(wfd: number): Promise<void>;
    rename(from: string, to: string, txn: Txn): Promise<void>;
    unlink(path: string, txn: Txn): Promise<void>;
    mkdir(path: string, txn: Txn): Promise<void>;
    rmdir(path: string, txn: Txn): Promise<void>;
    commitTx(txn: Txn): Promise<void>;
    abortTx(txn: Txn): Promise<void>;
    /** The channel's end (a kernel death, the worker gone): every descriptor closes and every open txn aborts. */
    dispose(): void;
}

/** The chunk bound: no single read or write between the reader and a front end moves more than this. */
export const FILES_CHUNK = 512 * 1024;

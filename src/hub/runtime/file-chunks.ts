// file-chunks.ts — the files a runtime is being sent in `file.put` chunks over the hub, put back together and checked
// against their hash, until the message that names them arrives (docs/spec/FILE_ATTACHMENTS.md, "Over the hub: chunks
// in an acknowledged window").
//
// Pure, and in memory: the worker's copy dies with the worker, which costs a client one `file.have` and a re-send,
// never a wrong file. An upload in progress is keyed by its sender as well as its hash, so one device's chunks cannot
// spoil another's upload of the same file; a finished file is keyed by its hash alone, since its bytes were checked.

import { sha256Hex } from "../file-frame";

/** A `file.put`'s fields, as the command carries them (session-host.ts). */
export interface FilePut { sha256: string; index: number; count: number; bytes: number }

/** What a `file.put` or a `file.have` comes to, or why it was refused. */
export type ChunkAnswer =
    | { ok: true; held: number; complete: boolean }
    | { ok: false; code: "invalid" | "unavailable"; message: string };

/** The limits a store keeps to. */
export interface FileChunkLimits {
    /** the largest file, in bytes */
    maxFileBytes: number;
    /** the most bytes held across every file, in progress or done; past it the oldest go first */
    maxTotalBytes: number;
    /** how long a file is kept after its last chunk or its last use */
    ttlMs: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

interface Upload { sha256: string; count: number; bytes: number; chunks: Map<number, Uint8Array>; held: number; touched: number }
interface Done { data: Uint8Array; touched: number }

/** The files one runtime is being sent, by hash. */
export class FileChunks {
    private uploads = new Map<string, Upload>();
    private done = new Map<string, Done>();

    constructor(private readonly limits: FileChunkLimits, private readonly now: () => number = Date.now) {}

    /** One chunk from `from`. Answers how many chunks of the file are in, and whether it is complete and checked. */
    async put(from: string, c: FilePut, chunk: Uint8Array): Promise<ChunkAnswer> {
        this.sweep();
        const why = this.badPut(c, chunk);
        if (why) return { ok: false, code: "invalid", message: why };
        if (this.done.has(c.sha256)) {
            this.done.get(c.sha256)!.touched = this.now();
            return { ok: true, held: c.count, complete: true };
        }
        const key = `${from}:${c.sha256}`;
        let up = this.uploads.get(key);
        // Sent again in another shape (another chunk size: the hub's limit changed between connections): start over.
        if (up && (up.count !== c.count || up.bytes !== c.bytes)) { this.uploads.delete(key); up = undefined; }
        if (!up) { up = { sha256: c.sha256, count: c.count, bytes: c.bytes, chunks: new Map(), held: 0, touched: 0 }; this.uploads.set(key, up); }
        up.touched = this.now();
        const old = up.chunks.get(c.index);
        if (old) up.held -= old.length;
        if (up.held + chunk.length > up.bytes) { this.uploads.delete(key); return { ok: false, code: "invalid", message: `the chunks of ${c.sha256} are more than its ${c.bytes} bytes` }; }
        up.chunks.set(c.index, chunk.slice());
        up.held += chunk.length;
        if (!this.makeRoom(key)) { this.uploads.delete(key); return { ok: false, code: "unavailable", message: "this runtime is holding as many files as it can; send it again shortly" }; }
        if (up.chunks.size < up.count) return { ok: true, held: up.chunks.size, complete: false };
        this.uploads.delete(key);
        if (up.held !== up.bytes) return { ok: false, code: "invalid", message: `the chunks of ${c.sha256} are ${up.held} bytes, not ${up.bytes}` };
        const data = new Uint8Array(up.bytes);
        let at = 0;
        for (let i = 0; i < up.count; i++) { const part = up.chunks.get(i)!; data.set(part, at); at += part.length; }
        if (await sha256Hex(data) !== c.sha256) return { ok: false, code: "invalid", message: `the chunks do not hash to ${c.sha256}; send the file again` };
        this.done.set(c.sha256, { data, touched: this.now() });
        this.makeRoom(null);
        return { ok: true, held: up.count, complete: true };
    }

    /** Which chunks of a file `from` has sent (all of them, when the file is complete). */
    have(from: string, sha256: string): { held: number[]; count: number; complete: boolean } {
        this.sweep();
        const done = this.done.get(sha256);
        if (done) return { held: [], count: 0, complete: true };
        const up = this.uploads.get(`${from}:${sha256}`);
        return up ? { held: [...up.chunks.keys()].sort((a, b) => a - b), count: up.count, complete: false } : { held: [], count: 0, complete: false };
    }

    /** A complete file's bytes, or null when this runtime does not hold it. Kept, so the same file attached again is
     *  not sent again. */
    get(sha256: string): Uint8Array | null {
        this.sweep();
        const done = this.done.get(sha256);
        if (!done) return null;
        done.touched = this.now();
        return done.data;
    }

    /** How many bytes are held, in progress and done. */
    heldBytes(): number {
        let n = 0;
        for (const u of this.uploads.values()) n += u.held;
        for (const d of this.done.values()) n += d.data.length;
        return n;
    }

    private badPut(c: FilePut, chunk: Uint8Array): string | null {
        if (typeof c.sha256 !== "string" || !SHA256.test(c.sha256)) return "sha256 must be 64 lowercase hex digits";
        if (!Number.isSafeInteger(c.bytes) || c.bytes < 1) return "bytes must be a positive whole number";
        if (c.bytes > this.limits.maxFileBytes) return `a file may be up to ${this.limits.maxFileBytes} bytes; this one is ${c.bytes}`;
        if (!Number.isSafeInteger(c.count) || c.count < 1 || c.count > c.bytes) return "count must be a whole number from 1 to the file's bytes";
        if (!Number.isSafeInteger(c.index) || c.index < 0 || c.index >= c.count) return "index must be a whole number below count";
        if (!chunk.length) return "a chunk carries at least one byte";
        return null;
    }

    /** Drop what has not been touched within the TTL. */
    private sweep(): void {
        const cut = this.now() - this.limits.ttlMs;
        for (const [k, u] of this.uploads) if (u.touched < cut) this.uploads.delete(k);
        for (const [k, d] of this.done) if (d.touched < cut) this.done.delete(k);
    }

    /** Drop the least recently touched files, never `keep`, until the total fits. False when it cannot. */
    private makeRoom(keep: string | null): boolean {
        while (this.heldBytes() > this.limits.maxTotalBytes) {
            let oldest: { map: Map<string, Upload | Done>; key: string; at: number } | null = null;
            for (const [k, u] of this.uploads) if (k !== keep && (!oldest || u.touched < oldest.at)) oldest = { map: this.uploads, key: k, at: u.touched };
            for (const [k, d] of this.done) if (!oldest || d.touched < oldest.at) oldest = { map: this.done, key: k, at: d.touched };
            if (!oldest) return false;
            oldest.map.delete(oldest.key);
        }
        return true;
    }
}

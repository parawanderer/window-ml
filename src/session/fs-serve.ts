// fs-serve.ts — the offscreen document's side of `ml.fs`: a reader channel per isolated exec, its session set from the worker's message, serving the read ops alone (FILE_ATTACHMENTS.md, "`ml.fs`").

// The worker names the exec by a key it minted (sw-fs-call.ts) and the session from its own run record; this side holds
// one channel per key, so a descriptor an exec opened is that exec's, and closes with it (`end`), when it has sat idle
// past `FS_IDLE_MS`, or when more than `FS_CHANNELS_MAX` are open (the oldest first). A key keeps the session it was
// opened with. Every read passes through the reader's own read, which masks every secret form (secret-mask.ts).

import { FILES_CHUNK, type FilesChannel } from "../python/files-reader";
import { FS_READ_OPS, type FsReadOp } from "../ml/ml-fs";

/** How long an exec's channel may sit unused before it is closed: an exec whose `FS_END` never came (a worker evicted). */
export const FS_IDLE_MS = 10 * 60 * 1000;

/** The most exec channels open at once; past it the least recently used closes. */
export const FS_CHANNELS_MAX = 32;

/** An answer: the reader's data, or its errno code alone. */
export type FsServeAnswer = { ok: unknown } | { code: string };

/** Bytes as base64: the message channel is JSON. */
function toB64(b: Uint8Array): string {
    let s = "";
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
}

/**
 * The server for `ml.fs`'s channels.
 * @param open opens a channel on the reader's "files" volume
 * @param now the clock
 * @returns `call` for an `FS_CALL`, `end` for an `FS_END`, and `size` (open channels, for tests)
 */
export function fsServer(open: () => FilesChannel, now: () => number = Date.now) {
    const chans = new Map<string, { channel: FilesChannel; session: string; last: number }>();   // state: plumbing — an exec's channel, closed with it
    const drop = (key: string) => {
        const c = chans.get(key);
        if (!c) return;
        chans.delete(key);
        try { c.channel.dispose(); } catch { /* the reader is gone too */ }
    };
    const sweep = () => {
        const t = now();
        for (const [k, c] of chans) if (t - c.last > FS_IDLE_MS) drop(k);
        while (chans.size > FS_CHANNELS_MAX) drop(chans.keys().next().value as string);
    };
    return {
        /**
         * One read op for one exec.
         * @param key the exec's key
         * @param session the run's session, as the worker read it
         * @param op the op
         * @param args its arguments, checked by the worker (iso-channel.ts `fsArgsOk`)
         */
        async call(key: unknown, session: unknown, op: unknown, args: unknown): Promise<FsServeAnswer> {
            if (typeof key !== "string" || !key || typeof session !== "string" || !session || !(FS_READ_OPS as readonly unknown[]).includes(op) || !Array.isArray(args)) return { code: "EINVAL" };
            sweep();
            let c = chans.get(key);
            // A key keeps its session: one that names another is not this exec's.
            if (c && c.session !== session) return { code: "EBADF" };
            if (!c) {
                const channel = open();
                channel.setSession(session);
                c = { channel, session, last: now() };
            }
            // Most recently used last, so the oldest is first to go.
            chans.delete(key);
            c.last = now();
            chans.set(key, c);
            sweep();
            const ch = c.channel, a = args as any[];
            try {
                switch (op as FsReadOp) {
                    case "stat": return { ok: await ch.stat(a[0]) };
                    case "opendir": return { ok: await ch.opendir(a[0], { limit: a[1]?.limit, ...(typeof a[1]?.cursor === "string" ? { cursor: a[1].cursor } : {}) }) };
                    case "open": return { ok: await ch.open(a[0]) };
                    case "fstat": return { ok: await ch.fstat(a[0]) };
                    case "close": return { ok: await ch.close(a[0]) ?? null };
                    case "read": {
                        const dest = new Uint8Array(Math.min(Math.max(0, Number(a[2]) || 0), FILES_CHUNK));
                        const n = await ch.read(a[0], a[1], dest.length, dest);
                        return { ok: { n, b64: toB64(dest.subarray(0, n)) } };
                    }
                }
            } catch (e) {
                const code = (e as { code?: unknown })?.code;
                return { code: typeof code === "string" && /^E[A-Z]+$/.test(code) ? code : "EIO" };
            }
        },
        /** An exec's end: its channel closes every descriptor it opened. */
        end(key: unknown): void { if (typeof key === "string") drop(key); },
        /** How many exec channels are open. */
        size: () => chans.size,
    };
}

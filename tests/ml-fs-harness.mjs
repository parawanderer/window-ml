// ml-fs-harness.mjs — `ml.fs` over every layer it crosses, in one process: the world's facade (ml-fs.ts), the call's
// server in the worker (iso-channel.ts), the worker's relay (sw-fs-call.ts), the offscreen document's server
// (fs-serve.ts) and the reader (ranged-reader.ts), with a fake shelf as the reader's source. Used by ml-fs.test.mjs and
// ml-fs-parity.test.mjs.
import { RangedReader } from "../src/session/ranged-reader.ts";
import { fsServer } from "../src/session/fs-serve.ts";
import { fsCallFor } from "../src/sw/sw-fs-call.ts";
import { isoServer } from "../src/sw/iso-channel.ts";
import { mlFs } from "../src/ml/ml-fs.ts";

const enc = new TextEncoder();

/**
 * A session's files behind `ml.fs`.
 * @param o.sessions each session's attachments: `{ handle, name, bytes (string or Uint8Array), attachedMs? }`
 * @param o.forms the secrets' forms the reader masks (secret-mask.ts `SecretForm`)
 * @param o.runId the run whose session the reads are of (default "s1")
 * @returns `fs` (ml.fs), `ask` (the world's raw channel, as a script that bypasses the facade would call it), `serve`
 *   (the iso server), `server` (the offscreen side), `sent` (every message the relay sent), `end` (the exec's end)
 */
export function fsOver({ sessions = {}, forms = [], runId = "s1" } = {}) {
    const data = {}, rows = {};
    for (const [s, files] of Object.entries(sessions)) {
        rows[s] = files.map((f, i) => {
            const bytes = typeof f.bytes === "string" ? enc.encode(f.bytes) : f.bytes;
            const key = `${s}:${f.handle}:${i}`;
            data[key] = bytes;
            return { handle: f.handle, name: f.name, key, bytes: bytes.length, sha256: `sha-${key}`, attachedMs: f.attachedMs ?? 5000 };
        });
    }
    const source = { attached: async (s) => rows[s] ?? [], blob: async (k) => new Blob([data[k]]), secretForms: async () => forms };
    const reader = new RangedReader({ source, now: () => 1000 });
    const server = fsServer(() => reader.openChannel("files"));
    const sent = [];
    const relay = fsCallFor(runId, {
        send: async (m) => {
            sent.push(m);
            if (m.type === "FS_CALL") return server.call(m.key, m.session, m.op, m.args);
            server.end(m.key);
            return undefined;
        },
    });
    const serve = isoServer(runId, [], { deref: () => undefined, holders: async () => null, columns: async () => ({ rowCount: 0, columns: {} }), fs: relay.fs });
    // As the wrapper's `__chanAsk` does (sw-isolated-exec.ts): an error answer throws, carrying its code.
    const ask = async (req) => {
        const r = await serve(req);
        if (typeof r.error === "string") { const e = new Error(r.error); if (typeof r.code === "string") e.code = r.code; throw e; }
        return r.ok;
    };
    const fs = mlFs((op, args) => ask({ op: "fs", call: op, args }));
    return { fs, ask, serve, server, sent, end: relay.end };
}

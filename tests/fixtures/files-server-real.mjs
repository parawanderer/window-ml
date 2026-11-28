// files-server-real.mjs — the offscreen document's half of `/files` on a thread of its own, as the product builds it: the
// real RangedReader over the real store of run-made files (agent-files.ts, on fake-indexeddb), served over the real
// channel (files-wire.ts `serveFiles`). files-server-thread.mjs serves the in-memory fake instead; this one is for the
// rows that must hold end to end, from Python's `open()` to a stored Blob.

import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

const { serveFiles } = await import("../../src/python/files-wire.ts");
const { RangedReader } = await import("../../src/session/ranged-reader.ts");
const { AgentFiles } = await import("../../src/session/agent-files.ts");
const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");

const session = workerData?.session ?? "s1";
const agent = new AgentFiles({ idb: new IDBFactory(), dbName: "real" });
const lost = [];
const reader = new RangedReader({
    source: { attached: async () => [], blob: async () => { throw new Error("no attachments here"); }, secretForms: async () => workerData?.forms ?? [] },
    agent,
    quotaBytes: async () => workerData?.quotaBytes ?? 1 << 30,
    onLost: (rec) => lost.push(rec),
});
let channel = null;
let handle = null;

/** What the test may ask between cells: a committed file's bytes, a file put as another front end would, the discards. */
const ops = {
    async committed(s, path) {
        const n = await agent.node(s, path.replace(/^agent\//, ""));
        return n?.kind === "file" ? new Uint8Array(await (await agent.blob(n.blob)).arrayBuffer()) : undefined;
    },
    async seed(s, path, text) { await agent.commit(s, [{ op: "put", path: path.replace(/^agent\//, ""), data: new Blob([text]) }]); return true; },
    async usage(s) { return agent.usage(s); },
    lost() { return lost; },
    dispose() { channel.dispose(); return true; },
};

parentPort.on("message", async (m) => {
    if (m?.shared) {
        channel = reader.openChannel("files");
        channel.setSession(session);
        handle = serveFiles(m.shared, channel).handle;
        parentPort.postMessage({ ready: true });
        return;
    }
    if (m?.ctl) {
        const { cid, op, args } = m.ctl;
        try {
            const value = await ops[op](...args);
            parentPort.postMessage({ cid, value: value instanceof Uint8Array ? Array.from(value) : value });
        } catch (e) { parentPort.postMessage({ cid, error: String(e?.message ?? e) }); }
        return;
    }
    handle?.(m);
});

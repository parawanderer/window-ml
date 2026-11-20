// files-server-thread.mjs — the offscreen document's half of `/files` on a thread of its own, for the mount's tests:
// the in-memory reader (files-channel-fake.mjs) served over the real channel (files-wire.ts `serveFiles`), so the
// Python worker on the test's main thread can block in its wait while this thread answers.

import { parentPort, workerData } from "node:worker_threads";

const { serveFiles } = await import("../../src/python/files-wire.ts");
const { makeFakeFiles } = await import("./files-channel-fake.mjs");

const files = makeFakeFiles({ quotaBytes: workerData?.quotaBytes ?? 1 << 30 });
let channel = null;
let handle = null;
/** How long the NEXT read is held (`holdNextRead(ms)`): it is answered late, after the worker may have given up on it. */
let holdNext = 0;

parentPort.on("message", async (m) => {
    if (m?.shared) {
        channel = files.channel();
        channel.setSession(workerData?.session ?? "s1");
        // The read the test holds stays unanswered for its time, so the worker blocks in its wait; later reads are not held.
        const real = channel.read.bind(channel);
        channel.read = async (...a) => {
            const ms = holdNext;
            holdNext = 0;
            if (ms) await new Promise((r) => setTimeout(r, ms));
            return real(...a);
        };
        handle = serveFiles(m.shared, channel).handle;
        parentPort.postMessage({ ready: true });
        return;
    }
    if (m?.ctl) {
        const { cid, op, args } = m.ctl;
        try {
            let value;
            if (op === "holdNextRead") { holdNext = Number(args[0] ?? 0); value = true; }
            else if (op === "dispose") { channel.dispose(); value = true; }
            else if (op === "reads") value = files.log.filter((e) => e[0] === "read").length;
            else if (op === "readCalls") value = files.log.filter((e) => e[0] === "read").map((e) => e.slice(1));
            else if (op === "log") value = files.log.map((e) => e[0]);
            else value = files[op](...args);
            parentPort.postMessage({ cid, value: value instanceof Uint8Array ? Array.from(value) : value });
        } catch (e) { parentPort.postMessage({ cid, error: String(e?.message ?? e) }); }
        return;
    }
    handle?.(m);
});

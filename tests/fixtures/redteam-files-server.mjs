// redteam-files-server.mjs — the offscreen document's half of `/files` on its own thread, as files-server-thread.mjs is, with
// the reader's whole log readable so a red-team row can assert what path the mount asked for.

import { parentPort, workerData } from "node:worker_threads";

const { serveFiles } = await import("../../src/python/files-wire.ts");
const { makeFakeFiles } = await import("./files-channel-fake.mjs");

const files = makeFakeFiles({ quotaBytes: workerData?.quotaBytes ?? 1 << 30 });
let channel = null;
let handle = null;

parentPort.on("message", async (m) => {
    if (m?.shared) {
        channel = files.channel();
        channel.setSession(workerData?.session ?? "s1");
        handle = serveFiles(m.shared, channel).handle;
        parentPort.postMessage({ ready: true });
        return;
    }
    if (m?.ctl) {
        const { cid, op, args } = m.ctl;
        try {
            let value;
            if (op === "log") value = files.log.map((e) => e.map((x) => (typeof x === "string" ? x : x && typeof x === "object" ? JSON.stringify(x) : x)));
            else if (op === "dispose") { channel.dispose(); value = true; }
            else value = files[op](...args);
            parentPort.postMessage({ cid, value: value instanceof Uint8Array ? Array.from(value) : value });
        } catch (e) { parentPort.postMessage({ cid, error: String(e?.message ?? e) }); }
        return;
    }
    handle?.(m);
});

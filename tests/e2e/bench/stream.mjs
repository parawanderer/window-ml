// stream.mjs — a held bench run's screen, served to whoever is watching it on the bench page.
//
// A held run's process (hold.mjs) serves `GET /stream` on a local port, and the bench page's server (serve.mjs) passes it
// through to the page as `/held/<pid>/stream`. The body is a run of frames, each a 4-byte big-endian length and a JPEG,
// which the page decodes as they come (page/frames.ts `readScreenFrames`). Capture runs only while someone is connected: the first viewer
// starts it, the last one leaving stops it, so a held run nobody watches costs nothing. A new viewer gets the last frame
// at once, since a page that is not changing sends none. A viewer that stops reading is skipped until its socket drains,
// then sent the newest frame, never a backlog.

import { createServer } from "node:http";

/** One frame on the wire: its length, then the JPEG. */
export const frameBytes = (jpeg) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(jpeg.length);
    return Buffer.concat([head, jpeg]);
};

/**
 * Serve a screen on 127.0.0.1. `start(onFrame)` begins capturing and resolves a function that stops it (run-once's
 * `ctl.screencast`); it is called when the first viewer connects and stopped when the last one leaves.
 * @param {(onFrame: (jpeg: Buffer) => void) => Promise<() => Promise<void>>} start
 * @returns {Promise<{ port: number, viewers: () => number, close: () => Promise<void> }>}
 */
export async function serveScreen(start) {
    const viewers = new Set();
    let last = null, stop = null, starting = null;
    const send = (v, frame) => {
        if (v.behind) { v.pending = frame; return; }
        if (!v.res.write(frame)) v.behind = true;
    };
    const onFrame = (jpeg) => {
        last = frameBytes(jpeg);
        for (const v of viewers) send(v, last);
    };
    const begin = () => { starting ??= start(onFrame).then((s) => { stop = s; }).catch(() => {}); return starting; };
    const end = async () => {
        await starting;
        if (viewers.size) return;   // someone came back while it was starting: keep it
        starting = null;
        const s = stop;
        stop = null;
        await s?.().catch(() => {});
    };
    const server = createServer(async (req, res) => {
        if (new URL(req.url, "http://x").pathname !== "/stream") { res.writeHead(404).end(); return; }
        res.writeHead(200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
        res.flushHeaders();   // else Node holds them until the first frame, and a viewer of a still page waits forever
        const v = { res, behind: false, pending: null };
        res.on("drain", () => {
            v.behind = false;
            const p = v.pending;
            v.pending = null;
            if (p) send(v, p);
        });
        viewers.add(v);
        if (last) send(v, last);
        req.on("close", () => {
            viewers.delete(v);
            if (!viewers.size) end();
        });
        await begin();
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return {
        port: server.address().port,
        viewers: () => viewers.size,
        close: async () => {
            for (const v of viewers) v.res.end();
            viewers.clear();
            await end();
            await new Promise((r) => { server.close(() => r()); server.closeAllConnections(); });
        },
    };
}


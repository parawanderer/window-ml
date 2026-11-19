// reader-worker.js — stands in for the Pyodide worker in measure-ranged.mjs: it receives transferred chunks, touches one
// byte of each, and keeps at most `cacheChunks` of them (the mount's bounded cache), dropping the oldest.
let cache = [], cacheChunks = 0, bytes = 0, seen = 0;
onmessage = (e) => {
    const m = e.data;
    if (m.op === "config") { cacheChunks = m.cacheChunks; cache = []; bytes = 0; postMessage({ ok: true }); return; }
    if (m.op === "chunk") {
        const u = new Uint8Array(m.buf);
        bytes += u[u.length >> 1] >= 0 ? u.length : 0;
        if (cacheChunks) { cache.push(m.buf); if (cache.length > cacheChunks) cache.shift(); }
        if (typeof gc === "function" && (++seen % 32) === 0) gc();   // under --gc: collect as the reader goes
        postMessage({ id: m.id });
    }
    if (m.op === "stats") postMessage({ bytes, cached: cache.length });
};

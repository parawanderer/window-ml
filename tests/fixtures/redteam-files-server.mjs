// redteam-files-server.mjs — the offscreen document's half of `/files` on its own thread, as files-server-thread.mjs is, with
// the reader's whole log readable so a red-team row can assert what path the mount asked for. It can also serve MASKED
// names (`ctl("forms", …)`): the fake lists and resolves them the reader's way, so a row can drive the mount with two
// files under one shown name. The rule itself is the reader's (ranged-reader.ts `lookup`), held by its own row
// (ranged-reader-names.test.mjs); this mirror exists only to give the mount a channel that answers as the reader does.

import { parentPort, workerData } from "node:worker_threads";

const { serveFiles } = await import("../../src/python/files-wire.ts");
const { makeFakeFiles } = await import("./files-channel-fake.mjs");
const { maskName } = await import("../../src/secret-mask.ts");

const files = makeFakeFiles({ quotaBytes: workerData?.quotaBytes ?? 1 << 30 });
let channel = null;
let handle = null;

/** The fake behind the reader's name rule: a listing shows each name's mask, and a path resolves by the same rule —
 *  the child stored under exactly that name, else the single child whose shown name it is, two or more EACCES. */
function masked(fake) {
    let forms = [];
    const shown = (n) => maskName(n, forms);
    /** The stored path a caller's path names (`syscall` names the row's question). Read side only: rows here do not
     *  write through a shown name. */
    async function stored(p, syscall) {
        if (typeof p !== "string" || p === "") return p;
        let at = "";
        for (const seg of p.split("/")) {
            const cand = at ? `${at}/${seg}` : seg;
            if (await fake.stat(cand).then(() => true, () => false)) { at = cand; continue; }
            const names = at ? (await fake.opendir(at, { limit: 1000 })).entries.map((e) => e.name) : [];
            const hits = names.filter((n) => shown(n) === seg);
            if (hits.length > 1) {
                throw Object.assign(new Error(`EACCES: '${p}' is ambiguous, ${hits.length} files`), { code: "EACCES", syscall, path: p });
            }
            at = hits.length === 1 ? (at ? `${at}/${hits[0]}` : hits[0]) : cand;   // no match: a create, kept as written
        }
        return at;
    }
    return new Proxy(fake, {
        get(t, k) {
            if (k === "setForms") return (list) => { forms = list; return true; };
            const v = t[k];
            if (typeof v !== "function") return v;
            if (k === "opendir") return async (p, o) => {
                const page = await v.call(t, await stored(p, "opendir"), o);
                return { ...page, entries: page.entries.map((e) => ({ ...e, name: shown(e.name) })) };
            };
            if (k === "stat" || k === "open") return async (p, o) => v.call(t, await stored(p, k), o);
            return (...a) => v.apply(t, a);
        },
    });
}

parentPort.on("message", async (m) => {
    if (m?.shared) {
        channel = masked(files.channel());
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
            else if (op === "forms") { channel.setForms(args[0] ?? []); value = true; }
            else value = files[op](...args);
            parentPort.postMessage({ cid, value: value instanceof Uint8Array ? Array.from(value) : value });
        } catch (e) { parentPort.postMessage({ cid, error: String(e?.message ?? e) }); }
        return;
    }
    handle?.(m);
});

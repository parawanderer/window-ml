// box-stream.mjs — what the BOX did during a sweep, from the patched Ollama's event stream (`/api/events`): its memory
// readings and its own events (model loads with their two halves, evictions with the server's reason, serving spans,
// generations of any client). Read as the resource panel reads them: the worker's connection rules (sw-events.ts:
// base discovery, `?since=` to backfill a gap from the server's ring, backoff on a drop) and the panel's own
// derivation (`residentFrom`, `residencyOf`, `parseInfo` for a reading; `machineEventFrom` for an event).
//
// Every frame is also appended to the box log, `box.sqlite` beside the sweeps (insert-only, one row per frame, keyed
// by the box's id and the SERVER's clock, so a frame replayed on a reconnect, or seen by two sweeps watching one box,
// is stored once). The page bakes what this sweep saw; the log keeps the history across sweeps for the CLI.
//
// A server without the route (stock Ollama, a cloud API) falls back to polling `/api/ps` + `/api/info`
// (resource-poll.mjs); one without `/api/info` either gets no chart at all.

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startResourcePoll, packSamples } from "./resource-poll.mjs";

const { readFrames, sinceFor, lostSince, loadedFrom } = await import("../../../src/resource/resource-events.ts");
const { residencyOf, residentFrom } = await import("../../../src/resource/residency.ts");
const { parseInfo } = await import("../../../src/resource/resource-capacity.ts");
const { addMachineEvent } = await import("../../../src/resource/resource-lane.ts");
const { machineEventFrom, servingSince } = await import("../../../src/sidebar/resource/resource-feed.ts");

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The box log: every frame any sweep saw, beside the sweeps (gitignored with them). */
export const BOX_DB = path.resolve(HERE, "../artifacts/bench/box.sqlite");

/** The worker's retry ladder and the server's retained ring (sw-events.ts). */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
const RING_MS = 600_000;
/** A sweep keeps more of the box's events than the panel's window does: it is the record of hours, not minutes. */
const EVENTS_CAP = 20_000;

/**
 * The panel's derivation over a stream of frames: readings become samples (each with the capacity in force, the
 * previous one carried when a frame has none), edges become lane events (deduped, as the panel dedupes a replay).
 * `serving` spans still open are drawn to `now`, as the panel draws them.
 */
export function boxReducer() {
    const samples = [];
    let events = [];
    let capacity = null, previous = [], gapNext = false;
    return {
        /** One frame at its local wall clock; `lost` frames before it (the server's drop count) break the line. */
        push(frame, at, lost = 0) {
            if (lost) gapNext = true;
            if (frame.kind === "sample") {
                if (frame.info) capacity = parseInfo(frame.info) ?? capacity;
                const { loaded, placeholders } = residentFrom(loadedFrom(frame.ps?.models ?? []), previous);
                previous = loaded;
                if (!capacity) return;
                samples.push({ t: at, models: loaded.map(residencyOf), capacity, ...(placeholders.length ? { loading: placeholders } : {}), ...(gapNext ? { gapBefore: true } : {}) });
                gapNext = false;
                return;
            }
            const ev = machineEventFrom(frame, at);
            if (ev) events = addMachineEvent(events, { ...ev, via: ev.via ?? "server" }, EVENTS_CAP);
        },
        samples: () => samples,
        /** The box's events, with each serving span still open drawn to `now`. */
        events(now = Date.now()) {
            const open = Object.entries(servingSince.value).map(([model, t]) => ({ kind: "serve", t, until: now, open: true, model, label: `${model} serving`, via: "server" }));
            return open.length ? [...events, ...open] : events;
        },
    };
}

/** True when a response is the event stream rather than a 200 of something else (OpenWebUI's SPA answers any route). */
const servesNdjson = (res) => {
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    return res.ok && (ct.includes("ndjson") || ct.includes("jsonl") || ct.includes("event-stream"));
};

/** The Ollama base that answers `/api/ps`, in the worker's order (`<origin>/ollama`, then the origin). */
async function ollamaBase(origin, headers, fetchImpl) {
    for (const base of [`${origin}/ollama`, origin]) {
        try {
            const res = await fetchImpl(`${base}/api/ps`, { headers, signal: AbortSignal.timeout(5000) });
            if (res.ok && Array.isArray((await res.json())?.models)) return base;
        } catch { /* the next base */ }
    }
    return null;
}

/**
 * Hold a connection to `/api/events` until stopped, reconnecting with the server's ring to fill each gap. `onFrame`
 * gets every frame with its local wall clock, the server's clock (from the connection's `hello`) and the box's id.
 * Resolves `{ unsupported }` when the server has no such route, so the caller can poll instead.
 */
export function connectBoxStream(backend, { onFrame, fetchImpl = fetch, log = () => {} } = {}) {
    const origin = new URL(backend.chatUrl).origin;
    const headers = backend.key ? { authorization: `Bearer ${backend.key}` } : {};
    let stopped = false, abort = null, lastFrameAt = null, attempt = 0;
    const done = (async () => {
        while (!stopped) {
            try {
                const base = await ollamaBase(origin, headers, fetchImpl);
                if (!base) return { unsupported: "no Ollama API behind the backend" };
                abort = new AbortController();
                const res = await fetchImpl(`${base}/api/events?since=${sinceFor(lastFrameAt, Date.now(), RING_MS)}`, { headers, signal: abort.signal });
                if (!servesNdjson(res)) return { unsupported: `the server does not serve /api/events (HTTP ${res.status})` };
                attempt = 0;
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "", helloAt = null, serverAt = null, box = null, seen = 0;
                for (;;) {
                    const { value, done: end } = await reader.read();
                    if (end) break;
                    const { frames, rest } = readFrames(buffer, decoder.decode(value, { stream: true }));
                    buffer = rest;
                    for (const frame of frames) {
                        // Offsets are relative to this connection's hello, anchored at the instant it arrived (the worker's rule).
                        if (helloAt == null) helloAt = Date.now() - Math.min(0, frame.t);
                        if (frame.kind === "hello") { serverAt = Date.parse(frame.serverTime) - frame.t; box = frame.box ?? box; }
                        const at = helloAt + frame.t;
                        if (frame.t >= 0) lastFrameAt = Math.max(lastFrameAt ?? 0, at);
                        const { lost, seen: s } = lostSince(seen, frame);
                        seen = s;
                        onFrame(frame, { at, serverAt: serverAt != null && !Number.isNaN(serverAt) ? serverAt + frame.t : null, box: box ?? origin, lost });
                    }
                }
                log("  (box stream ended; reconnecting)");
            } catch (e) {
                if (stopped || e?.name === "AbortError") break;
                log(`  (box stream dropped: ${String(e?.message || e).slice(0, 80)}; reconnecting)`);
            }
            if (stopped) break;
            await new Promise((r) => setTimeout(r, RETRY_MS[Math.min(attempt++, RETRY_MS.length - 1)]));
        }
        return { stopped: true };
    })();
    return { done, stop() { stopped = true; abort?.abort(); } };
}

/**
 * The box log, created if need be; null on a Node without `node:sqlite`. One row per frame: the box's id, the frame's
 * time on the SERVER's clock (the key that survives a reconnect), its local time, its kind, and the frame verbatim.
 */
export async function openBoxLog(file = BOX_DB) {
    let DatabaseSync;
    try { ({ DatabaseSync } = await import("node:sqlite")); } catch { return null; }
    await mkdir(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE IF NOT EXISTS frames (
        id INTEGER PRIMARY KEY,
        box TEXT NOT NULL,          -- the server's own id for the box (hello.box), else the backend's origin
        server_at INTEGER,          -- the frame's time on the server's clock (ms); null before a hello
        at INTEGER NOT NULL,        -- when it happened on this machine's clock (ms), as the page draws it
        kind TEXT NOT NULL,
        frame TEXT NOT NULL,        -- the frame as it arrived
        digest TEXT NOT NULL,       -- of the frame without its connection-relative fields, for the key
        UNIQUE (box, server_at, kind, digest)
    );
    CREATE INDEX IF NOT EXISTS frames_at ON frames (box, at);`);
    return db;
}

/** Append frames to the log; a frame already there (the same box, server time, kind and content) is skipped. */
export function logFrames(db, rows) {
    const ins = db.prepare("INSERT OR IGNORE INTO frames (box, server_at, at, kind, frame, digest) VALUES (?, ?, ?, ?, ?, ?)");
    let added = 0;
    for (const { frame, at, serverAt, box } of rows) {
        // `t` and `backfilled` say how THIS connection delivered it, not what it was: left out of the identity.
        const { t: _t, backfilled: _b, ...what } = frame;
        const digest = createHash("sha256").update(JSON.stringify(what)).digest("hex").slice(0, 16);
        added += Number(ins.run(box, serverAt, at, frame.kind, JSON.stringify(frame), digest).changes);
    }
    return added;
}

/**
 * Watch the box for a sweep: the stream when the server has it (frames into the reducer and the log), else polling
 * `/api/ps` + `/api/info`. `resources()` is what the page draws: packed samples and the box's own events.
 */
export function startBox(backend, { db = null, fetchImpl = fetch, log = () => {}, flushMs = 2000 } = {}) {
    const reducer = boxReducer();
    let pending = [], mode = "stream", poll = null, packed = null, packedAt = -1;
    const flush = () => { if (db && pending.length) { try { logFrames(db, pending); } catch { /* the log is a record, never the sweep's failure */ } } pending = []; };
    const flusher = setInterval(flush, flushMs);
    const stream = connectBoxStream(backend, {
        fetchImpl, log,
        onFrame: (frame, { at, serverAt, box, lost }) => { reducer.push(frame, at, lost); pending.push({ frame, at, serverAt, box }); },
    });
    let stopped = false;
    // A server with no stream says so (however long finding its base took): poll it instead.
    stream.done.then((r) => {
        if (!r?.unsupported || stopped) return;
        mode = "poll";
        log(`  (box: ${r.unsupported}; polling /api/ps and /api/info instead)`);
        poll = startResourcePoll(backend, { fetchImpl });
    });
    return {
        get mode() { return mode; },
        resources() {
            if (poll) return poll.samples();
            const s = reducer.samples();
            if (packedAt !== s.length) { packedAt = s.length; packed = packSamples(s); }
            return packed ? { ...packed, events: reducer.events() } : null;
        },
        stop() { stopped = true; stream.stop(); poll?.stop(); clearInterval(flusher); flush(); },
    };
}

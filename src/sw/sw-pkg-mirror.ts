// sw-pkg-mirror.ts — python_install's network and its mirror: the host-locked reads of PyPI's index and wheels, and the IndexedDB store of the wheels a person approved, each kept by the sha256 its card showed.

// docs/plan/repl/PACKAGES_INSTALL.md, slice 3. Two hosts only: the index from pypi.org (read on python_install's
// precheck, before approval: ruled 2026-11-12, one card, bounded per call and per run, each request in the run log) and
// wheels from files.pythonhosted.org (after approval only). No credentials and no redirects. A wheel's body is counted as
// it streams and dropped past the size the card showed; its sha256 is computed over those bytes and must equal the
// card's before anything is stored. The mirror holds approved BYTES, not an approved install: a held wheel still goes
// through the card for every run that asks, shown as `mirror`, and is not downloaded again.

import { defineState } from "../state-registry";
import { FILES_HOST, INDEX_BOUNDS, INDEX_HOST, IndexRunCap, type IndexGet } from "../python/pkg-index";
import { MirrorRow, wheels, done, digest } from "../python/pkg-mirror-db";

/** What the state inspector shows of a held wheel: everything but the bytes. */
type MirrorSummary = Omit<MirrorRow, "bytes">;

// state: cache — the rows the mirror holds, without their bytes, as this worker last read or wrote them; re-read after an eviction
let held: Map<string, MirrorSummary> | null = null;

defineState({
    id: "packages.mirror", scope: "browser", realm: "worker", audience: "human", lostOn: [],
    describe: "Python wheels downloaded from PyPI after a person approved them on a python_install card, each kept by the sha256 the card showed and checked against it: approved bytes, not an approved install (every run that asks still gets the card).",
    read: () => (held?.size ? [...held.values()].map((r) => ({ ...r })) : undefined),
});

/**
 * The digests the mirror holds. Read once per worker, then kept current by `ensureWheel`.
 * @returns the set of sha256s, empty without IndexedDB
 */
export async function mirroredDigests(): Promise<Set<string>> {
    if (!held) {
        const st = await wheels("readonly");
        const rows = st ? await done(st.getAll()) as MirrorRow[] : [];
        held = new Map(rows.map(({ bytes: _b, ...r }) => [r.sha256, r]));
    }
    return new Set(held.keys());
}

/**
 * Read a response's body, at most `max` bytes: past it the read is cancelled and this throws.
 * @param res the response
 * @param max the most bytes accepted
 * @returns the bytes
 */
async function boundedBody(res: Response, max: number): Promise<Uint8Array> {
    const len = res.headers.get("content-length");
    if (len !== null && /^\d+$/.test(len) && Number(len) > max) { await res.body?.cancel(); throw new Error(`the body is larger than ${max} bytes`); }
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array(0);
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        n += value.byteLength;
        if (n > max) { await reader.cancel(); throw new Error(`the body is larger than ${max} bytes`); }
        chunks.push(value);
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.byteLength; }
    return out;
}

/** The fetch options every request here uses: no cookies or auth, no redirect followed. */
const LOCKED: RequestInit = { credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" };

const runRequests = new Map<string, number>();   // state: plumbing — index requests made per run, for the per-run cap. Dies with the worker: an eviction (~30 s idle) resets it, so the cap holds per idle pause, which a loop of calls cannot make (it keeps the worker alive); every request stays in the run log (ruled 2026-11-12)

/**
 * The index reader for one run's python_install check: https on pypi.org only, each request counted against the run's
 * cap and reported to `log` before it is made. A 404 is `null`; anything else that is not a JSON answer throws.
 * @param runId the run
 * @param log called with each URL before it is requested
 * @returns the reader `resolveVerdict` takes
 */
export function indexGetFor(runId: string, log: (url: string) => void): IndexGet {
    return async (url) => {
        const u = new URL(url);
        if (u.protocol !== "https:" || u.hostname !== INDEX_HOST || u.port !== "") throw new Error("not the index");
        const n = (runRequests.get(runId) ?? 0) + 1;
        if (n > INDEX_BOUNDS.perRun) throw new IndexRunCap();
        runRequests.set(runId, n);
        log(url);
        const res = await fetch(url, { ...LOCKED, headers: { accept: "application/json" } });
        if (res.status === 404) { await res.body?.cancel(); return null; }
        if (!res.ok) { await res.body?.cancel(); throw new Error(`the index answered ${res.status}`); }
        return JSON.parse(new TextDecoder().decode(await boundedBody(res, INDEX_BOUNDS.body)));
    };
}

/** One file to make sure of: a PyPI row of an approved card, and the URL its index answer gave. */
export interface WheelWant { name: string; version: string; filename: string; size: number; sha256: string; url: string }

const inflight = new Map<string, Promise<"held" | "downloaded">>();   // state: plumbing — a download in progress by digest, so a second request for it waits on the first

/**
 * Make sure the mirror holds a wheel: nothing to do when it already does, else download it from files.pythonhosted.org
 * and store it only when its size and sha256 are the card's. Two calls for one digest share one download.
 * @param w the file, as the approved card showed it
 * @returns whether it was already held or downloaded now; throws, keeping nothing, when it cannot be had
 */
export function ensureWheel(w: WheelWant): Promise<"held" | "downloaded"> {
    const running = inflight.get(w.sha256);
    if (running) return running;
    const p = (async (): Promise<"held" | "downloaded"> => {
        if ((await mirroredDigests()).has(w.sha256)) return "held";
        const u = new URL(w.url);
        if (u.protocol !== "https:" || u.hostname !== FILES_HOST || u.port !== "" || !u.pathname.endsWith(`/${w.filename}`)) throw new Error("not a wheel URL");
        const res = await fetch(w.url, LOCKED);
        if (!res.ok) { await res.body?.cancel(); throw new Error(`the download answered ${res.status}`); }
        const bytes = await boundedBody(res, w.size);
        if (bytes.byteLength !== w.size) throw new Error(`${w.filename} is ${bytes.byteLength} bytes, not the ${w.size} the card showed`);
        const buf = bytes.buffer as ArrayBuffer;
        if (await digest(buf) !== w.sha256) throw new Error(`${w.filename} does not match the sha256 the card showed`);
        const row: MirrorRow = { sha256: w.sha256, name: w.name, version: w.version, filename: w.filename, size: w.size, bytes: new Blob([buf]), stored: Date.now() };
        const st = await wheels("readwrite");
        if (!st) throw new Error("there is no mirror to keep it in");
        await done(st.put(row));
        const { bytes: _b, ...summary } = row;
        held?.set(w.sha256, summary);
        return "downloaded";
    })().finally(() => inflight.delete(w.sha256));
    inflight.set(w.sha256, p);
    return p;
}

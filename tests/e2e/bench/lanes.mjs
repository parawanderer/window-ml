// lanes.mjs — a sweep run in per-model LANES: each model's cells one after another, different models side by side, a
// lane starting its next cell only when the box says its model fits beside what is loaded (`/api/fits` on the patched
// Ollama, through Open WebUI as `/ollama/api/fits`). Two models on one box are only free to run at once when neither
// displaces the other; the same model takes turns anyway (one generation slot), which is why a lane is one model.
// What the endpoint answers and why it is a snapshot: mlbox's reports/ui-api/concurrent-bench-runs-answer.md.

/**
 * Ask the box whether `model` can be loaded now without displacing anything: `{ go, local, why }`. `go` is true when it
 * fits (or is already resident), false when it would displace something, and null when the box cannot say (a stock
 * Ollama with no `/api/fits`), in which case the caller runs one local model at a time. A model the server lists as not
 * Ollama's (a cloud model) is not on the box at all: `go: true, local: false`.
 * @param {{ chatUrl: string, key?: string }} backend
 * @param {Map<string, { local: boolean | null }>} info what the server says about each model (scores.mjs `modelInfo`)
 */
export function fitsGate(backend, info = new Map(), fetchImpl = fetch) {
    const origin = new URL(backend.chatUrl).origin;
    const headers = backend.key ? { authorization: `Bearer ${backend.key}` } : {};
    return async (model) => {
        if (info.get(model)?.local === false) return { go: true, local: false, why: "not on the box (a cloud model)" };
        for (const base of [`${origin}/ollama`, origin]) {
            let res, body;
            try {
                res = await fetchImpl(`${base}/api/fits?model=${encodeURIComponent(model)}`, { headers, signal: AbortSignal.timeout(10_000) });
                body = await res.json();
            } catch { continue; }   // not JSON (a SPA's HTML for an unknown route) or no answer: the next base
            if (res.ok && typeof body?.fits === "boolean") {
                return {
                    go: body.fits, local: true, resident: !!body.resident,
                    why: body.fits ? (body.resident ? "already loaded" : `fits${body.gpu_ids?.length ? ` on GPU ${body.gpu_ids.join("+")}` : ""}`)
                        : `would displace ${(body.displaces ?? []).join(", ") || "something loaded"}`,
                };
            }
            // Ollama does not know the model, and the server does not list it as Ollama's either: not on the box.
            if (res.status === 404 && /not found/i.test(String(body?.detail ?? body?.error ?? "")) && info.get(model)?.local !== true) {
                return { go: true, local: false, why: "not an Ollama model" };
            }
        }
        return { go: null, local: true, why: "the box cannot say whether it fits (no /api/fits)" };
    };
}

/**
 * Run `cells` in lanes, one per `modelOf(cell)`, at most `maxLanes` running at once. Each lane asks `gate(model)` before
 * each cell. A lane goes when the answer is yes; when the box cannot say, only while no other LOCAL cell runs; when it is
 * no, only once nothing else runs (as one job would). Otherwise it waits for a running cell to end, or `retryMs`, and
 * asks again, since another client can change the answer.
 *
 * Admission is one lane at a time, and a lane admitted for a model that was not yet loaded holds it until the model is
 * (`settle`): two lanes asking at once would both be told "fits" for a pair that does not.
 * @returns {Promise<unknown[]>} `fn`'s results, by cell index
 */
export async function runLanes(cells, { modelOf, gate, fn, maxLanes = Infinity, retryMs = 15_000, settle = async () => {}, log = () => {} }) {
    const lanes = new Map();
    cells.forEach((cell, i) => {
        const m = modelOf(cell) ?? "";
        if (!lanes.has(m)) lanes.set(m, []);
        lanes.get(m).push(i);
    });
    const out = new Array(cells.length);
    let running = 0, localRunning = 0;
    let wake = () => {};
    const changed = () => { const w = wake; wake = () => {}; w(); };
    const waitForChange = () => new Promise((r) => { const t = setTimeout(r, retryMs); const prev = wake; wake = () => { clearTimeout(t); prev(); r(); }; });
    // One admission at a time (the ask, and the settle after a start), but never held while a lane WAITS: a lane that
    // does not fit must not keep a lane that does from asking.
    let lock = Promise.resolve();
    const exclusive = (f) => { const p = lock.then(f); lock = p.catch(() => {}); return p; };

    /** Wait for this lane's turn to start `model`; resolves whether it runs as a local model. */
    const admit = async (model) => {
        for (let waited = false; ; waited = true) {
            const local = running < maxLanes ? await exclusive(async () => {
                if (running >= maxLanes) return undefined;   // filled while this lane waited for the lock
                const r = await gate(model);
                const go = r.go === true || (r.go === null && localRunning === 0) || (r.go === false && running === 0);
                if (!go) { if (!waited) log(`  ⏸ lane ${model || "(default model)"}: waits (${r.why})`); return undefined; }
                if (waited || r.go !== true) log(`  ▸ lane ${model || "(default model)"}: starts (${r.why})`);
                running++;
                if (r.local) localRunning++;
                // A model that was not loaded is about to be: the next lane asks once it is.
                if (r.local && !r.resident) await settle(model);
                return !!r.local;
            }) : undefined;
            if (local !== undefined) return local;
            await waitForChange();
        }
    };

    await Promise.all([...lanes].map(async ([model, idxs]) => {
        for (const i of idxs) {
            const local = await admit(model);
            try { out[i] = await fn(cells[i], i); }
            finally { running--; if (local) localRunning--; changed(); }
        }
    }));
    return out;
}

/**
 * Wait until `model` is resident by the box's own answer (`gate`), up to `timeoutMs`: a load takes seconds, a very large
 * model about a minute. Gives up quietly; the next admission then asks anyway.
 */
export const settleUntilResident = (gate, { timeoutMs = 180_000, everyMs = 2000 } = {}) => async (model) => {
    for (const until = Date.now() + timeoutMs; Date.now() < until;) {
        if ((await gate(model).catch(() => null))?.resident) return;
        await new Promise((r) => setTimeout(r, everyMs));
    }
};

// resource-poll.mjs — what the box's memory did during a sweep, read the way the resource panel reads it: `/api/ps` (what
// is resident) and `/api/info` (each device's capacity and free bytes), polled from Node every couple of seconds, each
// pair turned into the panel's own `ResourceSample` by the panel's own parsers (`loadedFrom`, `residencyOf`,
// `parseInfo`). The page draws them with the panel's chart (page/memory.tsx), so the two cannot disagree about what a
// reading means.
//
// The routes and their order are the worker's (sw-llm.ts `fetchOllamaInfo`, `findOllamaBase`): OpenWebUI's `/ollama`
// passthrough first, then the origin itself (Ollama directly). A box that serves no `/api/info` (stock Ollama, a cloud
// API) gives no samples, and the page draws no chart: unknown, never zero.

const { loadedFrom } = await import("../../../src/resource/resource-events.ts");
const { residencyOf, residentFrom } = await import("../../../src/resource/residency.ts");
const { parseInfo } = await import("../../../src/resource/resource-capacity.ts");

/** How often the box is read. The panel polls `/api/ps` at this rate too. */
export const POLL_MS = 2000;

/** One reading's JSON from the first base that answers with JSON for `route`; null when none does. */
async function readJson(bases, route, headers, fetchImpl, ok = () => true) {
    for (const base of bases) {
        try {
            const res = await fetchImpl(`${base}${route}`, { headers, signal: AbortSignal.timeout(POLL_MS * 2) });
            if (!res.ok) continue;
            const body = await res.json();   // a non-JSON body is the SPA's HTML: the wrong route, not a reading
            if (ok(body)) return { base, body };
        } catch { /* the next base */ }
    }
    return null;
}

/**
 * One reading: the resident models and the capacity, as a sample. Null when the box serves no capacity: the chart is
 * drawn against a ceiling, and without one there is nothing honest to draw.
 */
export async function readSample(backend, { fetchImpl = fetch, now = Date.now, bases = null, previous = [] } = {}) {
    const origin = new URL(backend.chatUrl).origin;
    const tryBases = bases ?? [`${origin}/ollama`, origin];
    const headers = backend.key ? { authorization: `Bearer ${backend.key}` } : {};
    const t = now();
    const info = await readJson(tryBases, "/api/info", headers, fetchImpl, (b) => !!b?.compute?.system_compute);
    if (!info) return null;
    const capacity = parseInfo(info.body);
    if (!capacity) return null;
    const ps = await readJson([info.base], "/api/ps", headers, fetchImpl, (b) => Array.isArray(b?.models));
    // A `loading` row is no news about a model last read as resident (residentFrom): `previous` is that reading.
    const { loaded, placeholders } = residentFrom(loadedFrom(ps?.body.models ?? []), previous);
    return { t, models: loaded.map(residencyOf), capacity, loaded, ...(placeholders.length ? { loading: placeholders } : {}) };
}

/**
 * Poll the box until stopped. `samples()` is what has been read so far, in time order, with each distinct capacity kept
 * once (`packSamples`), ready for the page's state. Stops by itself after `maxMisses` readings in a row get nothing, so
 * a box with no `/api/info` costs a handful of requests, not one every two seconds for hours.
 */
export function startResourcePoll(backend, { everyMs = POLL_MS, maxMisses = 5, fetchImpl = fetch, onSample = () => {} } = {}) {
    const read = [];
    let misses = 0, timer = null, stopped = false, packed = null, packedAt = -1, previous = [];
    const tick = async () => {
        if (stopped) return;
        const r = await readSample(backend, { fetchImpl, previous }).catch(() => null);
        if (r) { const { loaded, ...s } = r; previous = loaded; read.push(s); misses = 0; onSample(s); }
        else if (++misses >= maxMisses && !read.length) { stopped = true; return; }
        if (!stopped) timer = setTimeout(tick, everyMs);
    };
    tick();
    return {
        // Packed once per new reading, not once per call: the live page is pushed its state on every run event.
        samples: () => (packedAt === read.length ? packed : (packedAt = read.length, packed = packSamples(read))),
        stop() { stopped = true; clearTimeout(timer); },
    };
}

/**
 * Samples for the page's state, small: each distinct capacity once in `capacities`, and each sample naming its by
 * index (`c`). A capacity carries the devices' free bytes, so it changes as memory does, but a box that sits still for
 * an hour is one capacity, not 1800 copies of it. `unpackSamples` (page/memory.tsx) puts them back.
 */
export function packSamples(samples) {
    const capacities = [], index = new Map();
    const packed = samples.map(({ capacity, ...rest }) => {
        const key = JSON.stringify(capacity);
        if (!index.has(key)) { index.set(key, capacities.length); capacities.push(capacity); }
        return { ...rest, c: index.get(key) };
    });
    return packed.length ? { capacities, samples: packed } : null;
}

const GiB = 1024 ** 3;
const gib = (b) => `${(b / GiB).toFixed(1)} GiB`;
const clock = (t) => new Date(t).toISOString().slice(11, 19);

/**
 * memory.md: what the page's memory chart shows, as text. Each pool's peak and mean use against its total (used is
 * total minus free, the figure the chart's pool lines draw), and each model's stretch in memory with its largest
 * footprint. Read from the same packed samples the page gets.
 */
export function memoryText(packed) {
    const out = ["# Memory during the sweep", ""];
    if (!packed?.samples.length) return out.concat(["No readings: the backend serves no `/api/info` (a stock Ollama or a cloud API), or the sweep ran against the fake model. The page draws no chart either."]).join("\n") + "\n";
    const all = packed.samples.map((s) => ({ ...s, capacity: packed.capacities[s.c] }));
    out.push(`${all.length} readings, every ${POLL_MS / 1000} s, ${clock(all[0].t)} to ${clock(all.at(-1).t)} (UTC). Read from \`/api/ps\` and \`/api/info\` and parsed as the resource panel parses them.`, "");
    out.push("| pool | total | peak used | at | mean used |", "| --- | --- | --- | --- | --- |");
    const pools = [
        ...all[0].capacity.devices.map((d) => ({ name: d.name, of: (c) => c.devices.find((x) => x.id === d.id) })),
        { name: "system RAM", of: (c) => c.host },
    ];
    for (const p of pools) {
        const used = all.flatMap((s) => { const x = p.of(s.capacity); return x ? [{ t: s.t, total: x.totalBytes, used: x.totalBytes - x.freeBytes }] : []; });
        if (!used.length) continue;
        const peak = used.reduce((a, b) => (b.used > a.used ? b : a));
        out.push(`| ${p.name} | ${gib(peak.total)} | ${gib(peak.used)} | ${clock(peak.t)} | ${gib(used.reduce((a, b) => a + b.used, 0) / used.length)} |`);
    }
    const models = new Map();
    for (const s of all) for (const m of s.models) {
        const e = models.get(m.model) ?? { from: s.t, to: s.t, peak: 0 };
        e.to = s.t; e.peak = Math.max(e.peak, m.vramBytes + m.ramBytes);
        models.set(m.model, e);
    }
    out.push("", "| model | first seen resident | last seen | largest footprint (VRAM + RAM) |", "| --- | --- | --- | --- |");
    for (const [m, e] of models) out.push(`| ${m} | ${clock(e.from)} | ${clock(e.to)} | ${gib(e.peak)} |`);
    if (!models.size) out.push("| (none resident) | | | |");
    // The box's own events, when the server has an event stream: what it loaded, dropped and served, from any client.
    const evs = (packed.events ?? []).filter((e) => e.kind !== "gen").sort((a, b) => a.t - b.t);
    if (packed.events) {
        out.push("", "## What the box reported", "", "From its event stream, whoever caused it (this sweep, another, a person's panel). Generations are left out here; the page draws them.", "");
        if (!evs.length) out.push("Nothing: no load, eviction or serving span over the sweep.");
        else {
            out.push("| at | what | model | took | detail |", "| --- | --- | --- | --- | --- |");
            for (const e of evs) {
                const phases = (e.phases ?? []).map((ph, i) => `${ph.kind} ${((ph.until - (i ? e.phases[i - 1].until : e.t)) / 1000).toFixed(1)} s`).join(", ");
                out.push(`| ${clock(e.t)} | ${e.kind} | ${e.model ?? ""} | ${e.until != null ? `${((e.until - e.t) / 1000).toFixed(1)} s${e.open ? " (still going)" : ""}` : ""} | ${[e.label, phases].filter(Boolean).join("; ").replace(/\|/g, "\\|")} |`);
            }
        }
    }
    return out.join("\n") + "\n";
}

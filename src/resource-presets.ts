// resource-presets.ts — what the resource panel can DRAW on a given box: the series each machine offers
// (`seriesCatalog`), the ready-made layouts built from them (`presetsFor`), and the rules that judge a layout
// (`kindRefusal`, `stackRefusal`, `presetRefusal`). The generator and the judge live together deliberately:
// a preset that proposes a stack the rule then refuses is an option the user can pick and immediately be told
// off for, which has shipped once, on the commonest hardware there is. Pure; a drift guard runs both over
// every shape in tests/fixtures/boxes.mjs.

import { ResourceSample, isCpuResident, Capacity } from "./resource-model";

/** What a series MEASURES: a device's memory, the host's, or a device's UTILIZATION — a share of TIME, not
 *  of capacity, which is why it never shares a track with the other two (see `kindRefusal`). */
export type SeriesScope = "device" | "host" | "util";

/** ONE line the panel can draw: what it measures, which pool it belongs to, and the ceiling it is drawn
 *  against. `seriesCatalog` derives every series a given machine offers; a track names them by `id`. */
export interface SeriesDef {
    id: string;
    label: string;
    scope: SeriesScope;
    /** Which pool this series measures — two series with different pools must not share a stacked axis. */
    pool: string;
    deviceId?: string;
    model?: string;
    capacityBytes: number | null;
}

/** Everything this box can actually plot, derived from the devices it reports rather than hardcoded — a
 *  one-device Mac and a two-card server produce different catalogs from the same code. */
export function seriesCatalog(sample: ResourceSample): SeriesDef[] {
    const cap = sample.capacity;
    const out: SeriesDef[] = [];
    // One pool → ONE capacity series. Offering a separate device and host series here would invite exactly the
    // double-count `stackRefusal` exists to block, so unified memory doesn't produce the pair in the first
    // place. Per-model series remain: `size_vram` still says what Ollama put on the GPU versus spilled.
    if (cap?.unified) {
        const dev = cap.devices[0];
        out.push({ id: "mem", label: `${dev?.name ?? "Memory"} · unified`, scope: "host", pool: "host", capacityBytes: cap.host.totalBytes });
        for (const m of sample.models) out.push({ id: `mem.${m.model}`, label: m.model, scope: "host", pool: "host", model: m.model, capacityBytes: cap.host.totalBytes });
        return out;
    }
    for (const d of cap?.devices ?? []) {
        out.push({ id: `vram.${d.id}`, label: d.name, scope: "device", pool: `device:${d.id}`, deviceId: d.id, capacityBytes: d.totalBytes });
        for (const m of sample.models) {
            if (!isCpuResident(m)) out.push({ id: `vram.${d.id}.${m.model}`, label: `${m.model} on ${d.name}`, scope: "device", pool: `device:${d.id}`, deviceId: d.id, model: m.model, capacityBytes: d.totalBytes });
        }
    }
    // HOW BUSY each card is — only for a card that reports a reading at all. Absent is "not read", and a series
    // for a card that never reports would be a line that is never drawn, or worse, one drawn at zero.
    for (const d of cap?.devices ?? []) {
        if (d.utilization && (d.utilization.gpuPercent != null || d.utilization.memoryPercent != null))
            out.push({ id: `util.${d.id}`, label: `${d.name} busy`, scope: "util", pool: `util:${d.id}`, deviceId: d.id, capacityBytes: null });
    }
    if (cap?.host) {
        out.push({ id: "ram", label: "System RAM", scope: "host", pool: "host", capacityBytes: cap.host.totalBytes });
        for (const m of sample.models) {
            if (m.ramBytes > 0) out.push({ id: `ram.${m.model}`, label: `${m.model} (CPU)`, scope: "host", pool: "host", model: m.model, capacityBytes: cap.host.totalBytes });
        }
    }
    return out;
}

/** ONE lane of the chart: which series share it, how they are combined, and how tall it is drawn. */
export interface TrackDef {
    id: string;
    series: string[];
    /** `stack` sums the series against one ceiling; `overlay` draws them independently, each on its own scale;
     *  `total` lays them END TO END up one axis — see {@link boxAxis}. */
    mode: "stack" | "overlay" | "total";
    heightPx: number;
}

/**
 * THE WHOLE BOX ON ONE AXIS, without pretending its memory is ONE pool.
 *
 * Pools DO combine: ollama splits a model too big for one card across several (by layer), and spills what
 * still does not fit into system RAM — the panel draws both. But not one-for-one, and that is what a single
 * combined figure hides: every extra card a model spans carries its own compute buffer (flat per device, not
 * pro-rated) and, on a card that held nothing, ~0.65 GiB of driver context; layers do not divide, so free
 * space smaller than the next layer is stranded; and a spill into RAM runs far slower, since those weights
 * cross PCIe on every token. So two cards with 20 GiB free each are not 40 GiB of room, and a GiB of RAM is
 * not a GiB of VRAM. The question behind "add up my box" is real — how much of this machine is in use — and
 * the answer only misleads when the pools are MERGED into one.
 *
 * So they are laid END TO END up the axis rather than poured into one: each pool owns a band whose height is
 * its own capacity, and fills that band from its own floor. The axis total is then a true total of capacity,
 * every fill is a real reading against a real ceiling (which card is full is what decides where the next load
 * lands), and the WALLS between the bands are drawn — so the boundaries a split has to pay to cross are
 * visible rather than something the reader has to know.
 *
 * It also makes the box's SHAPE visible, which the per-pool tracks cannot: those give every pool the same
 * height whatever its size, so a 12 GiB laptop card and a 96 GiB card look alike. Here a pool's height IS its
 * share of the machine.
 *
 * Hiding a pool removes its band and shrinks the axis, which is what makes "just my two cards" a view rather
 * than a calculation.
 */
export function boxAxis(pools: { id: string; ceiling: number }[]): { total: number; bands: { id: string; base: number; ceiling: number }[] } {
    let base = 0;
    const bands = pools.filter((p) => p.ceiling > 0).map((p) => {
        const at = base;
        base += p.ceiling;
        return { id: p.id, base: at, ceiling: p.ceiling };
    });
    return { total: base, bands };
}

/** Why these series cannot share a STACKED axis, or null when they can. Stacking asserts the parts sum to a
 *  meaningful whole: true within one device, false across two (a model uses one card's capacity, not their
 *  sum) and false across device+host on unified memory, where the two totals describe the SAME silicon.
 *  `overlay` has no such constraint — it makes no claim about a total — so this gates only stacking. */
/** Why these series cannot share ONE track in any mode, or null. Utilization is a share of TIME (how busy the
 *  card was) and memory a share of CAPACITY; drawn on one 0–100% axis they would line up as though comparable,
 *  and a card "90% busy" beside a card "90% full" says nothing about either. Separate tracks. */
export function kindRefusal(defs: SeriesDef[]): string | null {
    const util = defs.filter((d) => d.scope === "util").length;
    return util && util < defs.length
        ? "How busy a card is is a share of TIME; memory is a share of CAPACITY. One axis for both would line them up as though they were comparable. Put utilization in a track of its own."
        : null;
}

/** Why these series cannot be STACKED against one ceiling, or null. A stack sums its parts, so it needs an
 *  amount rather than a percentage and one pool rather than several; each refusal says which and what to do
 *  instead. `presetRefusal` and the saved-layout validator both defer to this. */
export function stackRefusal(defs: SeriesDef[], cap: Capacity | null): string | null {
    // A busy percentage is not an AMOUNT: there is nothing in it to add up, and a stack is a sum.
    if (defs.some((d) => d.scope === "util"))
        return "A card's utilization is a share of time, not an amount of memory — a stack adds its parts up, and there is nothing here to add. Overlay it.";
    const pools = new Set(defs.map((d) => d.pool));
    if (pools.size <= 1) return null;
    const scopes = new Set(defs.map((d) => d.scope));
    if (cap?.unified && scopes.size > 1)
        return "This device shares one pool of memory between the GPU and the system, so its VRAM and RAM figures describe the same silicon — stacking them would double-count. Overlay them instead.";
    if ([...pools].filter((p) => p.startsWith("device:")).length > 1)
        return "Each card has its own capacity, and a stack draws its parts against ONE ceiling — so several cards stacked would draw one card's models in memory another card does not have. (A model split across cards already shows on each card it uses.) Show a track per card, overlay them, or use Whole box, which lays each card's capacity end to end.";
    return "These series measure different pools, each against its own ceiling, so one stack has no single ceiling to draw them against. Overlay them, or use Whole box.";
}

/** One ready-made layout offered for this box: a named set of tracks the user can pick without composing one. */
export interface Preset { id: string; label: string; description: string; tracks: TrackDef[] }

/** Why this preset is invalid on this machine, or null. A preset proposes a LAYOUT and `stackRefusal` judges
 *  it, so the two must agree: a preset that offers a stack the rule then refuses would be an option the user
 *  can pick and immediately be told off for. Used by the drift guard, and by the layout validator when a saved
 *  layout is restored onto a different box. */
export function presetRefusal(p: Preset, sample: ResourceSample): string | null {
    const cat = seriesCatalog(sample);
    for (const t of p.tracks) {
        const defs = t.series.map((id) => cat.find((s) => s.id === id)).filter(Boolean) as SeriesDef[];
        if (defs.length !== t.series.length) return `references a series this machine doesn't have`;
        { const r = kindRefusal(defs); if (r) return r; }
        if (t.mode === "total" && defs.some((d) => d.scope === "util")) return "utilization has no capacity to lay end to end";
        if (t.mode === "stack") { const r = stackRefusal(defs, sample.capacity); if (r) return r; }
    }
    return null;
}

/** Starting layouts, generated from the box: a two-card server opens on placement (where did it land?), a
 *  single-device machine on the split that actually matters there (GPU vs CPU spill). */
export function presetsFor(sample: ResourceSample): Preset[] {
    const cap = sample.capacity;
    const devices = cap?.devices ?? [];
    // Build from the CATALOG, not from device ids: on unified memory the catalog collapses to a single `mem`
    // series (one pool, one ceiling), so naming `vram.0`/`ram` here would propose tracks for series that do
    // not exist on that machine. The two must be derived from one source or they drift apart.
    const have = new Set(seriesCatalog(sample).map((s) => s.id));
    const track = (id: string, series: string[], mode: TrackDef["mode"] = "stack"): TrackDef =>
        ({ id, series: series.filter((x) => have.has(x)), mode, heightPx: 96 });
    const nonEmpty = (t: TrackDef) => t.series.length > 0;

    if (cap?.unified) {
        // One physical pool: one track, and no per-card view of a machine with one device.
        return [{ id: "memory", label: "Memory", description: "The single pool this machine shares between GPU and system.",
                  tracks: [track("mem", ["mem"])].filter(nonEmpty) }];
    }
    const overview: Preset = {
        id: "overview", label: "Overview", description: "Every card in one track, overlaid — no false total.",
        // OVERLAY, not stack: each pool has its own ceiling and a stack draws against one, so stackRefusal
        // rightly refuses a stack across pools. A preset must never propose a layout the rule then rejects. Overlaying claims nothing about a total, so it is the honest way to compare them.
        // The HOST pool is included: a CPU-resident model holds no VRAM, so a cards-only overview would make
        // it vanish from the chart while it still sits in the legend below — the same flaw that took Placement
        // out of the default slot.
        // THE MODE IS DECIDED BY HOW MANY POOLS THE TRACK ENDED UP WITH, not by how many CARDS the box has.
        // Asking about cards got the one-card machine wrong — the commonest machine there is: one GPU plus
        // host RAM is still TWO pools, so the default preset proposed a stack of a card and the host, which
        // `stackRefusal` refuses ("their sum isn't a real quantity"). The panel's own default offered a
        // layout the panel then told you off for.
        //
        // It has to be read off the track AFTER `track()` has filtered the series to what this machine
        // actually has, or the count is of series we hoped for rather than series we got.
        tracks: ((): TrackDef[] => {
            const t = track("overview", [...devices.map((d) => `vram.${d.id}`), "ram"]);
            return [{ ...t, mode: (t.series.length > 1 ? "overlay" : "stack") as TrackDef["mode"] }].filter(nonEmpty);
        })(),
    };
    const withRam: Preset = {
        id: "memory", label: "GPU + RAM", description: "A track per pool, with the models stacked in each.",
        tracks: [...devices.map((d) => track(`dev-${d.id}`, [`vram.${d.id}`])), track("ram", ["ram"])].filter(nonEmpty),
    };
    // TWO views, and they differ in KIND rather than in scope: Overview is one compact track with every pool
    // overlaid (how full is each), GPU + RAM is a track per pool with per-model bands (what is in each). Both
    // include the host, because a CPU-resident model holds no VRAM and a view that omits the host pool makes
    // it vanish from the chart while it sits in the legend below.
    //
    // There was a third, "Placement" — GPU + RAM minus the host track. It was exactly that flaw as a named
    // option: strictly narrower, and what it narrowed AWAY was your CPU-resident models. Anyone who genuinely
    // wants cards-only can drop the RAM track in the editor, which is one click and says what it did.
    //
    // A THIRD KIND, though, not a narrowing: every pool END TO END on one axis. It is a different QUESTION
    // from the other two — not "how full is each" (Overview) or "what is in each" (GPU + RAM) but "what shape
    // is this box, and how much of it is spoken for" — and the per-pool tracks cannot answer it, because they
    // give every pool the same height whatever its capacity, so a 12 GiB card and a 96 GiB one look alike.
    //
    // It had no preset and could only be reached by editing tracks by hand, which made Custom carry a whole
    // view rather than what Custom should mean: a preset with something excluded or a mode changed. A mode
    // nobody can find is a mode nobody uses.
    //
    // Only where there is more than one pool. On a single-pool box the axis IS that pool's, so laying it
    // "end to end" is the same picture under a name that promises something else.
    const pools = [...devices.map((d) => `vram.${d.id}`), "ram"].filter((id) => have.has(id));
    const box: Preset = {
        id: "box", label: "Whole box", description: "Every pool end to end on one axis, with the walls drawn between them.",
        tracks: [{ ...track("box", pools, "total"), heightPx: 150 }].filter(nonEmpty),
    };
    // A FOURTH QUESTION, not a memory view: how BUSY is each card. Its own preset because it is its own unit — a
    // share of time — and offered only where some card reports a reading; a preset of lines that are never
    // drawn would read as an idle box. Unified memory returns earlier and has no per-card counter to show.
    const util = [...have].filter((id) => id.startsWith("util."));
    const activity: Preset = {
        id: "activity", label: "Activity",
        description: "How busy each card is — the GPU and its memory controller, as the driver averages them.",
        tracks: [track("activity", util, "overlay")].filter(nonEmpty),
    };
    return [overview, withRam, ...(pools.length > 1 ? [box] : []), ...(util.length ? [activity] : [])];
}

// resource-lane.ts — the event lane: which of a box's events are in view, and where each one is drawn.
//
// Two questions, in order. WHICH events (`filterEvents`, `sessionWindow`, `scopeAround`) narrows the stream to
// a session, a scope or a machine, because a lane showing everything shows nothing. WHERE each one goes
// (`laneRows`, `packOrder`, `packBand`, `placeEvents`) packs the survivors into rows without overlapping them.
//
// The facts that shape the packing, each learned from a lane that drew wrongly: a span runs BACKWARDS from its
// finish stamp, because that is the only timestamp the server reports; a tool step is ONE event carrying
// phases, not three events; and a model load is its own event rather than part of whatever waited for it.
// `sameMachineEvent`/`addMachineEvent` exist because the same event can arrive twice, from the replay buffer
// and from the live fan, in either order.

import { ResourceEvent, EventPlacement } from "./resource-model";
import { MIN_SCOPE_MS, Axis, axisFrac } from "./resource-axis";

/** What the lane draws. Everything is shown by default; this is how a busy session is narrowed.
 *
 *  Two independent axes, because they answer different questions. SCOPE answers "whose events" — a browsing
 *  session accumulates every run, and when you are reading one of them the others are noise. KINDS answers
 *  "which of them" — sub-calls are the numerous ones (a vision reader fires several per step) and loads and
 *  evictions are the rare, expensive ones you may want alone. */
export interface LaneFilter {
    /** The session being read, or null when none is (the overview list). */
    hash: string | null;
    /** Whether the lane shows only that session's events, or every session's. Scoping is the DEFAULT: the
     *  lane sits above a transcript, and events from runs you are not reading are noise against it. With
     *  scoping on and no session open there is nothing to scope to, so a run's events are shown NOWHERE —
     *  which is the intended overview, not an empty-looking bug. */
    scope: "session" | "all";
    /** Kinds to HIDE. An exclusion list, so a kind added later is visible by default rather than silently
     *  filtered out by a stored preference that predates it. */
    hidden: readonly ResourceEvent["kind"][];
    /** The models the scoped session actually ran, delegated readers included. A MACHINE event carries no
     *  session, so scoping cannot ask who owns it — but it can ask whether the model is one this session was
     *  using, which is the question a reader is really asking. Undefined means "not known", and everything
     *  machine-side is kept, since inventing an empty set would silently hide the lot. */
    models?: readonly string[];
}

/** The filter that hides nothing — the lane's default, and what a caller resets to. Named rather than written
 *  inline so "no filter" is one object every surface shares instead of three literals that can drift. */
export const EMPTY_LANE_FILTER: LaneFilter = { hash: null, scope: "all", hidden: [] };

/** Apply a filter. An event with no `ref` belongs to the MACHINE rather than to a run — a load, an eviction,
 *  the box serving someone else — so a session scope cannot ask who owns it. It asks the useful question
 *  instead: is this a model the session was using? A qwen session was drawing gemma's loads and evictions
 *  because "no ref" was read as "always relevant", and on a shared box that is most of the lane. Kept when
 *  the models are unknown, since an empty set would hide everything the chart exists to show. */
export function filterEvents(events: readonly ResourceEvent[], filter: LaneFilter): ResourceEvent[] {
    const hidden = new Set(filter.hidden);
    const mine = filter.models ? new Set(filter.models) : null;
    return events.filter((e) => {
        if (hidden.has(e.kind)) return false;
        if (filter.scope !== "session") return true;
        if (e.ref) return e.ref.hash === filter.hash;
        // A machine event about a model this session ran EXPLAINS the session — an eviction mid-run is why
        // the next turn paid a load. One about a model it never touched is another tenant's traffic.
        if (!mine) return true;
        // An event with no model at all cannot be attributed either way (the server emits a bare `unload`).
        // Dropped while scoped and kept in full: unattributable is not the same as unrelated, but a lane
        // asked for one session should not answer with something it cannot place.
        return e.model ? mine.has(e.model) : false;
    });
}

/** The stretch of time a SESSION occupies, for a panel scoped to it. Scoping the lane and the model list but
 *  not the axis left the two disagreeing about what "this session" means: the list said one model, the chart
 *  still drew ten minutes of a shared box either side of it.
 *
 *  Derived from the session's own events rather than from its turns, so it covers whatever the lane draws —
 *  including a tool that was still running when the snapshot was taken. `now` extends a LIVE session to the
 *  present instead of stopping at its last finished event, which would otherwise pin the window behind the
 *  memory trace it is meant to sit under.
 *
 *  `minMs` is a floor, because a three-second session is a slit: a window narrower than a couple of samples
 *  contains no measurements and draws as an empty plot, which reads as the panel breaking rather than as a
 *  short run. Returns null when the session has no events at all — there is nothing to frame, and inventing
 *  a window would be a claim about when it happened. */
export function sessionWindow(
    events: readonly ResourceEvent[], hash: string | null, now: number,
    { minMs = 30_000, padFrac = 0.04, followMs = 0 }: { minMs?: number; padFrac?: number; followMs?: number } = {},
): { from: number; to: number; live?: true } | null {
    if (!hash) return null;
    let from = Infinity, to = -Infinity;
    for (const e of events) {
        if (e.ref?.hash !== hash) continue;
        from = Math.min(from, e.t);
        // An OPEN span has no end; `until` is where it had reached, which is the right right-edge for it.
        to = Math.max(to, e.until ?? e.t);
    }
    if (!Number.isFinite(from)) return null;
    // A LIVE session with a width to follow at FILLS, then SCROLLS, and never rescales. The window is `followMs` wide
    // from the start, anchored at the session's beginning, so the run fills it from the left; once the session is
    // longer than that, it follows the clock at the same width. Growing the window to fit instead — pinning the left
    // edge and stretching the right — is a continuous zoom: every bar moves and narrows on every sample, and the
    // moment the run ended the window jumped to a different one. A FINISHED session still fits itself, below.
    if (followMs > 0 && now - to < minMs) {
        const start = from - Math.max(1000, followMs * padFrac);
        // `live` either way: the fill has a fixed right edge until the clock reaches it, and then it scrolls.
        return now - start <= followMs ? { from: start, to: start + followMs, live: true } : { from: now - followMs, to: now, live: true };
    }
    // Still going, or only just finished: follow the clock rather than stopping short of it.
    if (now - to < minMs) to = now;
    const pad = Math.max((to - from) * padFrac, 1000);
    from -= pad; to += pad;
    // Widen around the CENTRE, so a short session sits in the middle of its window instead of against an edge.
    const grow = minMs - (to - from);
    if (grow > 0) { from -= grow / 2; to += grow / 2; }
    return { from, to };
}

/** Is this the SAME machine edge we already hold? A subscriber that reconnects is backfilled with the ring
 *  again — the whole ten minutes when the worker is fresh, which an MV3 respawn guarantees — so every span
 *  in that window arrives a second time and the lane doubles. Measured on a real box: four serving periods
 *  drawn as "serving 8", two loads as three (one load's opening edge fell outside the replayed window, so
 *  only its duplicate closed).
 *
 *  Identity is kind + model + when, with a TOLERANCE. The instant is derived as `helloAt + frame.t`, and
 *  since each connection anchors on its own hello the same edge lands within the jitter between two hellos
 *  rather than on the exact same millisecond. A second is far tighter than the spacing of anything the
 *  server actually emits, and collapsing two genuinely distinct edges that close together is a far smaller
 *  error than drawing everything twice. */
export function sameMachineEvent(a: ResourceEvent, b: ResourceEvent, tolMs = 1500): boolean {
    if (a.kind !== b.kind || a.model !== b.model) return false;
    // A GENERATION is identified by its END and the engine's own figures, never its start: a replay that
    // lost its `gen.start` (it fell outside the requested window) starts the same span somewhere else, while
    // two short generations of one model can end milliseconds apart (3-token calls at 35 ms in a real capture)
    // and must stay two. The figures are the identity — a replay carries them verbatim since the backfill fix.
    if (a.kind === "gen" && a.gen && b.gen) {
        return a.until != null && b.until != null && Math.abs(a.until - b.until) <= tolMs
            && a.gen.promptMs === b.gen.promptMs && a.gen.evalMs === b.gen.evalMs && a.gen.decoded === b.gen.decoded;
    }
    if (Math.abs(a.t - b.t) > tolMs) return false;
    // A span and an instant of the same kind at the same moment are not the same thing, and two spans that
    // start together but end apart are two different periods of work.
    if ((a.until == null) !== (b.until == null)) return false;
    return a.until == null || Math.abs((a.until as number) - (b.until as number)) <= tolMs;
}

/** Append unless we already hold it. Bounded by `cap`, dropping oldest. */
export function addMachineEvent(list: readonly ResourceEvent[], e: ResourceEvent, cap: number, tolMs = 1500): ResourceEvent[] {
    // Backwards: a duplicate arrives in a REPLAY of recent history, so the match is near the end.
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].t < e.t - tolMs - 1) break;          // the list is time-ordered; nothing older can match
        if (sameMachineEvent(list[i], e, tolMs)) return list as ResourceEvent[];
    }
    const next = [...list, e];
    return next.length > cap ? next.slice(next.length - cap) : next;
}

/** How many of each kind are in a set — for a filter control that says what it is hiding rather than making
 *  you toggle blindly. */
export function countByKind(events: readonly ResourceEvent[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of events) out[e.kind] = (out[e.kind] || 0) + 1;
    return out;
}

/** An event's whole lineage: itself, everything it descends from, and everything descended from it. Hovering
 *  a sub-call should leave the step that spawned it and the run that contains it lit — the relationship is
 *  what makes the bar mean anything — and hovering the step should keep what it spawned, which is the same
 *  relationship read the other way. */
export function lineageOf(events: readonly ResourceEvent[], id: string | undefined): Set<string> {
    const out = new Set<string>();
    if (!id) return out;
    const byId = new Map(events.filter((e) => e.id).map((e) => [e.id!, e]));
    // A focus on an event that is NOT DRAWN is not a focus. The hover is held in a signal, so it outlives the
    // thing it pointed at — a click that navigates, a filter chip, the window moving — and an id that matches
    // nothing produced a lineage of exactly one unmatchable member, which dimmed every bar and every step at
    // once. That reads as the whole lane disappearing rather than as a stale highlight.
    if (!byId.has(id)) return out;
    out.add(id);
    // ANCESTORS: straight up the chain.
    for (let cur = byId.get(id)?.parent; cur && !out.has(cur); cur = byId.get(cur)?.parent) out.add(cur);
    // DESCENDANTS: only of the hovered event itself, never of its ancestors — a sibling step is not part of
    // this lineage, and pulling one in would light half the run for hovering one sub-call.
    const below = new Set<string>([id]);
    for (let grew = true; grew; ) {
        grew = false;
        for (const e of events) if (e.id && e.parent && below.has(e.parent) && !below.has(e.id)) { below.add(e.id); grew = true; }
    }
    for (const d of below) out.add(d);
    return out;
}

/** Pack placed events into non-overlapping ROWS, greedily and in time order: an event goes in the first row
 *  whose last event ends before it starts. Spans that overlap in TIME must not overlap on screen — two bars on
 *  one line read as a single longer one, which is a false statement about what happened.
 *
 *  Concurrency is the normal case here, not an edge: a run contains its generations, a generation may have a
 *  background embedding call beside it, and each nests under the one that contains it —
 *
 *      [                    run                      ]
 *           [ generation ]            [ tool ]
 *                [ embed ]
 *
 *  which falls out of "first free row, earliest start first" without special-casing nesting: the longest span
 *  starts first, so it takes the top row and everything inside it goes below. */
/** The smallest fraction of the plot a bar is DRAWN at. A shorter event is widened to this so it stays
 *  visible — which means packing has to reserve the same width, or two events that do not overlap in time
 *  are drawn overlapping and read as one longer bar. */
export const MIN_EV_SPAN = 0.006;

/**
 * The time window to scope the panel to when a lane block is double-clicked: the block's own extent,
 * widened symmetrically if it is shorter than {@link MIN_SCOPE_MS}.
 *
 * An OPEN event (work still in flight) has no end, so `now` stands in for one — scoping to it while it
 * runs is the case where this is most useful and least able to know where it stops.
 */
export function scopeToSpan(from: number, until: number | null | undefined, now: number, minMs = MIN_SCOPE_MS): { from: number; to: number } {
    const to = until ?? now;
    const pad = Math.max(0, (minMs - (to - from)) / 2);
    return { from: from - pad, to: to + pad };
}

/**
 * The same thing, but guaranteed to contain enough SAMPLES to draw.
 *
 * A window is only as useful as the trace inside it, and everything here needs a segment of at least two
 * samples: `segments()` drops shorter ones, so the tracks, the lane and the strip all render nothing and the
 * panel appears to vanish. A time floor cannot promise that — scoping to a 400ms tool call on a box polled
 * every two seconds is a window with one sample in it, or none — so this widens symmetrically until the
 * window actually covers `minSamples`, and gives up only when the session does not have that many.
 */
export function scopeAround(
    samples: readonly { t: number }[],
    from: number,
    until: number | null | undefined,
    now: number,
    minSamples = 3,
): { from: number; to: number } {
    let w = scopeToSpan(from, until, now);
    if (samples.length <= minSamples) return { from: samples[0]?.t ?? w.from, to: samples[samples.length - 1]?.t ?? w.to };
    const covered = (r: { from: number; to: number }) => samples.reduce((n, s) => n + (s.t >= r.from && s.t <= r.to ? 1 : 0), 0);
    // Grow by the window's own width each round, so a very short scope reaches a useful size in a few steps
    // rather than crawling, and a long one is left alone.
    for (let i = 0; i < 40 && covered(w) < minSamples; i++) {
        const grow = Math.max(1000, (w.to - w.from) / 2);
        w = { from: w.from - grow, to: w.to + grow };
    }
    return w;
}

/** A hair of separation reserved BETWEEN bars in a row. Two bars that merely touch read as one bar with a
 *  seam — which is the same misreading as an overlap, arrived at differently. */
export const EV_ROW_GAP = 0.004;

/**
 * Pack placed events into rows, ONE RUN AT A TIME.
 *
 * A run and everything under it — its steps, their sub-calls — is a tree, and the tree is what a reader is
 * following. Packing every event together by start time interleaves two concurrent runs into the same rows,
 * so a step of one sits between two steps of the other and the shape of neither survives. Each run instead
 * gets a contiguous BAND: its own container bar, its steps beneath, its sub-calls beneath those. A second
 * run overlapping in time starts a new band below rather than filling gaps in the first.
 *
 * This is not only a multi-model case: a server or cloud backend runs the SAME model several times at once,
 * so the grouping is by RUN, never by model.
 *
 * Events belonging to no run (an eviction — a fact about the machine) are packed last, in a band of their
 * own, so they cannot push a run's rows apart.
 */
/** The most rows the lane will ever draw, across every band. Each row is a few pixels, so without a TOTAL
 *  cap a box running ten agents at once would push the transcript off the screen — banding made the per-run
 *  cap insufficient, because the number of bands is the number of concurrent runs. */
export const MAX_LANE_ROWS = 10;

/** Pack placed events into non-overlapping ROWS, grouped by the run they belong to. Runs are laid out in the
 *  order they started and the machine's own events go last, so a band's vertical position says when its run
 *  began and an eviction, which belongs to no run, does not push one down. Capped by `maxRows` per run and
 *  `maxTotal` overall: a lane taller than the panel is unreadable, so events past the cap are dropped rather
 *  than drawn off-screen. */
export function laneRows(placed: EventPlacement[], maxRows = 4, minSpan = MIN_EV_SPAN, maxTotal = MAX_LANE_ROWS): EventPlacement[][] {
    const groups = new Map<string, EventPlacement[]>();
    for (const p of placed) {
        const key = p.event.ref?.hash ?? "";
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(p);
    }
    // Runs in the order they STARTED, and the machine's own events last: a band's position should say when
    // its run began, and an eviction belongs to no run at all.
    const order = [...groups.entries()].sort((a, b) => {
        if (!a[0] !== !b[0]) return a[0] ? -1 : 1;
        return Math.min(...a[1].map((p) => p.run + p.from)) - Math.min(...b[1].map((p) => p.run + p.from));
    });
    const out: EventPlacement[][] = [];
    // The drawn end of each existing row, so a later band can be told whether it would collide.
    const ends: number[] = [];
    const endOf = (p: EventPlacement) => p.run + Math.max(p.to, p.from + minSpan) + EV_ROW_GAP;
    const startOf = (p: EventPlacement) => p.run + p.from;

    for (const [, band] of order) {
        const rows = packBand(band, maxRows, minSpan);
        // REUSE rows where the band cannot collide. Banding exists so a tree is never interleaved with
        // another — but two runs that never overlap in TIME cannot interleave, so stacking them costs rows
        // for nothing, and most runs are sequential rather than concurrent. The band is placed as a WHOLE at
        // the first depth where every one of its rows clears what is already there: moving rows independently
        // would let one run's steps slide under another's container, which is the interleaving this prevents.
        // Placed at the TOP only when everything already drawn has finished before this band begins — which
        // is exactly the sequential case. Anything else appends. Allowing a band to start partway down would
        // let it share a row with another run's sub-calls while overlapping that run's container, so the two
        // trees would interleave by depth: the thing banding exists to prevent, arrived at sideways.
        const bandStart = Math.min(...band.map(startOf));
        const clearsEverything = ends.length > 0 && ends.every((e) => bandStart >= e);
        let at = clearsEverything ? 0 : out.length;
        // Out of room even appending: everything left CROWDS into the last row rather than being dropped. A
        // bar drawn overlapping is a legibility problem; a run not drawn at all is a lie about what ran.
        if (at >= out.length && out.length + rows.length > maxTotal) {
            const last = out[out.length - 1] ?? (out.push([]), ends.push(0), out[0]);
            for (const r of rows) last.push(...r);
            continue;
        }
        rows.forEach((row, i) => {
            const k = at + i;
            if (!out[k]) { out[k] = []; ends[k] = 0; }
            out[k].push(...row);
            ends[k] = Math.max(ends[k], ...row.map(endOf));
        });
    }
    return out;
}

/** One run's own rows — the greedy first-fit the whole lane used to get, applied within a band. */
/** Which row-tier an event belongs to. The lane is a CONTAINMENT picture, so depth has to mean something:
 *  a run CONTAINS its steps, so it goes above them; the machine's own spans are the ground the run happened
 *  on, so they go below. Packing by start time alone made the order incidental — a container whose first
 *  step began at the same instant landed UNDER its own children, and a model load could take the top row
 *  from the run it was loading for.
 *
 *  A tier is only a preference between things drawn at the same time: within one tier, packing is unchanged
 *  and two bars still share a row whenever they cannot overlap. */
export function laneTier(kind: string): number {
    if (kind === "run" || kind === "session") return 0;      // the container
    if (kind === "gen" || kind === "tool" || kind === "embed") return 1;   // its own work
    return 2;                                               // the machine: loads, serving, evictions
}

/** The order a band's events are packed in: TIER, then — within the machine tier — what belongs to one of the run's
 *  own steps before anything else, then time; and never a child before its parent. A load a step waited for used to be
 *  packed after an aside that merely started earlier (same tier), so the aside took the row under the step and the load
 *  landed two rows down, detached from the wait it explains. The parent rule is what the row floor needs: a child packed
 *  before its parent has no floor to respect. */
function packOrder(placed: EventPlacement[], start: (p: EventPlacement) => number): EventPlacement[] {
    const idOf = (p: EventPlacement) => (p.event as { id?: string }).id;
    const parentOf = (p: EventPlacement) => (p.event as { parent?: string }).parent;
    const byId = new Map<string, EventPlacement>();
    for (const p of placed) { const id = idOf(p); if (id != null) byId.set(id, p); }
    // 0: owned by a run's own work (a step, a gen); 1: anything else in the tier (an aside, and what hangs off one).
    const ownerRank = (p: EventPlacement) => {
        const parent = parentOf(p) != null ? byId.get(parentOf(p)!) : undefined;
        return parent && laneTier(parent.event.kind) < laneTier(p.event.kind) ? 0 : 1;
    };
    const sorted = [...placed].sort((a, b) =>
        laneTier(a.event.kind) - laneTier(b.event.kind) || ownerRank(a) - ownerRank(b) || start(a) - start(b));
    // Children held back until their parent is emitted, then emitted right after it.
    const out: EventPlacement[] = [], emitted = new Set<EventPlacement>(), waiting = new Map<EventPlacement, EventPlacement[]>();
    const emit = (p: EventPlacement): void => {
        out.push(p); emitted.add(p);
        for (const c of waiting.get(p) ?? []) emit(c);
        waiting.delete(p);
    };
    for (const p of sorted) {
        const parent = parentOf(p) != null ? byId.get(parentOf(p)!) : undefined;
        if (parent && parent !== p && !emitted.has(parent)) (waiting.get(parent) ?? waiting.set(parent, []).get(parent)!).push(p);
        else emit(p);
    }
    // A cycle, or a parent that never came: emit what is left rather than drop it.
    for (const kids of waiting.values()) for (const c of kids) if (!emitted.has(c)) emit(c);
    return out;
}

function packBand(placed: EventPlacement[], maxRows: number, minSpan: number): EventPlacement[][] {
    const rows: EventPlacement[][] = [];
    // The END is the DRAWN end, not the true one: see MIN_EV_SPAN. The fallback pass lets a bar start exactly where
    // the previous one is drawn to end. It used to keep a pixel between them, and a run's steps follow each other
    // within a few MILLISECONDS (a gen hands straight to its tool), far less than a pixel on any lane, so every
    // other step was refused the row and the run's steps alternated between two rows as if they overlapped. Two
    // flush bars still read as two: `.rc-ev` draws a hairline in the panel's colour around every bar.
    const start = (p: EventPlacement) => p.run + p.from;
    const end = (p: EventPlacement, pad: boolean) =>
        p.run + Math.max(p.to, p.from + minSpan) + (pad ? EV_ROW_GAP : 0);
    // A true INTERVAL test against the row's members, not a running end. The running end assumed events
    // arrived in increasing start order, which stopped being true the moment they were sorted by tier — a
    // load that abuts a step it precedes was then refused the row it belongs on, because a later-starting
    // member had already pushed the end past it.
    const fits = (row: EventPlacement[], p: EventPlacement, pad: boolean) =>
        row.every((q) => end(q, pad) <= start(p) || end(p, pad) <= start(q));
    // TIER first, then time. Sorting by time alone let whatever happened to begin earliest take the top row,
    // which on a lane whose depth means containment is a wrong picture rather than an untidy one.
    // A CHILD NEVER SITS ABOVE ITS CONTAINER. Tiers alone did not guarantee it: two runs of one session that ABUT
    // cannot share a row (the pixel between bars), so the second run opened row 1 — and its steps, packed next,
    // took the first row with room, row 0, above their own container. So an event whose parent is already placed
    // may only use rows below that parent's.
    const rowOf = new Map<string, number>();
    const below = (p: EventPlacement): number => {
        const parent = (p.event as { parent?: string }).parent;
        const at = parent != null ? rowOf.get(parent) : undefined;
        return at == null ? 0 : at + 1;
    };
    for (const p of packOrder(placed, start)) {
        const floor = below(p);
        const firstFit = (pad: boolean) => rows.findIndex((row, i) => i >= floor && fits(row, p, pad));
        let r = firstFit(true);
        // Nothing fits WITH the separation reserved. Before opening a row, try again without it. Rows are the
        // lane's scarcest resource and its only claim about time: two bars on separate rows say they OVERLAP.
        // Spending a row to buy a bar 0.4% of clearance therefore asserts an overlap that isn't there, which
        // is the same misreading the separation exists to prevent, arrived at from the other side. This is the
        // ordinary case rather than an edge one — a model LOAD ends exactly where the block it precedes
        // begins, so every load abutted its own step and was pushed below it.
        if (r < 0) r = firstFit(false);
        if (r < 0) {
            // A new row, opening empty rows down to the floor if the container sits on the last one.
            while (rows.length < floor && rows.length < maxRows) rows.push([]);
            if (rows.length >= maxRows) r = rows.length - 1;   // out of rows: crowd the last one rather than drop the event
            else { rows.push([]); r = rows.length - 1; }
        }
        rows[r].push(p);
        const id = (p.event as { id?: string }).id;
        if (id != null) rowOf.set(id, r);
    }
    // Each row back in time order: it is packed by tier, and a row read left to right should be in the order
    // the things on it happened.
    for (const row of rows) row.sort((a, b) => start(a) - start(b));
    return rows;
}

/**
 * Place events on the axis. NOTHING IS DROPPED for falling between samples: an event is a fact about when something
 * happened, and a gap in the MEASUREMENTS says nothing about whether it did. (Dropping them is how a whole load
 * vanished from the lane when it happened while the panel was closed.)
 *
 * `from`/`to` are UNCLAMPED fractions, so an event off either edge has one below 0 or above 1. That is deliberate:
 * the lane packs rows over events the window does not show yet, so a bar keeps its row as it scrolls into view,
 * and the renderer clips to the plot. `clipped` says a span runs past `measuredTo`, the last measurement.
 */
export function placeEvents(axis: Axis, events: ResourceEvent[], measuredTo?: number): EventPlacement[] {
    return events.map((e) => {
        const end = e.until ?? e.t;
        return { event: e, run: 0, from: axisFrac(axis, e.t), to: axisFrac(axis, end), clipped: measuredTo != null && e.until != null && end > measuredTo };
    });
}

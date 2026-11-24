// energy-stretch.ts — one stretch of a local runtime's generations as the worker watches it live: frames in (power
// readings, every client's gen.end), and out, at each of our generations' ends, each of our sessions' share so far as
// the record the page reads. The attribution is energy.ts's; this decides what it is run over and when a stretch ends.
//
// A stretch opens when one of our sessions sends a request and closes TAIL_MS + REST_MS after its last generation
// with no request of ours still out. A worker that dies inside it leaves the last record written `open`, which the next
// worker marks `cut` (docs/spec/SESSION_SUMMARY.md, "Energy and its cost").

import type { ElectricityPrice } from "../contract/contract-chat";
import type { WireFrame } from "../resource/events-wire";
import { attribute, genSpan, intervals, priceShare, reading, REST_MS, TAIL_MS, type Reading, type Span } from "./energy";

/** What one session drew over one stretch, as stored: energy in J (`aboveJ` null when the rest was not found), the
 *  basis words' key (`BASIS_WORDS`), generation time, cost at the call's electricity price (null without one), and
 *  whether the stretch is still being watched (`open`) or was stopped inside (`cut`). */
export interface StretchRecord { J: number; aboveJ: number | null; basis: string; ms: number; cost: number | null; currency: string | null; open: boolean; cut: boolean }

/** Readings older than this before the stretch's first request are dropped: the server's ring, the most a fresh
 *  connection backfills, and so the most a rest baseline can be found in. */
const BEFORE_MS = 600_000;

/** True when a sample frame's compute carries a power reading: a GPU's board power or any power source. */
export function hasPower(frame: WireFrame): boolean {
    const c = frame.info?.compute;
    return !!c && ((c.supported_gpus ?? []).some((g) => Number.isFinite(g?.power?.draw_mw)) || (c.power_sources ?? []).length > 0);
}

/** One stretch. `write` stores a session's record; `now` is the wall clock (ms). */
export class EnergyStretch {
    /** The stretch's key in each session's records: the moment its first request was sent. */
    readonly id: string;
    readonly openedAt: number;
    /** Null until the first sample frame says whether this runtime reports power; false ends the stretch unwatched. */
    powered: boolean | null = null;
    private readings: Reading[] = [];
    private spans: Span[] = [];
    private prices = new Map<string, ElectricityPrice | null>();
    private pending = new Map<string, number>();
    private lastEnd = 0;

    constructor(openedAt: number, private write: (session: string, id: string, rec: StretchRecord) => void) {
        this.openedAt = openedAt;
        this.id = String(openedAt);
    }

    /** One of our sessions sent a request. */
    requestStarted(session: string): void {
        if (!this.prices.has(session)) this.prices.set(session, null);
        this.pending.set(session, (this.pending.get(session) ?? 0) + 1);
    }

    /** The electricity price a session's calls run under (the latest call's), for its cost. */
    setPrice(session: string, price: ElectricityPrice | null): void {
        this.prices.set(session, price);
    }

    /** That request finished, answered or failed, at `t`. */
    requestEnded(session: string, t: number): void {
        const n = (this.pending.get(session) ?? 0) - 1;
        if (n > 0) this.pending.set(session, n); else this.pending.delete(session);
        this.lastEnd = Math.max(this.lastEnd, t);
    }

    /** When the stretch may close: TAIL_MS + REST_MS after its last generation or request of ours, or null while a
     *  request is still out. */
    closesAt(): number | null {
        return this.pending.size ? null : this.lastEnd + TAIL_MS + REST_MS;
    }

    /** Feed one frame, at its resolved wall clock. Returns true when it was one of our generations, after which the
     *  records have been written. */
    frame(frame: WireFrame, at: number): boolean {
        if (frame.kind === "sample") {
            if (this.powered == null) this.powered = hasPower(frame);
            if (this.powered && frame.info?.compute) {
                this.readings.push(reading(at, frame.info.compute, frame.ps?.models ?? null));
                const from = this.openedAt - BEFORE_MS;
                while (this.readings.length && this.readings[0].t < from) this.readings.shift();
            }
            return false;
        }
        if (frame.kind !== "gen.end") return false;
        const session = frame.hint?.session || null;
        // A generation of ours that ended before this stretch opened is an earlier stretch's, already counted: here it
        // only takes its share of the box, as a stranger's would.
        const ours = !!session && this.prices.has(session) && at >= this.openedAt;
        const span = genSpan({ at, session: ours ? session : null, model: frame.model || null, promptMs: frame.timings?.prompt_ms, evalMs: frame.timings?.eval_ms });
        if (!span) return false;
        this.spans.push(span);
        if (!ours) return false;
        this.lastEnd = Math.max(this.lastEnd, at);
        if (this.powered) this.record(true);
        return true;
    }

    /** Write every session's share so far: `open` until the close writes it complete. */
    record(open: boolean): void {
        const { sessions } = attribute(intervals(this.readings), this.spans);
        for (const [session, share] of sessions) {
            if (!this.prices.has(session)) continue;
            const { cost, currency } = priceShare(share, this.prices.get(session) ?? null);
            this.write(session, this.id, { J: share.J, aboveJ: share.aboveJ, basis: [...share.bases].sort().join(" / "), ms: Math.round(share.ms), cost, currency, open, cut: false });
        }
    }
}

/** A session's records after a worker start: every one still `open` was stopped inside, so it is marked `cut` (and is
 *  no longer open). Returns null when nothing changed. */
export function cutOpen(records: Record<string, StretchRecord>): Record<string, StretchRecord> | null {
    let changed = false;
    const out = Object.fromEntries(Object.entries(records).map(([id, r]) => {
        if (!r?.open) return [id, r];
        changed = true;
        return [id, { ...r, open: false, cut: true }];
    }));
    return changed ? out : null;
}

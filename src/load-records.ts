// load-records.ts — one RECORD per model load, for whoever is tuning the server's VRAM predictor.
//
// The panel shows a load's prediction against its outcome (behind the "load predictions" toggle); this is the
// same comparison as DATA, collected in the service worker from the event stream and kept in storage.local so it
// survives the worker being evicted. `ml.__loads()` returns it. Raw server fields are kept verbatim — whoever
// fits the predictor wants what the server said, not our reading of it — beside the measured trace, which only
// the client can build (the server reports the load's end state, not the curve that got there).
import type { ResourceFrame } from "./resource-events";
import { parseInfo, loadTrace, normModel, type LoadTrace, type ResourceSample } from "./resource-model";

/** storage.local: show the predictor's figures on loads, and collect these records. Off by default. */
export const PREDICT_KEY = "ml_res_predict";
/** storage.local: the collected records, oldest first, capped at `RECORDS_CAP`. */
export const LOAD_RECORDS_KEY = "ml_load_records";
export const RECORDS_CAP = 300;

export interface LoadRecord {
    model: string;
    /** Wall clock, ms: `load.start` and `load.complete`. */
    start: number;
    end: number;
    /** The last `estimate` frame's `estimate` before the load completed, verbatim — null when none arrived. */
    estimate: unknown;
    /** `load.complete`'s own fields, verbatim. */
    complete: { size_vram?: number; size_total?: number; memory?: unknown; weights_on_disk?: number; weights_ms?: number; context_ms?: number; duration_ms?: number; placement?: unknown };
    /** Attempts that failed and were retried before this one succeeded (`load.failed … ; retrying`). */
    failedAttempts: number;
    /** What the load took over time (see `loadTrace`), with point times RELATIVE to `start`. Null when no
     *  sample preceded the load, since growth needs a starting level. */
    trace: (Omit<LoadTrace, "points" | "peak" | "final"> & { points: [number, number][]; peak: { t: number; bytes: number } | null; final: { t: number; bytes: number } | null }) | null;
}

/** Enough history to trace a long load at the stream's 250 ms load cadence (a 142 GB model took 64 s). */
const SAMPLE_RING = 4000;

/**
 * Feeds on frames in arrival order and hands back each load's record once the sample that shows where it
 * SETTLED has arrived — the `load.complete` edge comes before that reading, so emitting on the edge would
 * record every load without its end state.
 */
export class LoadRecorder {
    private samples: ResourceSample[] = [];
    private open = new Map<string, { start: number; estimate: unknown; failed: number }>();
    private estimates = new Map<string, unknown>();
    private settling: { rec: Omit<LoadRecord, "trace">; }[] = [];

    push(frame: ResourceFrame & Record<string, unknown>, at: number): LoadRecord[] {
        const model = typeof frame.model === "string" ? normModel(frame.model) : undefined;
        switch (frame.kind) {
            case "sample": {
                const capacity = frame.info ? parseInfo(frame.info) : null;
                if (capacity) {
                    this.samples.push({ t: at, models: [], capacity });
                    if (this.samples.length > SAMPLE_RING) this.samples.splice(0, this.samples.length - SAMPLE_RING);
                }
                return this.settle(at);
            }
            case "estimate":
                if (model) this.estimates.set(model, frame.estimate ?? null);
                return [];
            case "load.start":
                if (model) this.open.set(model, { start: at, estimate: this.estimates.get(model) ?? null, failed: this.open.get(model)?.failed ?? 0 });
                return [];
            case "load.failed": {
                const o = model ? this.open.get(model) : undefined;
                if (o) o.failed++;
                return [];
            }
            case "load.complete": {
                const o = model ? this.open.get(model) : undefined;
                if (!model || !o) return [];
                this.open.delete(model);
                const pick = (k: string) => (frame[k] !== undefined ? { [k]: frame[k] } : {});
                this.settling.push({ rec: {
                    model, start: o.start, end: at, failedAttempts: o.failed,
                    // The LATEST estimate: a retried attempt sends a new one, and it is the one that was placed.
                    estimate: this.estimates.get(model) ?? o.estimate,
                    complete: { ...pick("size_vram"), ...pick("size_total"), ...pick("memory"), ...pick("weights_on_disk"),
                                ...pick("weights_ms"), ...pick("context_ms"), ...pick("duration_ms"), ...pick("placement") },
                } });
                this.estimates.delete(model);
                return [];
            }
        }
        return [];
    }

    /** Records whose settling sample has now arrived. */
    private settle(at: number): LoadRecord[] {
        const ready = this.settling.filter((s) => at >= s.rec.end);
        this.settling = this.settling.filter((s) => at < s.rec.end);
        return ready.map(({ rec }) => {
            const tr = loadTrace(this.samples, { t: rec.start, until: rec.end, model: rec.model });
            const rel = (p: { t: number; bytes: number } | null) => (p ? { t: p.t - rec.start, bytes: p.bytes } : null);
            return { ...rec, trace: tr ? { basis: tr.basis, baseline: tr.baseline, cards: tr.cards,
                points: tr.points.map((p) => [p.t - rec.start, p.bytes] as [number, number]), peak: rel(tr.peak), final: rel(tr.final) } : null };
        });
    }
}

/** Add records to a stored list: a reconnect REPLAYS the server's ring, so a load already recorded arrives again
 *  and is recognised by model and end (within the jitter between two connections' anchors). Oldest dropped past
 *  the cap. */
export function addRecords(stored: LoadRecord[], fresh: LoadRecord[], cap = RECORDS_CAP): LoadRecord[] {
    const out = [...stored];
    for (const r of fresh) if (!out.some((o) => o.model === r.model && Math.abs(o.end - r.end) < 2000)) out.push(r);
    return out.slice(-cap);
}

// resource-gens.ts — ONE GENERATION, as the event lane draws it. The engine reports prefill and decode
// durations per request, so the boundary between them is MEASURED rather than sampled, which is the one thing
// polling could never give us. Every span here is anchored at a finish stamp and built BACKWARDS from it, and
// `joinGens` matches the server's record of a generation to the call we made by our own request id rather
// than by model and end time. Pure.

import type { Wire, DecodePrediction, GenerationTimings, RequestHint } from "./events-wire";
import { GenTimings, PhaseKind, ResourceEvent, ResourceSample, normModel } from "./resource-model";

/**
 * WHAT THE SERVER PREDICTED THIS GENERATION WOULD DECODE AT, made before it ran (`gen.end.predicted_decode`). Made
 * from the same state the server stores beside the measurement, so it is never partly fitted to the generation it
 * predicts — which a `/api/ps` row read at or after `gen.end` would be, since that generation has already taught the
 * correction. Compare `msPerToken` with `evalMs / decoded`. Absent in the same cases as `expected_decode.unavailable`.
 */
export interface PredictedDecode {
    /** Predicted milliseconds per decoded token, at `occupancyTokens` of context. */
    msPerToken: number;
    /** `prompt_tokens + decoded / 2`: the mean context over the decode. */
    occupancyTokens?: number;
    basis: string;
    /** Only when corrected: the profile's figure, the factor, and how many EARLIER generations it rests on (at most
     *  the last 20 clean ones, on any card of the same kind). */
    profileMsPerToken?: number; correctionFactor?: number; correctionSamples?: number;
    /** A sliding-window model: reading the KV cache is not in the prediction, so it is a lower bound on the TIME. */
    excludesCacheRead?: boolean;
}

/** Parse `gen.end.predicted_decode`. Null when absent or unshaped. */
export function predictedDecodeFrom(raw: unknown): PredictedDecode | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Wire<DecodePrediction>;
    const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const ms = pos(o.ms_per_token);
    if (!ms) return null;
    return { msPerToken: ms, basis: typeof o.basis === "string" ? o.basis : "",
        ...(pos(o.occupancy_tokens) ? { occupancyTokens: pos(o.occupancy_tokens) } : {}),
        ...(pos(o.profile_ms_per_token) ? { profileMsPerToken: pos(o.profile_ms_per_token) } : {}),
        ...(pos(o.correction_factor) ? { correctionFactor: pos(o.correction_factor) } : {}),
        ...(pos(o.correction_samples) ? { correctionSamples: pos(o.correction_samples) } : {}),
        ...(o.excludes_cache_read === true ? { excludesCacheRead: true } : {}) };
}

/**
 * A generation's measured decode against the server's prediction for it, in words: what share of the predicted
 * speed it reached, and what the prediction rests on. A corrected prediction is learned from the last N runs; a
 * plain `profile` one is an estimate for a plain llama on this card. For a sliding-window model the prediction
 * leaves out reading the cache, so its speed is an UPPER bound and a figure under 100% is expected, and said so.
 */
export function predictionLine(g: GenTimings): string | null {
    const p = g.predicted;
    if (!p || !g.decoded || !(g.evalMs > 0)) return null;
    const measuredMs = g.evalMs / g.decoded;
    const tps = 1000 / p.msPerToken;
    const fmt = tps >= 100 ? Math.round(tps).toString() : tps.toFixed(1);
    const pct = Math.round((p.msPerToken / measuredMs) * 100);
    const n = p.correctionSamples;
    const src = p.basis === "profile_corrected"
        ? `learned from the last ${n ?? "few"} run${n === 1 ? "" : "s"}`
        : "a plain-llama estimate for this card";
    return p.excludesCacheRead
        ? `${pct}% of the predicted ${fmt} tok/s, which is an upper bound: it leaves out reading the cache (${src})`
        : `${pct}% of the predicted ${fmt} tok/s at this context (${src})`;
}

/** Parse `gen.end.timings`. Null unless BOTH durations are present, since the split is built from the pair —
 *  one without the other is a boundary with only one side. */
export function genTimingsFrom(raw: unknown): GenTimings | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Wire<GenerationTimings>;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    const promptMs = n(o.prompt_ms), evalMs = n(o.eval_ms);
    if (promptMs == null || evalMs == null) return null;
    return {
        promptMs, evalMs,
        ...(n(o.prompt_tokens) != null ? { promptTokens: n(o.prompt_tokens) } : {}),
        ...(n(o.prompt_tokens_cached) != null ? { promptTokensCached: n(o.prompt_tokens_cached) } : {}),
        ...(n(o.decoded) != null ? { decoded: n(o.decoded) } : {}),
        ...((() => {
            const sw = o.prompt_cache_swap && typeof o.prompt_cache_swap === "object" ? o.prompt_cache_swap : null;
            if (!sw || n(sw.ms) == null || typeof sw.restored !== "boolean") return {};
            return { swap: { ms: n(sw.ms)!, restored: sw.restored,
                ...(n(sw.saved_tokens) != null ? { savedTokens: n(sw.saved_tokens) } : {}),
                ...(n(sw.saved_bytes) != null ? { savedBytes: n(sw.saved_bytes) } : {}),
                ...(n(sw.evicted) ? { evicted: n(sw.evicted) } : {}),
                ...(n(sw.evicted_bytes) ? { evictedBytes: n(sw.evicted_bytes) } : {}),
                ...(sw.too_large === true ? { tooLarge: true } : {}) } };
        })()),
    };
}

/** The phases a CARD's ribbon draws: the two halves of a generation as the engine timed them, our own streamed
 *  calls' channels (which ARE the decode, per `joinGens`), and the prompt-cache swap. Everything else in a block
 *  — a tool running, a person at the gate, the undifferentiated `model` stretch — is not the card doing a known
 *  kind of work, so it is not drawn rather than drawn as a guess. */
export const RIBBON_KINDS: ReadonlySet<string> = new Set(["prefill", "decode", "swap", "think", "answer", "call"]);

/** One stretch of a card's phase strip: a timed phase of one generation, and the EVENT it is part of, so hovering the
 *  stretch can answer with that event's tooltip and light it in the lane. */
export interface RibbonSpan { t: number; until: number; kind: PhaseKind; model: string; event: ResourceEvent }

/**
 * WHAT A CARD WAS DOING, as spans for its ribbon: every timed generation phase of every model that was ON this
 * card at the time. Which card is read from the sample nearest the span (a split model is on several, and its
 * work shows on each; a one-card box needs no attribution at all). A span whose model no sample places on the
 * card is not drawn here — it may be off-box, or on another card.
 *
 * Absence is NOT idle: an unpatched server times no phases at all, so an empty ribbon claims nothing.
 */
export function ribbonSpans(events: ResourceEvent[], samples: ResourceSample[], deviceId: string, deviceCount: number): RibbonSpan[] {
    const sorted = [...samples].sort((a, b) => a.t - b.t);
    const nearest = (t: number): ResourceSample | undefined => {
        let best: ResourceSample | undefined, d = Infinity;
        for (const s of sorted) { const dd = Math.abs(s.t - t); if (dd < d) { d = dd; best = s; } if (s.t > t && dd > d) break; }
        return best;
    };
    const onCard = (model: string, t: number): boolean => {
        const m = nearest(t)?.models.find((x) => normModel(x.model) === normModel(model));
        if (!m || m.vramBytes <= 0) return false;
        return deviceCount <= 1 || (m.perDevice[deviceId] ?? 0) > 0 || m.perDevice[deviceId] === null;
    };
    const out: RibbonSpan[] = [];
    for (const e of events) {
        if (!e.model || !e.phases?.length || e.until == null) continue;
        if (!e.phases.some((p) => RIBBON_KINDS.has(p.kind))) continue;
        if (!onCard(e.model, (e.t + e.until) / 2)) continue;
        let from = e.t;
        for (const p of e.phases) {
            if (RIBBON_KINDS.has(p.kind) && p.until > from) out.push({ t: from, until: p.until, kind: p.kind, model: normModel(e.model), event: e });
            from = p.until;
        }
    }
    return out;
}

/**
 * ONE GENERATION as the lane draws it, from the server's own edges — split into PREFILL and DECODE.
 *
 * Anchored at `gen.end` and built BACKWARDS, like every span in the lane: decode occupied the last `evalMs`,
 * prefill the `promptMs` before that. Both are the engine's figures, so the boundary between them is
 * MEASURED — which is the one thing sampling could never give us (a ~400 ms prefill against a 1–2 s cadence).
 *
 * `gen.start` is OLLAMA's stamp, the moment the request took the runner, so it is the near end of a
 * REMAINDER: whatever lies between it and the prefill is neither phase — scheduling, tokenizing, sampler setup
 * — and is drawn as `other` rather than folded into either. Usually 12–15 ms; measured at 1.78 s once, on a
 * generation whose model was still LOADING. That load is drawn as its own span, so when one ended inside the
 * generation the span starts where it ended (`loadEnd`) — otherwise the same seconds would be drawn twice.
 *
 * A re-entry into prefill after decode (a context shift) cannot be represented: the engine reports one pair
 * of durations per request, so it is one stretch each. Without a `gen.start` (a reconnect mid-generation)
 * there is no remainder to draw, and none is invented.
 */
export function genSpan(o: { model: string; startAt?: number; endAt: number; timings: GenTimings; loadEnd?: number; hint?: ServerHint | null }): ResourceEvent {
    const { model, endAt, timings } = o;
    const decodeFrom = endAt - timings.evalMs;
    const prefillFrom = decodeFrom - timings.promptMs;
    // A prompt-cache SWAP happens before the prefill and is the engine's own measure too, so it is a measured
    // phase of its own rather than part of the remainder.
    const swapFrom = prefillFrom - (timings.swap?.ms ?? 0);
    // The remainder begins at the later of the runner being taken and any load finishing; a start AFTER the
    // measured phases began would mean the two clocks disagree by more than the gap, and then there is none.
    let t = Math.max(o.startAt ?? swapFrom, o.loadEnd ?? -Infinity);
    if (t > swapFrom) t = swapFrom;
    const phases: { kind: PhaseKind; until: number }[] = [];
    if (swapFrom - t >= 1) phases.push({ kind: "other", until: swapFrom });
    if (timings.swap?.ms) phases.push({ kind: "swap", until: prefillFrom });
    phases.push({ kind: "prefill", until: decodeFrom }, { kind: "decode", until: endAt });
    return { t, until: endAt, kind: "gen", label: `${model} generating`, model, via: "server", phases, gen: timings,
        ...(o.hint ? { hint: o.hint } : {}) };
}

/** What a request told a patched ollama it was for, as the server echoes it on `gen.end` (`ollama-slop:hints2`):
 *  ours (RequestHint in contract.ts, plus the `request` id we minted) or any other client's — Open WebUI labels its
 *  own task calls `use: "utility"` in an `owui-` session. Every field optional; absent means the request said
 *  nothing, never a default. */
export interface ServerHint {
    use?: string;
    session?: string;
    request?: string;
    after?: string;
    synthetic?: boolean;
}

/** What the lane says about a SERVER generation no session of ours matched. It used to say only that it was not
 *  started from this browser; with a hint it can say whose it was — Open WebUI's own calls are `owui-`, another
 *  window.ml session is `wml-` (a tab or browser this panel is not showing, since ours would have matched) — and
 *  what kind of work (`use`, in words). An unknown `use` is quoted as sent rather than translated. */
export function serverGenNote(h?: ServerHint | null, isShown?: (session: string) => boolean): string {
    const base = "reported by the server — not started from this browser";
    if (!h) return base;
    // ONE OF THE SESSIONS THIS PANEL SHOWS. The panel's own side tasks about a session — its title, a step summary —
    // are not drawn as lane events of their own, so nothing matches them; calling them "a session this panel isn't
    // showing" was wrong about a session sitting right there (caught live).
    if (h.session && isShown?.(h.session)) {
        return h.use === "utility"
            ? "a side task this panel ran for one of its sessions (its title or a summary)"
            : "a request in one of this panel's sessions that matched none of its steps";
    }
    const who = !h.session ? null
        : h.session.startsWith("owui-") ? "Open WebUI"
        : h.session.startsWith("wml-") ? "a window.ml session this panel isn't showing (another tab or browser)"
        : "another client";
    const what = !h.use ? null
        : ({ interactive: "a person reading it", agent: "an agent step", utility: "a side task", batch: "bulk work" } as Record<string, string>)[h.use]
            ?? `"${h.use}"`;
    const parts = [who, what, h.synthetic ? "synthetic traffic" : null].filter(Boolean);
    return parts.length ? `reported by the server: ${parts.join(", ")}` : base;
}

/** Read `gen.end.hint`. Unknown values are kept as sent (the server accepts any `use`); anything that is not a
 *  string is dropped rather than coerced, and an empty result is null. */
export function hintFrom(raw: unknown): ServerHint | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Wire<RequestHint>;
    const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
    const h: ServerHint = {
        ...(str(o.use) ? { use: str(o.use) } : {}), ...(str(o.session) ? { session: str(o.session) } : {}),
        ...(str(o.request) ? { request: str(o.request) } : {}), ...(str(o.after) ? { after: str(o.after) } : {}),
        ...(o.synthetic === true ? { synthetic: true } : {}),
    };
    return Object.keys(h).length ? h : null;
}

/** WHAT ONE GENERATION LEFT IN THE KV CACHE, as shares of the cache's token capacity, bottom to top:
 *  reused from the cache, computed this turn (prefill), decoded this turn. The cache is reserved in full at
 *  load and its bytes never move, so this is the only place its FILL can be read — and it is read from the
 *  engine's own counts, not sampled.
 *
 *  - The capacity is `context_length × slots`: the context is PER SLOT (llama.cpp rounds each up to a multiple
 *    of 256), and the reservation covers every slot.
 *  - When the cached count was NOT reported (an older build omitted it; a route that never had it), the prompt
 *    is ONE layer (`prompt`) rather than a guessed split — 0 cached is a cold prefill and absent is unknown.
 *  - Shares are of TOKENS, not bytes: a sliding-window layer stops growing at its window and recurrent state
 *    does not grow per token at all, so "40% of the band" must never be read as 40% of the bytes in use.
 *  - `overflow` when the tokens exceed the capacity: the context SHIFTED (older tokens were dropped to make
 *    room), and the layers are scaled to fit rather than drawn past the band.
 *
 *  Null when there is no prompt count or no capacity to be a share OF. */
export function kvFill(gen: GenTimings, contextTokens: number | null | undefined, slots = 1): { cached?: number; computed?: number; prompt?: number; decoded: number; overflow: boolean } | null {
    const cap = (contextTokens ?? 0) * Math.max(1, slots);
    if (!(cap > 0) || gen.promptTokens == null) return null;
    const decoded = gen.decoded ?? 0;
    const total = gen.promptTokens + decoded;
    const scale = total > cap ? cap / total : 1;
    const f = (n: number) => (n * scale) / cap;
    const cached = gen.promptTokensCached;
    return {
        ...(cached != null
            ? { cached: f(Math.min(cached, gen.promptTokens)), computed: f(Math.max(0, gen.promptTokens - cached)) }
            : { prompt: f(gen.promptTokens) }),
        decoded: f(decoded),
        overflow: total > cap,
    };
}

/** How far apart OUR finish stamp and the server's `gen.end` may be and still be one generation. Our stamp is
 *  taken in the service worker when the response completes, so it trails the server's by the return leg of the
 *  network, and the server's clock reaches us through one `hello` anchor. Wide enough for both; a model runs
 *  one request at a time at `n_parallel` 1, so a neighbour of the same model is seconds away, not this. */
export const GEN_JOIN_TOLERANCE_MS = 1500;

/** Where a SESSION block's model work ends — the whole block for a plain turn, the last model-ish phase for a
 *  tool step (the rest is dispatch, a human at a gate, the tool). */
const modelEndOf = (e: ResourceEvent): number | null => {
    if (e.kind === "gen") return e.until ?? null;
    if (e.kind !== "tool" || !e.phases?.length) return null;
    let end: number | null = null;
    for (const ph of e.phases) if (["model", "think", "answer", "call"].includes(ph.kind)) end = ph.until;
    return end;
};

/**
 * JOIN the server's generations to the session blocks they ARE. Our own calls reach the server too, so with
 * the stream carrying, every one of them arrives twice — once as the step block the session drew, once as a
 * server `gen` span — and drawing both is the same generation on the lane twice.
 *
 * The session block wins (it carries the click-through, the cost and the channel phases), and takes the
 * server's figures: `gen` goes onto it, and its model stretch is split with the measured prefill — the
 * leading, pre-first-token stretch of a streamed call becomes `other | prefill` (its channel phases ARE the
 * decode); a non-streamed call's single `model` phase becomes `other | prefill | decode`, anchored backwards
 * from where the model work ended. A split that does not FIT the stretch it would subdivide (clock skew, a
 * mis-join) is not drawn: the figures still attach, the phases are left as they were.
 *
 * Matched per model, nearest first, each side at most once. Server gens that match nothing are other traffic
 * and are returned to be drawn as they are.
 */
export function joinGens(sessionEvents: ResourceEvent[], serverEvents: ResourceEvent[]): { session: ResourceEvent[]; server: ResourceEvent[] } {
    const gens = serverEvents.filter((e) => e.kind === "gen" && e.via === "server" && e.gen && e.model && e.until != null);
    if (!gens.length) return { session: sessionEvents, server: serverEvents };
    const pairs: { si: number; g: ResourceEvent; d: number }[] = [];
    // EXACT FIRST. A generation the server records with OUR request id is that call's, wherever its end landed:
    // no tolerance to tune, and two calls of one model finishing together cannot swap. `d: -1` sorts these ahead
    // of every timing match below.
    const byRequest = new Map<string, ResourceEvent>();
    for (const g of gens) if (g.hint?.request) byRequest.set(g.hint.request, g);
    sessionEvents.forEach((s, si) => {
        if (s.open || !s.model) return;
        const g = s.requestId ? byRequest.get(s.requestId) : undefined;
        if (g) { pairs.push({ si, g, d: -1 }); return; }
        // By TIMING only when an id cannot settle it: either side has none (an older build, a route that dropped
        // the hint). When both carry one and they differ, the generation is somebody else's call — another tab,
        // another browser — however close its end is.
        const end = modelEndOf(s);
        if (end == null) return;
        for (const g of gens) {
            if (g.model !== s.model) continue;
            if (s.requestId && g.hint?.request) continue;
            const d = Math.abs(end - g.until!);
            if (d <= GEN_JOIN_TOLERANCE_MS) pairs.push({ si, g, d });
        }
    });
    pairs.sort((a, b) => a.d - b.d);
    const usedS = new Set<number>(), usedG = new Set<ResourceEvent>();
    const session = sessionEvents.slice();
    for (const { si, g } of pairs) {
        if (usedS.has(si) || usedG.has(g)) continue;
        usedS.add(si); usedG.add(g);
        // An ASIDE takes the figures but keeps its outline: it is drawn unfilled because it is not the run's work,
        // and phases would fill it. It only ever joins by request id (it has no model stretch to time against).
        session[si] = session[si].kind === "aside" ? { ...session[si], gen: g.gen! } : withGen(session[si], g.gen!);
    }
    return { session, server: serverEvents.filter((e) => !usedG.has(e)) };
}

/** One session block with a matched generation's figures, and its model stretch split where they fit. */
function withGen(e: ResourceEvent, timings: GenTimings): ResourceEvent {
    const phases = e.phases?.length ? e.phases : [{ kind: "model" as PhaseKind, until: e.until ?? e.t }];
    const out: { kind: PhaseKind; until: number }[] = [];
    let from = e.t, split = false;
    for (const [i, ph] of phases.entries()) {
        const next = phases[i + 1];
        if (!split && ph.kind === "model") {
            const len = ph.until - from;
            // Followed by a channel phase → this is the stretch BEFORE the first token: prefill ends where it
            // ends. Otherwise it is the whole model call: decode ends where it ends, prefill before that.
            const streamed = !!next && ["think", "answer", "call"].includes(next.kind);
            const swapMs = timings.swap?.ms ?? 0;
            const need = swapMs + timings.promptMs + (streamed ? 0 : timings.evalMs);
            if (need <= len) {
                const prefillEnd = streamed ? ph.until : ph.until - timings.evalMs;
                const prefillFrom = prefillEnd - timings.promptMs;
                const swapFrom = prefillFrom - swapMs;
                if (swapFrom - from >= 1) out.push({ kind: "other", until: swapFrom });
                if (swapMs) out.push({ kind: "swap", until: prefillFrom });
                out.push({ kind: "prefill", until: prefillEnd });
                if (!streamed) out.push({ kind: "decode", until: ph.until });
                split = true;
                from = ph.until;
                continue;
            }
        }
        out.push(ph);
        from = ph.until;
    }
    return { ...e, gen: timings, ...(split ? { phases: out } : {}) };
}

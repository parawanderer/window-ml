// resource-decode.ts — how fast a model SHOULD run and what it is doing: the expected decode rate from the box's
// measured profile, the memory-bandwidth roofline, the runner's live activity, and how full its KV cache is.
//
// The three readers (`expectedDecodeFrom`, `rooflineFrom`, `activityFrom`) each take one optional field of the patched
// server's `/api/ps` (`docs/FORKED-BACKENDS.md`) and return null when it is absent: a stock server not reporting it
// is not the same as zero. Split out of resource-model.ts.

import type { Wire, ExpectedDecode as WireExpectedDecode, ModelRoofline, RooflineDevice, RunnerActivity as WireRunnerActivity } from "./events-wire";

/**
 * WHAT THIS MODEL SHOULD DECODE AT, where it is placed now (`expected_decode` on `/api/ps`, `ollama-slop:correction`).
 * Not a ceiling: the roofline is what memory bandwidth allows, this is a prediction from the box's measured profile
 * and, once a model has run enough clean generations, corrected by what it actually measured — so it also covers a
 * mixture of experts, where no roofline is given. `tokensPerSec` is with an EMPTY cache. The correction is keyed per
 * card index, so a model that moves to the other, identical card starts again from the plain profile.
 */
export type ExpectedDecode =
    | { tokensPerSec: number; basis: string;
        /** The profile's prediction before the correction; present only when corrected. */
        profileTokensPerSec?: number;
        /** Median measured ÷ predicted TIME over this model's recent clean generations: 1.16 is 16% slower. */
        correctionFactor?: number; correctionSamples?: number;
        /** Extra ms per token per 1,000 tokens in the cache. Absent for a sliding-window model. */
        msPerTokenPer1k?: number;
        /** The share of the weights one token reads — a mixture of experts only. */
        activeWeightsFraction?: number }
    | { unavailable: string };

/** Parse `/api/ps` `expected_decode`. Null when absent or unshaped. */
export function expectedDecodeFrom(raw: unknown): ExpectedDecode | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Wire<WireExpectedDecode>;
    if (typeof o.unavailable === "string" && o.unavailable) return { unavailable: o.unavailable };
    const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const tps = pos(o.tokens_per_sec);
    if (!tps) return null;
    return { tokensPerSec: tps, basis: typeof o.basis === "string" ? o.basis : "",
        ...(pos(o.profile_tokens_per_sec) ? { profileTokensPerSec: pos(o.profile_tokens_per_sec) } : {}),
        ...(pos(o.correction_factor) ? { correctionFactor: pos(o.correction_factor) } : {}),
        ...(pos(o.correction_samples) ? { correctionSamples: pos(o.correction_samples) } : {}),
        ...(pos(o.ms_per_token_per_1k_context) ? { msPerTokenPer1k: pos(o.ms_per_token_per_1k_context) } : {}),
        ...(pos(o.active_weights_fraction) ? { activeWeightsFraction: pos(o.active_weights_fraction) } : {}) };
}

/**
 * How a model's expected decode speed is SAID, from its `basis`. A corrected figure is an expectation, learned from
 * this model's own runs; a plain `profile` figure is an estimate for a plain llama on this card, and for a small or
 * unusual model it can be far off (854 predicted, 521 measured, in the capture) — so it is worded as an estimate and
 * drawn quieter until a correction exists. Unavailable reasons are said in words.
 */
export function expectedPhrase(ed: ExpectedDecode): { text: string; quiet: boolean; tip: string } {
    if ("unavailable" in ed) {
        const why: Record<string, string> = {
            profile_pending: "not measured yet: the box profile runs once, the first time the box is idle",
            partly_on_cpu: "no expected speed: part of this model runs from system RAM, which nothing measures",
            memory_unknown: "no expected speed: the runner reported no weights on its cards",
        };
        return { text: why[ed.unavailable] ?? `no expected speed: ${ed.unavailable}`, quiet: true, tip: "" };
    }
    const n = (v: number) => (v >= 100 ? Math.round(v).toString() : v.toFixed(1));
    const moe = ed.activeWeightsFraction ? ` A mixture of experts: each token reads ${(ed.activeWeightsFraction * 100).toFixed(1)}% of its weights.` : "";
    if (ed.basis === "profile_corrected") {
        const f = ed.correctionFactor;
        const off = f ? ` it runs ${Math.abs(Math.round((f - 1) * 100))}% ${f >= 1 ? "slower" : "faster"} than the box profile alone predicts${ed.profileTokensPerSec ? ` (${n(ed.profileTokensPerSec)} tok/s)` : ""}.` : "";
        // "The last N": the correction is a window of the model's last 20 clean runs, and since 2026-09-13 it is
        // shared by identical cards, so it is not "on this placement" but on this KIND of card.
        const runs = ed.correctionSamples ? `learned from the last ${ed.correctionSamples} run${ed.correctionSamples === 1 ? "" : "s"}` : "learned from its runs";
        return { text: `~${n(ed.tokensPerSec)} tok/s expected`, quiet: false,
            tip: `The decode speed to expect here with an empty cache, ${runs} on this kind of card:${off}${moe}` };
    }
    return { text: `~${n(ed.tokensPerSec)} tok/s estimate`, quiet: true,
        tip: `An estimate from this box's measured profile, for a plain llama on this card; this model has not run enough clean generations here to correct it, and a small or unusual model can be far off.${moe}` };
}

/** What the engine is doing with a model right now, from `llama-server`'s `/slots`.
 *
 *  Two DIFFERENT KINDS of fact live in here and must not be read alike. `promptTokens` is OCCUPANCY: it is
 *  `n_past`, it survives the task that filled it, and it is the honest answer to "would less context help".
 *  Everything else describes the task IN FLIGHT, and the server clears those the moment it ends — so on an
 *  idle runner they are absent while `promptTokens` still stands, describing the LAST task. Reading a
 *  `promptTokens` on an idle runner as work in progress is the one mistake this shape invites. */
export interface RunnerActivity {
    /** `prefill` reads the prompt, `decode` generates, `idle` is neither. The discriminator for everything
     *  else here: while idle, the in-flight counts are gone and only the occupancy is meaningful. */
    phase: "prefill" | "decode" | "idle";
    /** Slots on this runner, and how many are working. `slots` is 1 on all hardware this has been seen on,
     *  so a `slotsBusy` above 1 is untested rather than impossible. */
    slots: number;
    slotsBusy: number;
    /** `n_past` — tokens resident in the KV cache. Against `contextLength` it is the occupancy, and that
     *  denominator is the PER-SLOT context the server already divided, so no arithmetic is owed here. */
    promptTokens?: number;
    /** How much of the prompt has been read, in the engine's batch-sized steps. Prefill PROGRESS, so a
     *  prefill can be drawn filling rather than as an opaque block. Absent once the task ends. */
    promptTokensDone?: number;
    /** How much of the prompt came from the prefix cache and was never computed. This is the explanation for
     *  a prefill too short to draw: measured on the box, a repeat of the same 4098-token prompt hit 4097 of
     *  them, leaving one token to compute — so the phase did not last long enough to be sampled at all. An
     *  impossibly fast prompt is a cache hit, not a broken clock, and this is the field that says so. */
    promptTokensCached?: number;
    /** Tokens generated so far for the task in flight. Absent once it ends. */
    decoded?: number;
    /** The model's HOST-RAM PROMPT CACHE (`--cache-ram`): the conversations parked in system RAM while another
     *  took the model's one slot, their combined length and size, and the limit (llama-server's default 8 GiB,
     *  per model). Host RAM, never VRAM. Absent until the model's first request, since the engine only reports
     *  it then — absent is "not reported", not an empty cache. Unlike the in-flight counts it survives idle:
     *  those conversations really are still parked. */
    promptCache?: { entries: number; tokens: number; bytes: number; limitBytes?: number };
}

/**
 * THE DECODE CEILING the server computed for a model's placement — how fast decode COULD go if every token did
 * nothing but read the memory it has to read — or the server's reason for not computing one.
 *
 * Decode is memory-bandwidth-bound, so the ceiling is bytes-read-per-token over bandwidth, summed over the
 * devices a layer-split model is on in turn: `1 / Σ_d (bytes_d / bw_d)`. The measured split-vs-single figures
 * on gpubox came out identical, as that predicts. What the server sends is the EMPTY-context figure plus a
 * per-token KV rate, because the cache is read every token too and grows with the context: at 38k tokens a 32B
 * model reads 9.9 GB of cache against 19.8 GB of weights per token, and decode fell 30% (the ceiling predicted
 * 33%). So a measured speed is compared against the ceiling AT ITS OCCUPANCY (`decodeCeiling`) — against the
 * empty one, a box running at a steady 80% efficiency reads as collapsing to 53%.
 *
 * `unavailable` carries the reason there is no honest ceiling: `mixture_of_experts` (an MoE model reads only
 * its active experts — a dense bound on one measured at 165%, which reads as a server bug), `partly_on_cpu`,
 * `bandwidth_unknown`. `kvBytesPerToken` is absent for a sliding-window model, whose windowed layers stop growing
 * at the window, so the cache follows no single per-token rate.
 */
export type Roofline =
    | { basis: string; bytesPerToken: number; ceilingTps: number; kvBytesPerToken?: number;
        devices: { gpuId?: string; pciId?: string; bytesPerToken: number; kvBytesPerToken?: number; bandwidth: number }[] }
    | { unavailable: string };

/** Parse `/api/ps` `roofline`. Null when absent or unshaped — not reported, which draws nothing. */
export function rooflineFrom(raw: unknown): Roofline | null {
    if (!raw || typeof raw !== "object") return null;
    const o = raw as Wire<ModelRoofline>;
    if (typeof o.unavailable === "string" && o.unavailable) return { unavailable: o.unavailable };
    const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
    const bpt = pos(o.bytes_per_token), tps = pos(o.ceiling_tokens_per_sec);
    if (!bpt || !tps) return null;
    const devices = (Array.isArray(o.devices) ? o.devices : []).flatMap((x) => {
        const d = x as Wire<RooflineDevice>;
        const b = pos(d.bytes_per_token), bw = pos(d.memory_bandwidth_bytes_per_sec);
        if (!b || !bw) return [];
        return [{ ...(d.gpu_id != null ? { gpuId: String(d.gpu_id) } : {}), ...(typeof d.pci_id === "string" ? { pciId: d.pci_id } : {}),
            bytesPerToken: b, bandwidth: bw, ...(pos(d.kv_bytes_per_context_token) ? { kvBytesPerToken: pos(d.kv_bytes_per_context_token) } : {}) }];
    });
    return { basis: typeof o.basis === "string" ? o.basis : "", bytesPerToken: bpt, ceilingTps: tps, devices,
        ...(pos(o.kv_bytes_per_context_token) ? { kvBytesPerToken: pos(o.kv_bytes_per_context_token) } : {}) };
}

/** The decode ceiling AT A GIVEN CONTEXT OCCUPANCY, in tokens per second: `1 / Σ_d ((bytes_d + occ × kv_d) /
 *  bw_d)`, per device with each device's own KV rate. For a generation, occupancy is its mean over the decode
 *  — `prompt_tokens + decoded / 2`. Null when there is no honest figure: an unavailable ceiling, no per-device
 *  figures, or any device with no KV rate (a sliding-window cache follows no single rate, and leaving it out
 *  would OVERSTATE the ceiling by exactly the traffic the comparison exists to count). */
export function decodeCeiling(r: Roofline | null | undefined, occupancy: number): number | null {
    if (!r || "unavailable" in r || !r.devices.length) return null;
    let secs = 0;
    for (const d of r.devices) {
        if (d.kvBytesPerToken == null) return null;
        secs += (d.bytesPerToken + Math.max(0, occupancy) * d.kvBytesPerToken) / d.bandwidth;
    }
    return secs > 0 ? 1 / secs : null;
}

/** Read a runner's live `activity` from `/api/ps` (phase, tokens so far), or null when the server does not report it. */
export function activityFrom(raw: unknown): RunnerActivity | null {
    if (!raw || typeof raw !== "object") return null;
    const a = raw as Wire<WireRunnerActivity>;
    const phase = a.phase === "prefill" || a.phase === "decode" || a.phase === "idle" ? a.phase : null;
    if (!phase) return null;   // an unrecognised phase is not a fourth state to invent a rendering for
    const n = (k: keyof WireRunnerActivity) => { const v = a[k]; return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined; };
    const out: RunnerActivity = {
        phase, slots: n("slots") ?? 1, slotsBusy: n("slots_busy") ?? 0,
    };
    const past = n("prompt_tokens"), done = n("prompt_tokens_done");
    const cached = n("prompt_tokens_cached"), dec = n("decoded");
    if (past !== undefined) out.promptTokens = past;
    // The in-flight counts are meaningless once the task is over, and the server already drops them — but an
    // older or oddly-behaved build that keeps them would have this UI drawing the last task as a live one.
    // Phase is the discriminator the server intends, so it is applied here rather than trusted to hold.
    if (phase !== "idle") {
        if (done !== undefined) out.promptTokensDone = done;
        if (cached !== undefined) out.promptTokensCached = cached;
        if (dec !== undefined) out.decoded = dec;
    }
    const pc = a.prompt_cache && typeof a.prompt_cache === "object" ? a.prompt_cache : null;
    const pn = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
    if (pc && pn(pc.entries) != null && pn(pc.bytes) != null) out.promptCache = {
        entries: pn(pc.entries)!, tokens: pn(pc.tokens) ?? 0, bytes: pn(pc.bytes)!,
        ...(pn(pc.limit_bytes) ? { limitBytes: pn(pc.limit_bytes) } : {}),
    };
    return out;
}

/** KV cache occupancy as a fraction, or null when either half is unknown.
 *
 *  The denominator is the model's own `context_length`, which is the PER-SLOT window the server has already
 *  divided by the parallel slot count — so this is a straight ratio and dividing again would be wrong. Null
 *  rather than 0 when there is nothing to divide: a model whose runner cannot be asked has an UNKNOWN cache,
 *  and an empty bar is a claim about memory nobody measured. */
export function kvOccupancy(r: { activity?: RunnerActivity; contextLength: number | null }): number | null {
    const past = r.activity?.promptTokens;
    const ctx = r.contextLength;
    if (past === undefined || !ctx || ctx <= 0) return null;
    return Math.min(1, past / ctx);
}

/** A fraction as a percentage for a chip, where 0 and "nearly 0" must not read the same.
 *
 *  A cache holding 30 of 262,144 tokens rounds to 0%, and "0%" beside a reserved 40 GiB says the cache is
 *  EMPTY — which is the answer the reader is about to act on, and it is wrong. `<1%` is the same
 *  glance-width and says the true thing. Zero itself still prints `0%`: an empty cache is a real reading and
 *  hedging it would throw away the one case the number is exactly right about. */
export function fmtOccupancy(frac: number): string {
    const pct = frac * 100;
    if (pct > 0 && pct < 1) return "<1%";
    if (pct < 100 && pct > 99) return ">99%";
    return `${Math.round(pct)}%`;
}

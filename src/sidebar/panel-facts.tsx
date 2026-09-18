// panel-facts.tsx — what the panel says ABOUT one loaded model: what it is, what it costs, how long it stays.
//
// Two tip bodies (`ModelFacts`, `CostFacts`) and the readings they are built from. They are here rather than in
// vram.tsx because BOTH surfaces show them: the model rows in the panel, and the chart's tips when you hover a
// band. Holding them beside the rows meant the chart imported them from the panel and the panel imported the
// chart back, which is the cycle this file is part of undoing.
//
// `modelCaps` comes along because the two readings that ask what a model IS (`isChatModel`, `isEmbedding`) are
// the only things that consult it: a model that neither generates nor embeds still has to render as something
// honest rather than as a blank.

import { signal } from "@preact/signals";
import type { RunStats } from "../contract";
import { fmtCtx } from "../contract-config";
import type { LoadedModel } from "../contract-server";
import { type Capacity, activityFrom, kvOccupancy, quantPlain, fmtOccupancy, expectedDecodeFrom, expectedPhrase, formatBytes } from "../resource-model";
import { usageByModel, type UsageSource } from "./model-stats";
import { capacity } from "./panel-state";
import { rev, sessionMap } from "./store";

/** BEYOND THIS, THE DEADLINE IS NOT A DEADLINE. `keep_alive: -1` pins a model in memory, and Ollama expresses
 *  that as an `expires_at` about a century out — so a countdown rendered from it reads "36159d 12h", which is
 *  a true number and a useless one: nobody is waiting for it, and a day count that large reads as a bug in
 *  the panel rather than as a decision someone made on purpose. A year is far past any keep-alive a person
 *  would actually set and far short of the pinned stamp, so nothing real falls between them. */
export const NO_EXPIRY_MS = 365 * 24 * 3600 * 1000;

// Live keep-alive countdown from an /api/ps expires_at stamp, as a compact
// two-unit d/h/m/s string ("2d 3h", "5m 12s", "44s") for the VRAM row. Ollama
// evicts a model once this hits zero; each use resets it (Ollama recomputes
// expires_at). Returns null when there's no stamp or it's already elapsed.
//
// `busy` STOPS the clock, and it is not a nicety: the deadline is only rewritten when a request FINISHES, so
// throughout a generation the stamp stands still while this counts down against it — on a long enough one,
// straight past zero and into a model that the display says should already have been evicted. There is
// nothing to count to while it works, so it says so instead of drawing a number that is wrong. It also covers
// traffic this browser never sees; a local in-flight flag would only freeze the runs we started ourselves.
export function fmtTTL(expiresAt: string | null, busy?: boolean): string | null {
    if (busy) return "in use";
    if (!expiresAt) return null;
    const ms = new Date(expiresAt).getTime() - Date.now();
    if (isNaN(ms) || ms <= 0) return null;
    if (ms > NO_EXPIRY_MS) return "pinned";
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400); s -= d * 86400;
    const h = Math.floor(s / 3600); s -= h * 3600;
    const m = Math.floor(s / 60); s -= m * 60;
    if (d) return `${d}d ${h}h`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}

// Live VRAM: a sparkline of total usage over time + a per-model legend with
// evict controls. Reads the shared OLLAMA_PS signals (polled at App level while
// the sidebar is open) and accumulates the sparkline history locally.
/** The facts about one resident model: context window and keep-alive TTL, each with its explanation. Shared
 *  by the legend row and the chart's hover tooltip so the two can never drift — a badge added here appears in
 *  both placements, which is the whole reason this isn't inlined twice. */
// What each resident model can DO, by name. /api/ps says nothing about a model's role, so an embedding model
// sits in the list looking exactly like a chat model — and one of those is 5.8 GiB of a card you were trying
// to account for. /api/show knows (`capabilities` includes "embedding"), so ask ONCE per model and keep it:
// capabilities don't change while a model is loaded, and the panel re-renders every two seconds.
export const modelCaps = signal<Record<string, string[] | null>>({});

/** Only a POSITIVE answer counts: a cloud model or an old Ollama reports nothing, and "unknown" must not be
 *  rendered as a claim either way. */
export const isEmbedding = (model: string): boolean => !!modelCaps.value[model]?.includes("embedding");

/** The counterpart: a model that GENERATES. Also positive-only — a model whose capabilities nobody reported
 *  gets no badge at all, because "chat" would be a guess and the two are indistinguishable by name. */
export const isChatModel = (model: string): boolean => {
    const caps = modelCaps.value[model];
    return !!caps && caps.includes("completion") && !caps.includes("embedding");
};

/** What this model has COST this browsing session, across every chat and run in the list. Recomputed from the
 *  session map on each render rather than kept as its own accumulator: the map IS the record, and a second
 *  copy is a second thing to keep true. `rev` is what makes it re-read (the map mutates in place). */
export function costOf(model: string): RunStats | null {
    void rev.value;
    return usageByModel([...sessionMap.values()] as UsageSource[])[model] ?? null;
}

/** The cost line under a model's name: what it spent, and how fast — with the rate's BASIS said out loud,
 *  since one from Ollama's own eval timings and one from wall clock (network and queue included) are not the
 *  same measurement. */
export function CostFacts({ model }: { model: string }) {
    const c = costOf(model);
    if (!c || !c.calls) return null;
    return (
        <div class="vram-cost">
            {c.calls} call{c.calls === 1 ? "" : "s"} · {c.inTokens.toLocaleString()} in / {c.outTokens.toLocaleString()} out
            {c.tokPerSec != null ? <> · {c.tokPerSec.toFixed(1)} tok/s <span class="rc-tip-pct">({c.genBasis === "eval" ? "generation only" : c.genBasis === "wall" ? "incl. network" : "mixed"})</span></> : null}
        </div>
    );
}

/** Device ids this model is resident on that capacity no longer reports. A card can vanish while ps still
 *  lists what was loaded onto it, and then the model's VRAM is in the list with no track to appear in — true,
 *  but asymmetric enough to need saying out loud. */
export function orphanedOn(m: LoadedModel, cap: Capacity | null): string[] {
    if (!cap) return [];   // capacity unknown → nothing to contradict
    return (m.gpus || []).map((g) => g.id).filter((id) => !cap.devices.some((d) => d.id === id));
}

/** ONE RESIDENT MODEL'S facts: what it occupies, where (which card, or spilled into system RAM), and
 *  how long until its keep-alive expires. Shared by the panel's model list and the status dot's tooltip,
 *  so the two cannot disagree about the same model. */
export function ModelFacts({ m, tips = true }: { m: LoadedModel; tips?: boolean }) {
    const ttl = fmtTTL(m.expiresAt, m.busy);
    const orphaned = orphanedOn(m, capacity.value);
    // Parsed here rather than read raw: `activityFrom` is what turns an absent object into null instead of an
    // idle runner, and `kvOccupancy` is what refuses a denominator it does not have. Both distinctions are the
    // whole content of these two chips.
    const act = activityFrom(m.activity);
    // Derived THROUGH `act` rather than beside it, so "there is an occupancy to draw" implies "there is a
    // reading it came from". The chip prints the exact token counts, and reading them off an object the
    // percentage did not come from is how a row ends up showing one model's number with another's denominator.
    const kv = act ? kvOccupancy({ activity: act, contextLength: m.contextLength }) : null;
    const past = kv !== null ? act!.promptTokens! : 0;
    // Only the row's copy has its own tooltips to defer to; the chart tip renders these as plain text.
    const yieldTip = tips
        ? { onPointerEnter: () => (rowTipSuppressed.value = true), onPointerLeave: () => (rowTipSuppressed.value = false) }
        : {};
    return (
        <>
            {orphaned.length ? (
                <span class={tips ? "tt vram-orphan" : "vram-orphan"} {...yieldTip}>card gone
                    {tips ? <span class="tt-pop left above" role="tooltip">Still resident on {orphaned.length > 1 ? "devices" : "device"} {orphaned.join(", ")}, which the server has stopped reporting — a driver crash, a GPU reset, or a container that lost the device. Its memory is real but has no pool to be drawn against, so it appears here and not in the chart.</span> : null}
                </span>
            ) : null}
            {/* What the model IS, beside what it costs. An embedding model and a chat model occupy memory
                identically and read identically in a list of names, so the row says which — and says NOTHING
                when the server never reported capabilities, since "chat" would then be a guess. */}
            {isEmbedding(m.model) ? (
                <span class={tips ? "tt vram-embed" : "vram-embed"} {...yieldTip}><span class="vram-badge-t">embed</span>
                    {tips ? <span class="tt-pop left above" role="tooltip">An EMBEDDING model — it turns text into vectors for search and retrieval; it doesn't chat. It holds its VRAM like any other resident model, and evicts the same way.</span> : null}
                </span>
            ) : isChatModel(m.model) ? (
                <span class={tips ? "tt vram-chat" : "vram-chat"} {...yieldTip}><span class="vram-badge-t">chat</span>
                    {tips ? <span class="tt-pop left above" role="tooltip">A generating model — what <code>ml.chat</code> and <code>ml.agent</code> run on. Shown beside the embedding badge so a row you did not expect to be holding a card says which kind it is.</span> : null}
                </span>
            ) : null}
            {/* WHICH BUILD it is. The name rarely says which quantization was pulled, and it is the one choice
                a user makes about a model that changes its size, its speed and its answers at once. */}
            {m.quant ? (() => {
                // IN WORDS on the chip — "4-bit weights", not "Q4_K_M" — with the code and what it means behind
                // it. An unknown code is shown as itself rather than guessed at.
                const plain = quantPlain(m.quant);
                return (
                    <span class={tips ? "tt vram-quant" : "vram-quant"} {...yieldTip}><span class="vram-badge-t">{plain?.short ?? m.quant}</span>
                        {tips ? <span class="tt-pop left above" role="tooltip"><code>{m.quant}</code>: {plain?.detail ?? "the precision its weights are stored at."} A lower precision is smaller and faster and answers somewhat worse; the same model at another quantization is a different download.{m.paramSize ? <> {m.paramSize} parameters{m.family ? <>, {m.family} family</> : null}.</> : null}</span> : null}
                    </span>
                );
            })() : null}
            {m.contextLength ? (
                <span class={tips ? "tt vram-ctx" : "vram-ctx"} {...yieldTip}>{fmtCtx(m.contextLength)}
                    {/* The chip's figure LEADS, then the exact count. They are the same number — 262,144 tokens
                        is 256K, binary, the way every context window is sized — but a chip reading "256K" beside
                        a tooltip reading "262,144" looks like the panel contradicting itself, and the reader has
                        no way to know which one to trust. Saying both, in that order, is what reconciles them.
                        Same rule as the memory figures: the round number is the binary one. */}
                    {tips ? <span class="tt-pop left above" role="tooltip">Loaded with a {fmtCtx(m.contextLength)}-token context window — {m.contextLength.toLocaleString()} tokens exactly ({fmtCtx(m.contextLength)} is binary, like memory sizes). Ollama preallocates the KV cache for the FULL window, even when your prompts are short. Load with a smaller <code>num_ctx</code> to reclaim it.</span> : null}
                </span>
            ) : null}
            {/* HOW MUCH OF THAT WINDOW IS ACTUALLY IN USE. The context chip above says what was RESERVED and its
                tooltip ends by advising a smaller `num_ctx` — advice it has no way to know applies here. This
                is the evidence for it: a 256K window at 2% is reclaimable, the same window at 90% is not, and
                the two are indistinguishable from the byte figure on the right. It is a reading about traffic
                this browser never started, which is the whole reason it has to come from the server. */}
            {kv !== null ? (
                <span class={tips ? "tt vram-kv" : "vram-kv"} {...yieldTip}>{fmtOccupancy(kv)}
                    {tips ? <span class="tt-pop left above" role="tooltip">The KV cache is holding {past.toLocaleString()} of {(m.contextLength ?? 0).toLocaleString()} tokens. The BYTES do not move with it — Ollama reserves the cache for the whole window when the model loads and it does not grow — so this is how much of what was reserved is being used{kv < 0.25 ? ", and at this level a smaller num_ctx would reclaim most of it" : ""}. It survives the request that filled it, so an idle model still says what its last task left behind.</span> : null}
                </span>
            ) : null}
            {/* WHAT IT SHOULD DECODE AT, where it is placed now (`expected_decode`): a PREDICTION from the box's measured
                profile, corrected by this model's own runs once it has enough — so it covers a mixture of experts,
                where the roofline is withheld. Worded by its basis (`expectedPhrase`), and drawn only when there IS a
                figure: an unavailable reason on every row would be noise, since a spilled model is ordinary. The
                measured rate sits on the cost line below, so the two can be read against each other. */}
            {(() => {
                const ed = expectedDecodeFrom(m.expectedDecode);
                if (!ed || "unavailable" in ed) return null;
                const ph = expectedPhrase(ed);
                return (
                    <span class={`${tips ? "tt " : ""}vram-expect${ph.quiet ? " quiet" : ""}`} {...yieldTip}>{ph.text}
                        {tips ? <span class="tt-pop left above" role="tooltip">{ph.tip}</span> : null}
                    </span>
                );
            })()}
            {/* THE HOST-RAM PROMPT CACHE: conversations parked in system RAM while another has the model's one
                slot. It is where a second conversation on the same model lives between turns, and filling it is
                the precondition for the thrash — two conversations that do not fit, each evicting the one about
                to be needed — so it turns to a warning near its limit. RAM, never VRAM, and per model. */}
            {act?.promptCache ? (() => {
                const pc = act.promptCache;
                const full = pc.limitBytes ? pc.bytes / pc.limitBytes : null;
                return (
                    <span class={`${tips ? "tt " : ""}vram-pcache${full != null && full >= 0.9 ? " warn" : ""}`} {...yieldTip}>
                        {formatBytes(pc.bytes)}{pc.limitBytes ? ` / ${formatBytes(pc.limitBytes)}` : ""} RAM cache
                        {tips ? <span class="tt-pop left above" role="tooltip">{pc.entries} {pc.entries === 1 ? "conversation" : "conversations"} ({pc.tokens.toLocaleString()} tokens) parked in SYSTEM RAM while another has this model's slot, so switching back reads them in instead of recomputing them.{pc.limitBytes ? <> The cache holds up to {formatBytes(pc.limitBytes)} for this model; past that, saving one conversation evicts another, and when two take turns each evicts the one about to be needed — every turn then pays a full prefill plus the copy.</> : null}</span> : null}
                    </span>
                );
            })() : null}
            {/* WHAT THE RUNNER IS DOING, when it is doing something. Kept apart from the TTL chip beside it
                rather than folded into its "in use": they are different facts and they can disagree — measured
                on the box, a request in flight while the slot had not started reads `busy: true, phase: idle`.
                Never drawn for `idle`, which would put a permanent chip on every row to say nothing. */}
            {act && act.phase !== "idle" ? (
                <span class={tips ? "tt vram-phase" : "vram-phase"} {...yieldTip}>{act.phase}
                    {tips ? <span class="tt-pop left above" role="tooltip">{act.phase === "prefill"
                        ? <>Reading the prompt — {act.promptTokensDone?.toLocaleString() ?? "?"} of {act.promptTokens?.toLocaleString() ?? "?"} tokens so far{act.promptTokensCached ? <>, with {act.promptTokensCached.toLocaleString()} of them served from the prefix cache and never computed</> : null}. No tokens are being generated yet.</>
                        : <>Generating — {act.decoded?.toLocaleString() ?? "?"} tokens so far{act.promptTokensCached ? <>, after a prompt whose {act.promptTokensCached.toLocaleString()} cached tokens meant there was almost nothing to read</> : null}. Each one lands in the KV cache, which is why the occupancy beside this is climbing.</>}</span> : null}
                </span>
            ) : null}
            {ttl ? (
                <span class={`${tips ? "tt " : ""}vram-ttl${m.busy ? " busy" : ""}`} {...yieldTip}>{ttl}
                    {tips ? <span class="tt-pop left above" role="tooltip">{m.busy
                        ? <>Serving a request right now, so the keep-alive countdown is HELD. Ollama rewrites the deadline when the request finishes, which is why counting down during a generation would run past zero on a long one. The clock restarts, from full, once it is idle.</>
                        : ttl === "pinned"
                            ? <>Loaded to STAY — <code>keep_alive: -1</code>, so Ollama will not evict it on a timer and it holds this memory until something unloads it or needs the room. (The server does report a deadline, about a century out; counting down to it would be true and useless.)</>
                            : <>Keep-alive TTL — Ollama evicts this model from {m.vramBytes ? "VRAM" : "memory"} when the countdown reaches zero (expires {new Date(m.expiresAt!).toLocaleTimeString()}). Each use resets it. Set <code>keep_alive</code> to change how long it lingers.</>}</span> : null}
                </span>
            ) : null}
        </>
    );
}

/** True while the pointer is over a badge inside the row that has its OWN tooltip (the context window, the
 *  keep-alive TTL). Two tooltips for one pointer is never right — the specific one wins, and the row's
 *  follower steps aside rather than overlapping it. */
export const rowTipSuppressed = signal(false);

// The Ollama EVENT STREAM (`GET /api/events`, patched server only) — frame model and reader.
//
// Polling `/api/ps` cannot see a load at all: the runner object is constructed only after the load
// RETURNS, so for 44 seconds of a 45-second load there is genuinely nothing in the server to observe
// (measured on the box: `load.start` at t=4102, `load.complete` at t=48053, `/api/ps` empty across the
// whole span). Every load span the panel drew was therefore inferred from the `load_duration` of
// whichever request happened to be waiting, and an eviction was inferred by diffing two polls. This
// stream reports both as EDGES, from the scheduler's own transitions.
//
// Wire format is NDJSON (`application/x-ndjson`), one frame per line. Nothing here touches chrome or
// the network: `sw-events.ts` owns the connection, this owns what a frame MEANS.
import type { LoadedModel } from "./contract";

/** A frame's `kind`. The union is open in practice — an unrecognised kind is IGNORED rather than
 *  treated as an error, so a newer server can add one without breaking an older client. */
export type FrameKind =
    | "hello" | "heartbeat" | "sample"
    | "load.start" | "load.complete" | "load.failed"
    | "evict" | "unload" | "expires";

/** One line off the stream. `t` is milliseconds from THIS connection's `hello`, and is NEGATIVE for a
 *  backfilled frame — it happened before the connection opened, and saying so beats restamping it as
 *  though it had not. */
export interface ResourceFrame {
    v?: number;
    kind: FrameKind | string;
    t: number;
    /** hello: how far back the retained ring actually reaches, capped at the server's window. Ask for more
     *  than this and the number is telling you your record has a gap. */
    retainedMs?: number;
    /** hello: how many frames the replay ACTUALLY delivered. Deliberately present as `0` rather than
     *  omitted, so a client can read zero as a fact — it is the difference between "the ring was empty"
     *  and "the query string never arrived", which is a real bug that has happened on this route. */
    backfilled?: number | null;
    /** The server's own clock at `hello`, and a stable id for the box. */
    serverTime?: string;
    box?: string;
    /** hello: GPUs the server can see and cannot use (`compute.unavailable_gpus` in the same shape). It rides
     *  the HELLO rather than an edge event on purpose — a card can fault hours before anything connects, and
     *  an edge-only signal is silent in exactly that case. Read it on every connect. */
    unavailable_gpus?: unknown;
    /** Cumulative frames dropped for THIS subscriber, when it stopped reading fast enough. Non-zero means
     *  a hole in the record, which is a different thing from a quiet period. */
    dropped?: number;
    /** sample: the verbatim `/api/ps` and `/api/info` bodies, so one parser serves both transports. */
    ps?: { models?: unknown[] } | null;
    info?: unknown;
    /** The model an edge frame is about. */
    model?: string;
    /** evict: why. Ordinary keep-alive expiry is `unload`; `evict` is the OOM-retry path. */
    reason?: string;
    /** expires: the new keep-alive deadline, written when a request FINISHES. */
    expires_at?: string;
}

/** Parse one NDJSON line. Returns null for a blank line, for malformed JSON, and for anything that is not
 *  shaped like a frame — an unreadable line must never abandon the rest of the stream. */
export function parseFrame(line: string): ResourceFrame | null {
    const s = line.trim();
    if (!s) return null;
    try {
        const o = JSON.parse(s);
        if (!o || typeof o !== "object" || typeof o.kind !== "string") return null;
        return { ...o, t: Number(o.t) || 0 } as ResourceFrame;
    } catch { return null; }
}

/** Feed a decoded chunk in, get whole frames out plus the partial trailing line to carry into the next
 *  call. A frame split across two network reads is the failure that only shows up on a slow link, which
 *  is exactly where a memory panel is most worth having. */
export function readFrames(buffer: string, chunk: string): { frames: ResourceFrame[]; rest: string } {
    const text = buffer + chunk;
    const parts = text.split("\n");
    const rest = parts.pop() ?? "";       // the last piece has no newline yet: it may be half a frame
    const frames: ResourceFrame[] = [];
    for (const line of parts) {
        const f = parseFrame(line);
        if (f) frames.push(f);
    }
    return { frames, rest };
}

/** Wall clock for a frame, from the local instant its connection's `hello` arrived. Offsets are relative
 *  to that hello and go NEGATIVE for backfill, so this is the only place the two clocks meet — every
 *  consumer downstream works in ordinary epoch milliseconds. */
export function frameTime(helloAt: number, frame: ResourceFrame): number {
    return helloAt + frame.t;
}

/** How much history to ask a reconnect for. `?since=` is a DURATION, not an offset: each connection
 *  anchors on its own hello, so an offset taken from the previous one means nothing to this one.
 *
 *  Asking for the gap alone would be wrong at the seam — a frame that arrived while we were dropping the
 *  connection would fall between the two windows — so it is padded, and reading a frame twice is harmless
 *  where missing one is not. A first connection asks for the ring's whole depth: on a fresh open that is
 *  history the panel would otherwise have to spend ten minutes re-measuring. */
export function sinceFor(lastFrameAt: number | null, now: number, ringMs = 600_000): number {
    if (!lastFrameAt) return ringMs;
    return Math.min(ringMs, Math.max(0, now - lastFrameAt) + 5_000);
}

/** An ollama `/api/ps` row → the `LoadedModel` the rest of the extension speaks. Shared by the polled
 *  route and by a `sample` frame's embedded body, which is the whole point of the server embedding it
 *  verbatim: two transports, one parser, and no way for them to disagree about what a model IS. */
export function loadedFrom(rows: unknown[]): LoadedModel[] {
    return (rows || []).map((raw) => {
        const m = raw as Record<string, any>;
        return {
            model: m.model || m.name,
            vramGB: m.size_vram ? +(m.size_vram / 1e9).toFixed(1) : null,
            sizeGB: m.size ? +(m.size / 1e9).toFixed(1) : null,
            // EXACT bytes alongside the rounded GB: the resource panel's bands subtract these from exact
            // capacity figures, so rounding here would accumulate into visibly wrong sums.
            vramBytes: typeof m.size_vram === "number" ? m.size_vram : null,
            sizeBytes: typeof m.size === "number" ? m.size : null,
            // Which devices it occupies. `gpus` is ABSENT for a CPU-resident model — the server's way of
            // saying so — and that absence is preserved here rather than normalised to an empty array.
            ...(Array.isArray(m.gpus) ? { gpus: m.gpus.map((g: any) => ({
                id: String(g.gpu_id ?? ""), runner: String(g.runner ?? ""), vramBytes: Number(g.size_vram) || 0,
                ...(g.memory ? { memory: g.memory } : {}),
            })) } : {}),
            // The context window it was loaded with. Ollama preallocates KV cache for the FULL window, so
            // this explains a big share of size_vram. Older servers don't report it → null, and the UI hides it.
            contextLength: typeof m.context_length === "number" ? m.context_length : null,
            // WHAT the VRAM holds, carried RAW and parsed once downstream (`residencyOf` → `memorySplit`),
            // so the sum invariant is checked in one place rather than by each consumer that reads it.
            ...(m.memory ? { memory: m.memory } : {}),
            ...(m.memory_host ? { memoryHost: m.memory_host } : {}),
            ...(typeof m.weights_on_disk === "number" ? { weightsOnDisk: m.weights_on_disk } : {}),
            // WHICH LAYERS WENT WHERE, raw and parsed once downstream like `memory`. Opt-in on the server
            // (`OLLAMA_LAYER_PLACEMENT=1`) and absent by default, so this is another "missing means not
            // reported", never "no layers".
            ...(m.placement ? { placement: m.placement } : {}),
            // A LOADING entry carries its name and zeros for everything else, so its `expires_at` is Go's
            // zero time — a deadline in year 1, which renders as a countdown of minus two thousand years.
            expiresAt: (m.state === "loading" ? null : m.expires_at) || null,
            // Both need a patched Ollama; absent means "not known", never "idle" / "resident".
            ...(typeof m.busy === "boolean" ? { busy: m.busy } : {}),
            ...(m.state ? { state: String(m.state) } : {}),
            // What the runner is DOING, raw and parsed once downstream (`activityFrom`) like `memory` and
            // `placement`. Absent on every server that cannot ask its runner, which is not the same as idle.
            ...(m.activity ? { activity: m.activity } : {}),
            // The decode ceiling for THIS placement, raw like `activity`, parsed once by `rooflineFrom`.
            ...(m.roofline ? { roofline: m.roofline } : {}),
            // Which build: a `loading` row sends every one of these as "", which is "not reported" rather
            // than a model with no quantization, so empty stays absent.
            ...(m.details?.quantization_level ? { quant: String(m.details.quantization_level) } : {}),
            ...(m.details?.parameter_size ? { paramSize: String(m.details.parameter_size) } : {}),
            ...(m.details?.family ? { family: String(m.details.family) } : {}),
        };
    });
}

/** How many frames THIS connection lost since the frame we last read, from the cumulative `dropped` counter.
 *
 *  Three things about that counter decide the arithmetic, and getting any of them wrong turns a real hole into
 *  a silent one. It is CUMULATIVE, so the news is the DELTA and not the value — a connection that dropped
 *  frames once reports the same non-zero number forever after, and reading the value would break the trace at
 *  every subsequent frame. It is PER SUBSCRIBER, so a reconnect starts a new count from zero: `hello` resets
 *  rather than reading as a recovery, and the gap across the reconnect itself is covered by the backfill
 *  `sinceFor` asks for. And a counter that goes BACKWARDS mid-stream is a server we did not see restart —
 *  claiming a loss there would be inventing a number, so it resets and says nothing.
 *
 *  A non-zero `lost` means the record has a hole, which is the same claim a sampling gap makes and must be
 *  drawn the same way: `segments()` breaks the line rather than interpolating across frames that never
 *  arrived. Dropping frames is exactly when memory is moving fastest, so a line drawn across one is confidently
 *  wrong about the interval it is least entitled to speak for. */
export function lostSince(prev: number, frame: ResourceFrame): { lost: number; seen: number } {
    const now = typeof frame.dropped === "number" && frame.dropped >= 0 ? Math.floor(frame.dropped) : prev;
    if (frame.kind === "hello") return { lost: 0, seen: now };
    if (now < prev) return { lost: 0, seen: now };
    return { lost: now - prev, seen: now };
}

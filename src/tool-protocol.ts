/**
 * @file The tool-execution protocol — how a tool that runs somewhere other than this browser reports what
 * it is doing while it does it, and how long it actually spent.
 *
 * TWO SEPARATE THINGS live here, and keeping them separate is the point.
 *
 * 1. {@link TOOL_TIMING_META_KEY} is a PUBLISHED MCP EXTENSION: one `_meta` key that anyone can implement,
 *    documented here because MCP's own rules say a third-party extension uses its vendor prefix and is
 *    "specified in the extension's documentation". It is deliberately not a fork of MCP's schema — that
 *    would be a large surface we do not control, going stale on every revision, published as something
 *    that looks like MCP and is not.
 *
 * 2. {@link ToolFrame} is OUR NORMALIZED MODEL, not a protocol. Every source of remote tool execution is
 *    adapted into it: MCP notifications, OpenWebUI's `/execute` NDJSON (whose wire format already matches),
 *    and whatever a local container over IPC ends up speaking. It is typed and schema-generated so a
 *    consumer gets real models, but it is NOT advertised as a wire format to implement — inventing a rival
 *    to MCP is the mistake this shape exists to avoid.
 *
 * WHAT A SCHEMA CANNOT PIN. `docs/spec/tool-protocol.schema.json` describes frame SHAPES. It cannot
 * express that a `result` frame is last and mandatory, that `output` frames are deltas rather than
 * accumulated text, or that a closed connection means cancel. Those are in
 * `docs/spec/REMOTE_TOOL_EXECUTION.md` and they are as normative as anything here.
 *
 * Types erased at build; import with `import type` where only the types are wanted.
 */

/** Bumped only on a BREAKING change. Adding an optional field is not breaking. */
export const TOOL_PROTOCOL_VERSION = 1;

/* ----------------------------- the MCP extension ----------------------------- */

/**
 * The `_meta` key carrying {@link ToolTiming}, on the RESULT of an MCP `tools/call`.
 *
 * MCP `_meta` keys are an optional reverse-DNS prefix followed by a name, and any prefix whose SECOND
 * label is `modelcontextprotocol` or `mcp` is reserved for MCP itself — so a vendor key under our own
 * domain is exactly what the mechanism is for.
 */
export const TOOL_TIMING_META_KEY = "dev.wander.windowml/timing";

/**
 * How long a remote executor spent, reported by the executor itself.
 *
 * The reason this has to exist: a client measures a remote call with its own wall clock, which contains
 * the network and whatever the far end was doing before it started. That total is not attributable — nine
 * seconds could be a slow tool or a busy box, and no amount of client-side measurement separates them.
 *
 * Settled ground for model calls, which is why the shape mirrors them: Ollama reports `eval_duration`
 * beside our wall clock, and `prompt_eval_duration` had to be added later because without it "wall minus
 * generation" silently charged the box for the model reading its own prompt.
 *
 * ABSENT MEANS UNKNOWN, never instant. A server that cannot measure a field omits it; a zero asserts a
 * measurement. A conforming MCP client ignores an unrecognised `_meta` key, so a server that never
 * implements this degrades to a span whose composition is unknown — reported as unknown.
 */
export interface ToolTiming {
    /** Time spent EVALUATING the tool, excluding transport. Subtract it from a client's own wall
     *  measurement to get the network plus the far end's overhead. */
    durationMs: number;
    /** Elapsed time before evaluation began: scheduling, access checks, a module import, a downstream
     *  connect. Real elapsed time that is not work, drawn the way a model load is drawn. */
    queuedMs?: number;
}

/* ----------------------------- the normalized frames ----------------------------- */

/**
 * One frame of a streaming tool execution.
 *
 * @unstable New frame kinds may appear — this is a normalization over sources that do not all exist yet,
 * and the next one will bring something these three do not express. Switch on `type` and ignore what you
 * do not recognise; a client that knows only `output` and `result` loses nothing it could have used.
 */
export type ToolFrame = ToolOutputFrame | ToolEventFrame | ToolResultFrame;

/**
 * Text the tool produced, as a DELTA rather than the accumulated total. The client appends, so a dropped
 * connection loses the tail rather than corrupting what already arrived.
 *
 * Human-facing: it drives the live output cell. What the MODEL receives is the tool's returned result, in
 * {@link ToolResultFrame.result} — the loop's stream fan feeds the debug event stream and nothing else.
 * That is why a prose status line belongs here even though it is not really "output": there is no context
 * cost to weigh against showing it.
 */
export interface ToolOutputFrame {
    type: "output";
    text: string;
    /**
     * When the producer emitted this, as an OFFSET IN MS FROM THE START OF EVALUATION — never an epoch
     * timestamp.
     *
     * This is the one place the local design does not transfer. A local producer shares our clock, so
     * `ctx.stream` takes an absolute stamp and the UI renders it; a remote host's clock is not the user's,
     * and a gutter rendering a host skewed by a few seconds would show output that arrived before it was
     * requested. See {@link anchorOffset} for how a client converts these.
     */
    atMs?: number;
}

/**
 * Something structural the executor reported that is not text: a progress counter, an attached file, a
 * citation. Forwarded VERBATIM, with no text derived from it.
 *
 * Deriving text is what makes this necessary rather than convenient — the payloads are inconsistent by
 * nature (one carries a description, another a body, another only structure), so a rule that extracts
 * text silently drops the ones that have none.
 *
 * Progress belongs here rather than in {@link ToolOutputFrame}, and the reason is a rendering property
 * rather than a context-budget one: `progress` is a monotonic counter whose message labels a bar, so
 * appended as deltas it renders "step 1step 2step 3" — each conceptually replacing the last while
 * literally accumulating. A log line is a line and concatenates correctly.
 */
export interface ToolEventFrame {
    type: "event";
    /** The source's own payload, whatever shape it has. Opaque by design. */
    event: Record<string, unknown>;
    /** As {@link ToolOutputFrame.atMs}. */
    atMs?: number;
}

/**
 * The last frame, and mandatory even on failure. A stream that ends without one is a TRANSPORT FAILURE and
 * must not reach the model as a tool that returned nothing — that is a wrong answer dressed as an empty
 * one, and the model has no way to tell the difference.
 */
export interface ToolResultFrame {
    type: "result";
    /** The tool's return value. Present unless {@link ToolResultFrame.error} is; never both. */
    result?: unknown;
    /**
     * A string the model can read, INSTEAD of a result. A tool that fails is a normal step outcome the
     * model reads and reacts to — distinct from a transport failure, which is not something it can act on.
     */
    error?: string;
    /** Which callable this was, where the source names one. */
    name?: string;
    /** Time spent evaluating — see {@link ToolTiming}. */
    durationMs?: number;
    /** Elapsed before evaluation began — see {@link ToolTiming}. */
    queuedMs?: number;
    /** Characters dropped when the executor capped its output. Absent when nothing was. */
    truncated?: number;
}

/* ----------------------------- offsets to local time ----------------------------- */

/**
 * Turn a remote frame's `atMs` offset into a local epoch timestamp.
 *
 * The anchor is the FIRST frame's local arrival minus its own offset, so every later frame is placed
 * relative to the same origin. Shared rather than reimplemented per adapter, because two adapters that
 * each invent an anchoring rule is precisely the drift a normalized model exists to prevent.
 *
 * The residual error is one-way network latency, which cannot be measured from one side. Bounded and
 * acknowledged — the alternative, stamping on arrival, silently attributes the transport to the tool and
 * makes every line look later than it was.
 *
 * @param anchor the local epoch ms this stream is anchored at, from {@link anchorFor}
 * @param atMs the frame's offset, if it carried one
 * @param arrivedAt local epoch ms this frame arrived — used when the frame carries no offset
 */
export function anchorOffset(anchor: number | null, atMs: number | undefined, arrivedAt: number): number {
    // No anchor yet, or a frame with no offset: arrival is the only honest answer available.
    if (anchor == null || atMs == null || !Number.isFinite(atMs)) return arrivedAt;
    return anchor + atMs;
}

/**
 * The anchor for a stream, from its first frame that carries an offset.
 *
 * Returns null until one does, so a stream whose opening frames are unstamped does not fix an anchor on a
 * guess and then place everything after it wrongly.
 */
export function anchorFor(atMs: number | undefined, arrivedAt: number): number | null {
    if (atMs == null || !Number.isFinite(atMs)) return null;
    return arrivedAt - atMs;
}


/* ----------------------------- reading a stream ----------------------------- */

/**
 * One NDJSON line to a frame, or null for anything that is not one.
 *
 * Null rather than throwing, for blank lines, keep-alives and whatever a proxy inserts: a stream is a
 * sequence of independent lines and one unreadable line is not a reason to abandon the ones after it.
 * A line that parses but is not a frame we know is also null — the union is `@unstable`, so an unfamiliar
 * `type` is a version skew rather than corruption.
 */
export function parseFrame(line: string): ToolFrame | null {
    const t = line.trim();
    if (!t) return null;
    let obj: unknown;
    try { obj = JSON.parse(t); } catch { return null; }
    if (!obj || typeof obj !== "object") return null;
    const f = obj as { type?: unknown };
    if (f.type === "output" || f.type === "event" || f.type === "result") return obj as ToolFrame;
    return null;
}

/** What a stream has produced so far. */
export interface ToolStreamState {
    /** Every `output` delta, appended in order. */
    output: string;
    /** `[offset in output, epoch ms]` per chunk, as the rest of the codebase spells stream timings. Only
     *  chunks whose producer stamped an offset get a mark; the UI never invents one for the rest. */
    marks: [number, number][];
    /** Structural frames, in order. Deliberately kept apart from `output`: they are not text, and folding
     *  them in is how UI plumbing ends up in something a model reads. */
    events: ToolEventFrame[];
    /** The terminal frame, once it arrives. */
    result?: ToolResultFrame;
}

/** How a stream ended. A `result` frame is the only successful ending. */
export type ToolStreamEnd =
    | { ok: true; result: ToolResultFrame; state: ToolStreamState }
    | { ok: false; transportError: string; state: ToolStreamState };

/**
 * Fold an NDJSON tool stream into output, marks, events and a result.
 *
 * Stateful because it has to be: chunks arrive split at arbitrary byte boundaries, offsets are anchored
 * against the first stamped frame, and marks are positions in text that is still growing. Shared rather
 * than written per adapter — the OpenWebUI reader and an MCP one differ in where frames come FROM, and
 * agreeing on what a stream MEANS is the whole point of the frame model.
 *
 * @param onFrame called for each frame as it completes, for a caller streaming live
 */
export function createToolStream(onFrame?: (frame: ToolFrame, at: number) => void) {
    const state: ToolStreamState = { output: "", marks: [], events: [] };
    let buffer = "";
    let anchor: number | null = null;
    let ended = false;

    const take = (frame: ToolFrame, arrivedAt: number): void => {
        if (frame.type === "result") { state.result = frame; ended = true; onFrame?.(frame, arrivedAt); return; }
        // The first stamped frame fixes the origin every later offset is measured against.
        if (anchor == null) anchor = anchorFor(frame.atMs, arrivedAt);
        const at = anchorOffset(anchor, frame.atMs, arrivedAt);
        if (frame.type === "event") { state.events.push(frame); onFrame?.(frame, at); return; }
        // A mark only where the producer actually stamped one: an offset nobody reported is not a time.
        if (frame.atMs != null && Number.isFinite(frame.atMs)) state.marks.push([state.output.length, at]);
        state.output += frame.text;
        onFrame?.(frame, at);
    };

    return {
        /**
         * Feed a chunk of the response body. Buffers a partial trailing line, so a frame split across two
         * network reads is not lost — the failure this exists to prevent, and one that only shows up under
         * load or on a slow link.
         *
         * @returns the frames completed by this chunk
         */
        push(chunk: string, arrivedAt: number = Date.now()): ToolFrame[] {
            buffer += chunk;
            const out: ToolFrame[] = [];
            let nl: number;
            while ((nl = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, nl);
                buffer = buffer.slice(nl + 1);
                const frame = parseFrame(line);
                if (frame) { take(frame, arrivedAt); out.push(frame); }
            }
            return out;
        },
        /**
         * The stream is over. A trailing line with no newline is still a frame — a server that ends without
         * one is not malformed, and dropping its `result` would turn a completed call into a transport
         * failure.
         *
         * A stream that ends with no `result` frame IS a transport failure, and says so rather than
         * returning what it collected. Reporting the partial output as a tool that returned nothing is a
         * wrong answer dressed as an empty one, and the model has no way to tell the difference.
         */
        end(arrivedAt: number = Date.now()): ToolStreamEnd {
            const tail = parseFrame(buffer);
            buffer = "";
            if (tail) take(tail, arrivedAt);
            if (state.result) return { ok: true, result: state.result, state };
            return {
                ok: false,
                transportError: ended
                    ? "the tool stream ended after its result frame in an unreadable state"
                    : `the tool stream ended without a result frame after ${state.output.length} characters of output`,
                state,
            };
        },
        state: () => state,
    };
}

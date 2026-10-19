// ml-wire-serve.ts — answering one `ml` call that arrived as a message: the clients, the checks, the copy out, the ask.

// The worker-free half of the wire (docs/spec/ML_WIRE.md), so its rules are tested without a worker: which client may
// call what is decided by the MEMBERS it is handed (sw-ml-wire.ts builds them per realm), and this file guarantees what
// crosses back. An answer is rebuilt from own data properties into fresh plain objects, so nothing the member returned
// (a function, a proxy, a class instance, a getter) reaches the client: only its data does.

import type { MlWireAnswer, MlWireErrorCode, MlWirePointer, MlWireRequest, WireRealm } from "../contract";

/** A per-call decision on a gated member: run it, refuse it, or ask the person and wait for `decided`. */
export type WireGateDecision = { allow: true } | { deny: string } | { ask: string; decided: Promise<boolean> };

/** One member a client may call: its function over the copied arguments, and, for a gated member, the gate. */
export interface WireMember {
    run: (...args: unknown[]) => unknown;
    gate?: (args: readonly unknown[]) => Promise<WireGateDecision>;
}

/** What a member returns to answer with a pointer instead of a value: built by {@link wirePointer}. */
const POINTER = Symbol("wire pointer");

/**
 * Mark a member's result as a pointer: the value stays in the run's store, and the client gets its token.
 * @param p the token, its label and its size in bytes
 * @returns the marker {@link serveWireCall} answers as `pointer`
 */
export function wirePointer(p: MlWirePointer): unknown {
    return { [POINTER]: { token: String(p.token), label: String(p.label), size: Number(p.size) || 0 } };
}

/** Thrown by a member to answer with a specific error code rather than `Failed`. */
export class WireError extends Error {
    readonly code: MlWireErrorCode;
    constructor(code: MlWireErrorCode, message: string) { super(message); this.code = code; }
}

/** How long a call waits on the person before it fails: the dialect's step budget does not run while it waits, so this
 *  wall-clock cap is what ends a card nobody answers (docs/spec/ML_WIRE.md, "Per-call asking"). Five minutes. */
export const ASK_TIMEOUT_MS = 5 * 60_000;

/** How deep a value may nest before it is refused rather than copied. */
const MAX_DEPTH = 64;

/** Set an OWN data property, whatever the key: `out[k] = …` would run the `__proto__` setter for `k === "__proto__"`,
 *  dropping the key and swapping the copy's prototype for the value. */
const defineOwn = (out: Record<string, unknown>, k: string, value: unknown): void => {
    Object.defineProperty(out, k, { value, enumerable: true, writable: true, configurable: true });
};

/** A tag is a single-key object whose key starts with `$` (ML_WIRE.md, "What crosses"). */
const isTagShaped = (o: Record<string, unknown>): boolean => {
    const keys = Object.keys(o);
    return keys.length === 1 && keys[0].startsWith("$");
};

/**
 * Unwrap the one level of `{ "$": <object> }` a tag-shaped data value crossed wrapped as, recursively through
 * arrays and objects. Tags proper (`$bytes`, `$secret`) are left as they are: they are the encoding, not data.
 * @param v the value as it arrived on the wire
 * @returns the unwrapped copy
 */
export function fromWire(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(fromWire);
    if (v && typeof v === "object") {
        const o = v as Record<string, unknown>;
        const keys = Object.keys(o);
        // Exactly one level: the wrapped object's own contents are unwrapped, but the object itself is DATA, so
        // `{"$": {"$": 1}}` is the data `{"$": 1}` and `{"$": {"$secret": "s"}}` is a dict, never a handle.
        if (keys.length === 1 && keys[0] === "$") {
            const inner = o.$;
            if (inner && typeof inner === "object" && !Array.isArray(inner)) {
                const out: Record<string, unknown> = {};
                for (const k of Object.keys(inner)) defineOwn(out, k, fromWire((inner as Record<string, unknown>)[k]));
                return out;
            }
            return fromWire(inner);
        }
        const out: Record<string, unknown> = {};
        for (const k of keys) defineOwn(out, k, fromWire(o[k]));
        return out;
    }
    return v;
}

/**
 * A fresh plain-data copy of `v`: JSON values, arrays and objects from OWN enumerable data properties, bytes as
 * `{ $bytes: base64 }`. A function, a symbol, a bigint, an accessor, a cycle or a class instance is refused, so the copy
 * is never a live object and never a proxy, whatever `v` was.
 *
 * TAG WRAPPING (ML_WIRE.md, "What crosses"): a plain object whose copy is tag-shaped (one key starting with `$`)
 * crosses wrapped as `{ "$": <object> }`, so the receiver's unwrap returns exactly the data and a value that
 * looks like a tag is never read as one. Bytes are the exception: they ARE the `$bytes` tag, not data.
 * @param v the value
 * @param depth how deep the copy already is
 * @param seen the objects on the current path, for cycles
 * @param wrap false for a value ALREADY in wire form (a cell's arguments): copied and checked, never wrapped a second time
 * @returns the copy
 */
export function toWire(v: unknown, depth = 0, seen: Set<object> = new Set(), wrap = true): unknown {
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (v === undefined) return null;
    if (typeof v !== "object") throw new WireError("Failed", `a ${typeof v} cannot cross the wire`);
    if (depth > MAX_DEPTH) throw new WireError("Failed", "the value nests too deeply to cross the wire");
    if (seen.has(v)) throw new WireError("Failed", "the value is cyclic and cannot cross the wire");
    // Kinds are read STRUCTURALLY, never by `instanceof`: a value from another realm (a vm context, a frame) is still
    // an array or a plain object, and a class can be named anything.
    const tag = Object.prototype.toString.call(v);
    if (tag === "[object ArrayBuffer]" || ArrayBuffer.isView(v)) {
        const bytes = ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(v as ArrayBuffer);
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return { $bytes: btoa(bin) };
    }
    seen.add(v);
    try {
        if (Array.isArray(v)) {
            const out: unknown[] = [];
            for (let i = 0; i < v.length; i++) {
                const d = Object.getOwnPropertyDescriptor(v, i);
                if (d && !("value" in d)) throw new WireError("Failed", "an accessor cannot cross the wire");
                out.push(toWire(d?.value, depth + 1, seen, wrap));
            }
            return out;
        }
        // A plain object's prototype is null or SOME realm's Object.prototype (whose own prototype is null); a class
        // instance's is its class's.
        const proto = Object.getPrototypeOf(v);
        if (proto !== null && (Object.getPrototypeOf(proto) !== null || tag !== "[object Object]")) throw new WireError("Failed", `a ${proto?.constructor?.name || "class"} instance cannot cross the wire`);
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(v)) {
            const d = Object.getOwnPropertyDescriptor(v, k)!;
            if (!("value" in d)) throw new WireError("Failed", "an accessor cannot cross the wire");
            if (d.value === undefined || typeof d.value === "function") {
                if (typeof d.value === "function") throw new WireError("Failed", "a function cannot cross the wire");
                continue;
            }
            defineOwn(out, k, toWire(d.value, depth + 1, seen, wrap));
        }
        // Data that looks like a tag crosses wrapped one level (ML_WIRE.md). `{ "$": … }` itself is the wrap, not data.
        return wrap && isTagShaped(out) ? { $: out } : out;
    } finally {
        seen.delete(v);
    }
}

/**
 * The objects in WIRE-FORM `v` that are secret handles: an own `$secret` key (docs/spec/SECRET_HANDLES.md), at any
 * depth, with ONE exemption: the object directly inside a `{ "$": {…} }` wrap that is not itself within a wrap's
 * contents. That object is a tag-shaped dict the facade wrapped one level, which {@link fromWire} unwraps to data.
 * Within a wrap's contents nothing is exempt, nested wraps included: a handle is never data, so data that nests
 * tag-shaped dicts inside each other is refused (fail closed) rather than risk passing a handle on as one.
 * @param v the value as it arrived on the wire, before {@link fromWire}; a {@link toWire} copy, so a finite tree
 * @param inWrap whether `v` lies within a wrap's contents
 * @returns each handle object, in encounter order
 */
function handlesIn(v: unknown, inWrap = false, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
    if (!v || typeof v !== "object") return out;
    if (Array.isArray(v)) { for (const x of v) handlesIn(x, inWrap, out); return out; }
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (!inWrap && keys.length === 1 && keys[0] === "$" && o.$ && typeof o.$ === "object" && !Array.isArray(o.$)) {
        for (const x of Object.values(o.$)) handlesIn(x, true, out);
        return out;
    }
    if (Object.prototype.hasOwnProperty.call(o, "$secret")) out.push(o);
    for (const x of Object.values(o)) handlesIn(x, inWrap, out);
    return out;
}

/** An error answer, with its text through `scrub` (the server URL, the key and the model filter never cross). */
async function fail(seq: number, code: MlWireErrorCode, message: string, scrub: (s: string) => Promise<string>): Promise<MlWireAnswer> {
    return { seq, error: { code, message: await scrub(message) } };
}

/** Run a member and turn its result, or its throw, into the answer. */
async function answerOf(seq: number, name: string, member: WireMember, args: unknown[], scrub: (s: string) => Promise<string>): Promise<MlWireAnswer> {
    let result: unknown;
    try {
        result = await member.run(...args);
    } catch (e) {
        if (e instanceof WireError) return fail(seq, e.code, e.message, scrub);
        return fail(seq, "Failed", `ml.${name}: ${(e as Error)?.message || String(e)}`, scrub);
    }
    const p = result && typeof result === "object" ? (result as { [POINTER]?: MlWirePointer })[POINTER] : undefined;
    if (p) return { seq, pointer: { ...p } };
    try {
        return { seq, value: toWire(result) };
    } catch (e) {
        return fail(seq, (e as WireError).code ?? "Failed", `ml.${name}: ${(e as Error).message}`, scrub);
    }
}

/** How a call is answered: the members this client may call, the run it is bound to, and where later answers go. */
export interface WireServeContext {
    /** The run the client was opened for, or null for a client with none. */
    run: string | null;
    /** The members of the client's realm, by name. A name not here is ABSENT. */
    members: Readonly<Record<string, WireMember>>;
    /** The final answer to a call that answered `ask` first. */
    later: (answer: MlWireAnswer) => void;
    /** Whether the client is still open: a call that waited on the person runs only if it is when they decide. */
    isOpen: () => boolean;
    /** How long a card may wait unanswered before the call fails (not the script). Default {@link ASK_TIMEOUT_MS}. */
    askTimeoutMs?: number;
    /** Scrub an error's text before it crosses (sw-scrub.ts `forPage` in the worker). */
    scrub: (text: string) => Promise<string>;
}

/**
 * Answer one wire request for a client the caller has already verified by its sender and handle.
 * @param req the request as it arrived
 * @param ctx the client's run, members, later channel and scrubber
 * @returns the first answer; for `ask`, the final one goes to `ctx.later`
 */
export async function serveWireCall(req: Partial<MlWireRequest> | null | undefined, ctx: WireServeContext): Promise<MlWireAnswer> {
    const seq = typeof req?.seq === "number" && Number.isSafeInteger(req.seq) && req.seq >= 0 ? req.seq : -1;
    if (seq < 0 || typeof req?.call !== "string" || !Array.isArray(req.args)) return fail(Math.max(seq, 0), "BadRequest", "an ml call needs a seq, a call name and an args array", ctx.scrub);
    // The run id is not authority: it must be the client's own, and a different one gets nothing, not even whether it exists.
    if ((req.run ?? null) !== ctx.run) return fail(seq, "Refused", "this client cannot call ml for that run", ctx.scrub);
    const name = req.call;
    if (!Object.prototype.hasOwnProperty.call(ctx.members, name)) {
        const have = Object.keys(ctx.members);
        return fail(seq, "Absent", `ml.${name} is not available here${have.length ? `: this code has ml.${have.join(", ml.")}` : ""}`, ctx.scrub);
    }
    let args: unknown[];
    // ARGS ARRIVE IN WIRE FORM (the facade's `_out`): tag-shaped data is wrapped as `{ "$": … }`, bytes as
    // `{ "$bytes": … }`. Copy them as data, then unwrap the one wrap level so the member sees the data the
    // cell meant. A `$secret` key is a HANDLE, never data, everywhere but the one dict an outermost wrap holds
    // (`handlesIn`); it is looked for before the unwrap, since after it the two are the same shape (ML_WIRE.md).
    let wireArgs: unknown[];
    try { wireArgs = toWire(req.args, 0, new Set(), false) as unknown[]; args = fromWire(wireArgs) as unknown[]; } catch (e) { return fail(seq, "BadRequest", `ml.${name}: ${(e as Error).message}`, ctx.scrub); }
    const handles = handlesIn(wireArgs);
    if (handles.length) {
        // THE SECRET'S NAME IS NEVER ITS AUTHORITY (ML_WIRE.md): resolve each against the run's own grants at
        // the sink and judge the use here. No member consumes a secret yet, so a handle that reaches this
        // check is refused rather than silently granted — the same `Denied` a name the run holds no grant
        // for would get. When a sink exists, this becomes `resolveSecret(run, name)` at that member.
        const names = [...new Set(handles.map((h) => h.$secret).filter((n): n is string => typeof n === "string"))];
        return fail(seq, "SecretHandle", `ml.${name}: a secret handle is never read as a value; pass it to a call that uses it${names.length ? ` (${names.join(", ")})` : ""}`, ctx.scrub);
    }
    const member = ctx.members[name];
    if (!member.gate) return answerOf(seq, name, member, args, ctx.scrub);
    let decision: WireGateDecision;
    try { decision = await member.gate(args); } catch (e) { return fail(seq, "Denied", `ml.${name}: ${(e as Error)?.message || String(e)}`, ctx.scrub); }
    if ("allow" in decision) return answerOf(seq, name, member, args, ctx.scrub);
    if ("deny" in decision) return fail(seq, "Denied", `ml.${name}: ${decision.deny}`, ctx.scrub);
    // The call waits on the person; the client suspends on it, and the answer follows when they decide. A card unanswered
    // past the cap fails the call, and an approval that lands after the client closed (the cell ended, the worker
    // restarted it) runs nothing: the member runs only for a client still there to receive it.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), ctx.askTimeoutMs ?? ASK_TIMEOUT_MS); });
    void Promise.race([decision.decided, timedOut]).then(
        (ok) => ok === "timeout" ? fail(seq, "Denied", `ml.${name}: the card went unanswered`, ctx.scrub)
            : !ctx.isOpen() ? null
            : ok ? answerOf(seq, name, member, args, ctx.scrub) : fail(seq, "Denied", `ml.${name}: the person declined`, ctx.scrub),
        (e) => fail(seq, "Denied", `ml.${name}: ${(e as Error)?.message || String(e)}`, ctx.scrub),
    ).then((a) => { clearTimeout(timer); if (a && ctx.isOpen()) ctx.later(a); });
    return { seq, ask: { card: decision.ask } };
}

/** Where a client's calls come from, as the browser reports the sender. `offscreen`: the extension's offscreen document
 *  (the Pyodide host). The only kind this round: an isolated world keeps its own channel (iso-channel.ts) until it
 *  becomes a wire client, and that kind arrives with every fact (tab, frame 0, document, world) REQUIRED, since a client
 *  opened without one would match any document on the tab. */
export type WireFrom = { kind: "offscreen" };

/** One open client: who may speak for it, the run it is for, its realm, and the page its `config()` describes. */
export interface WireClient {
    from: WireFrom;
    run: string | null;
    realm: WireRealm;
    tabUrl: () => string;
    /** The running step that started the code, as the opener knew it: where a nested ask for one of its calls is shown
     *  (docs/spec/ML_WIRE.md, "the step an ask rides is a fact of the handle, never of the message"). Absent: code no
     *  step started, which can raise no ask. */
    step?: { seq: number; local: { step: number; seq: number } };
}

const clients = new Map<string, WireClient>();   // state: plumbing — one in-flight cell each

/** The open client a handle names, or undefined: unknown, or closed when its code finished. */
export const wireClient = (handle: string): WireClient | undefined => clients.get(handle);

/**
 * Open a client for code the worker is about to start, and get the handle its calls must carry.
 * @param c where its calls will come from, the run it is for (null: none), its realm, its tab's URL now, and the
 *   running step that started it (kept only with a run)
 * @returns the handle, and `close` to call when the code has finished: later calls on the handle are refused
 */
export function openWireClient(c: { from: WireFrom; run: string | null; realm: WireRealm; tabUrl?: () => string; step?: WireClient["step"] }): { handle: string; close: () => void } {
    const handle = `mlw-${crypto.randomUUID()}`;
    clients.set(handle, { from: c.from, run: c.run, realm: c.realm, tabUrl: c.tabUrl ?? (() => ""), ...(c.run && c.step ? { step: { seq: c.step.seq, local: { ...c.step.local } } } : {}) });
    return { handle, close: () => { clients.delete(handle); } };
}

/**
 * Push the final answer to a call that answered `ask` first, as `ML_ANSWER`, if its client is still open. A closed
 * client (its code finished, the worker restarted it) is sent nothing: whatever now holds the handle's channel did not
 * ask.
 * @param handle the client
 * @param answer the answer
 * @param send how the push leaves (`chrome.runtime.sendMessage` in the worker)
 * @returns whether it was sent
 */
export function deliverIfOpen(handle: string, answer: MlWireAnswer, send: (m: { type: "ML_ANSWER"; client: string; answer: MlWireAnswer }) => void): boolean {
    if (wireClient(handle) === undefined) return false;
    send({ type: "ML_ANSWER", client: handle, answer });
    return true;
}

// The agent session's run-control object (`ml.createAgent` returns it; `ml.agent` threads it as `_control`)
// plus the small page-loop consent helpers it sits beside. Extracted from injected.ts verbatim — this is
// module-level, page-world state that's already parameterized by the `MlApi` handle (`_ml`), so it moves with
// no `this` rewrite. injected.ts imports `AgentHandle` (used by createAgent/agent), the two same-origin
// auto-approve predicates (used by the page loop), and the `AgentControl` type.
import type { NeutralMessage, MlApi, AgentOptions, MlAgentHandle, AgentResult, AgentTranscriptEntry } from "./contract";
import type { DerefRead, DerefMeta, TokenKind } from "./token-pipe";
import type { DerefValue } from "./contract";
import { jsonShape, jsonValue } from "./dom";
import { navTarget } from "./dom";
import { emitDebug } from "./bus";
import { makeBackgroundTaskPromise } from "./bridge";

/** The mutable state of ONE agent session, shared between ml.agent's page loop and (for a handle) the
 *  ml.createAgent handle that steers it. A plain ml.agent() call makes a throwaway one per call; a handle
 *  keeps its own so run()/say()/maxSteps span turns. Page-loop only — a background-hosted run's history
 *  lives in the service worker (see Phase 2). */
export interface AgentControl {
    hash: string | null;          // the session hash (minted on the first turn, then stable)
    messages: NeutralMessage[];   // the live history — the source of truth; the loop mutates it in place
    inbox: { id: string; text: string }[];   // say()'d messages waiting to be injected at the next step boundary (id = "seen"-indicator key)
    maxSteps: number;             // the step cap, read live so a handle can raise it mid-run
    running: boolean;             // is a loop in flight?
    seqBase: number;              // monotonic step-seq base so seqs stay session-unique across turns
    stepBase: number;             // monotonic STEP base so turn groups stay distinct in the sidebar across turns
    bg?: boolean;                 // the CURRENT run routed to the background → a mid-run say() steers via INJECT_MESSAGE
    tokens?: import("./token-pipe").TokenStore;   // the SESSION's `@tool:` pointer store — spans every turn (see AgentLoopOptions.tokenStore)
}

// Monotonic id per mid-run steer (a.say()), so the "seen" indicator can key an `agent-say-seen` event
// back to its `agent-say` bubble. Globally unique across handles/turns — a plain counter suffices.
let steerSeq = 0;
const nextSteerId = (): string => `sy_${++steerSeq}`;

/** Is a `navigate(url)` target SAME-ORIGIN as the current page? Cross-origin navs need consent (the gate);
 *  same-origin auto-approve. Reuses navTarget's origin logic; a bad URL counts as same-origin (the tool
 *  errors on it anyway, so no pointless prompt). Used by the page loop's autoApprove. */
export const sameOriginNav = (url: string): boolean => {
    const t = navTarget(url, location.href, { allowCrossOrigin: true });
    return "error" in t ? true : !t.crossOrigin;
};

/** Is a `fetch_url` target SAME-ORIGIN as the current page? An uncredentialed same-origin fetch is FREE (the
 *  page can already `fetch()` its own origin), like a same-origin navigate. A bad URL → not same-origin (let the
 *  normal gate handle it). Used by the page loop's autoApprove. */
export const sameOriginFetch = (url: string): boolean => {
    try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
};

/** The object ml.createAgent returns. It IS the session's AgentControl — the same instance is threaded
 *  into ml.agent as `_control`, so the loop mutates the very fields (hash/messages/inbox/seqBase) the
 *  handle exposes. `say` writes a user message into the session (steer if a loop is running, else queue
 *  for the next run()); `run` executes the loop; `maxSteps` is live (raise it mid-run). Page-loop only —
 *  a background-hosted run's history lives in the service worker (see Phase 2). */
export class AgentHandle implements MlAgentHandle, AgentControl {
    hash: string | null = null;
    messages: NeutralMessage[] = [];
    inbox: { id: string; text: string }[] = [];
    running = false;
    seqBase = 0;
    stepBase = 0;
    bg = false;   // set by ml.agent when the current run routes to the background (say() then uses INJECT_MESSAGE)
    private _maxSteps: number;
    private _ctrl = new AbortController();
    private _transcript: AgentTranscriptEntry[] = [];   // the WHOLE session's actions (accumulated across turns)
    constructor(private _ml: MlApi, private _opts: AgentOptions) { this._maxSteps = _opts.maxSteps ?? 10; }

    get maxSteps(): number { return this._maxSteps; }
    set maxSteps(n: number) {
        this._maxSteps = n;
        // Reflect the new cap in the sidebar/HUD the instant it's set — the running loop reads it live for
        // the "STEP x/N" display. Only meaningful once a run has minted the session hash.
        if (this.hash) emitDebug({ kind: "agent-cap", id: this.hash, ts: Date.now(), save: false, session: { hash: this.hash, turn: 0 }, maxSteps: n });
    }

    /** Run a full loop until the agent completes its turn. Call again for the next turn (same session).
     *  Rejects while a loop is in flight. No task → runs over whatever say() has queued into history. */
    async run(task?: string, images?: (string | HTMLImageElement)[]): Promise<AgentResult> {
        if (this.running) throw new Error("ml.createAgent: a run is already in flight — use say() to add to it, or cancel() first.");
        // Flush any leftover steering into the history so it's never lost: a mid-run say() that a background
        // loop couldn't drain live (arrived after its last step) sits in the inbox — pick it up this run.
        // Processing it now IS the agent seeing it, so flip the "seen" indicator on each flushed bubble.
        for (const { id, text } of this.inbox.splice(0)) {
            this.messages.push({ role: "user", content: text });
            if (this.hash) emitDebug({ kind: "agent-say-seen", id: this.hash, ts: Date.now(), save: false, session: { hash: this.hash, turn: 0 }, sayId: id });
        }
        // Fresh controller PER RUN: a prior cancel() aborted the previous one for good, so reusing it would
        // insta-cancel this turn. (A caller-supplied signal still governs — cancel() then only aborts ours.)
        this._ctrl = new AbortController();
        this.running = true;
        try {
            // images are PER-TURN (a composer paste), so they override any left on _opts.
            const r = await this._ml.agent(task ?? "", { ...this._opts, images: images || [], signal: this._opts.signal || this._ctrl.signal, _control: this } as AgentOptions);
            // Accumulate: a handle's transcript is the WHOLE conversation's actions, not just this turn's
            // (mirrors messages/hash spanning turns). ml.agent()'s per-call transcript is unchanged.
            this._transcript.push(...r.transcript);
            return { ...r, transcript: this._transcript.slice() };
        } finally { this.running = false; }
    }

    /** Put a user message into the session. Mid-run → steer (queued for the next step boundary, shown in
     *  the UI immediately); idle → append to history for the next run(), with a console note. Never throws. */
    say(text: string): void {
        if (this.running) {
            // A stable id ties this steer's bubble to its later "seen" flip (page loop drains → agent-say-seen;
            // a bg loop fans the same event from the SW, keyed by this same id via INJECT_MESSAGE.sayId).
            const sayId = nextSteerId();
            // Steer the live loop. A BACKGROUND run's loop is in the service worker, so route the message
            // there (INJECT_MESSAGE, drained at its next step); a PAGE-loop run drains the local inbox.
            if (this.bg && this.hash) makeBackgroundTaskPromise("INJECT_MESSAGE_REQUEST", "INJECT_MESSAGE_RESPONSE", { runId: this.hash, text, sayId }).catch(() => { /* run finished first → the next run()'s flush catches it */ });
            this.inbox.push({ id: sayId, text });   // page loop drains this; for a bg run it's the run()-flush safety net
            if (this.hash) emitDebug({ kind: "agent-say", id: this.hash, ts: Date.now(), save: false, session: { hash: this.hash, turn: 0 }, text, sayId });
        } else {
            this.messages.push({ role: "user", content: text });
            console.info("ml.agent: no run in flight — say() queued the message into history; call run() to have the agent process it.");
        }
    }

    cancel(): void {
        this._ctrl.abort();
        // A background run's loop lives in the service worker. Aborting the page controller only rejects the
        // round-trip (→ ABORT_TASK, which kills a FETCH_LLM, not the run), so the SW loop would keep stepping
        // and emit a stale approval AFTER the "cancelled" bubble. Relay CANCEL_RUN to actually stop it.
        if (this.bg && this.hash) window.postMessage({ type: "CANCEL_RUN_REQUEST", payload: { runId: this.hash } }, "*");
    }

    /** A new handle (fresh hash) seeded with a COPY of this history — diverge without touching this one. */
    fork(): MlAgentHandle {
        const f = new AgentHandle(this._ml, this._opts);
        f.messages = this.messages.map(m => ({ ...m }));
        return f;
    }
}


/** Read a `@tool:` pointer from a BACKGROUND-hosted run. The loop, and therefore the pointer store, lives in
 *  the service worker; this tool is executing in the page. So the page asks, over the same relay every other
 *  page→background request uses, keyed by the runId whose tool is running.
 *
 *  Not a page-reachable capability: nothing calls this except a ToolContext built for an executing delegated
 *  tool (run-delegation), and the background answers only for a run it is actually hosting. A page's own
 *  console has no active run, so `ml.dereference` throws there before any message is sent. */

/**
 * The object `ml.dereference` resolves to: the pointer's text, with what the loop knows about it attached.
 *
 * It EXTENDS String, which is the whole trick — every spelling that worked when this returned a bare string
 * still works (`JSON.parse(await ml.dereference(id))`, `${v}`, `v.split("\n")`, `v.length`), while `.type`,
 * `.json` and the rest answer the questions a caller previously had to guess at from the bytes. The one
 * casualty is `typeof v === "string"`, which is now false: compare `v.text`, or `String(v)`.
 *
 * `json` is parsed LAZILY and cached — most reads never ask, and a big capture should not pay for a parse
 * nobody wanted. A non-JSON body leaves it undefined rather than throwing, since asking is how you find out.
 */
export class DerefText extends String implements DerefValue {
    readonly type: TokenKind;
    readonly id: string;
    readonly tool: string;
    readonly step: number;
    readonly label?: string;
    readonly table?: { columns: string[]; rows: unknown[][] };
    readonly image?: string;
    readonly latex?: string;

    #json?: { v: unknown };            // memo: absent = not parsed yet, { v: undefined } = parsed, not JSON
    #repipe: (stages: string | string[]) => Promise<DerefValue>;

    constructor(text: string, meta: DerefMeta | undefined, repipe: (stages: string | string[]) => Promise<DerefValue>) {
        super(text);
        this.type = meta?.kind ?? "text";
        this.id = meta?.id ?? "";
        this.tool = meta?.tool ?? "";
        this.step = meta?.step ?? -1;
        if (meta?.label) this.label = meta.label;
        if (meta?.table) this.table = meta.table;
        if (meta?.image) this.image = meta.image;
        if (meta?.latex) this.latex = meta.latex;
        this.#repipe = repipe;
    }

    /** The text, explicitly — for a caller that would rather not rely on coercion. */
    get text(): string { return String(this); }

    get json(): unknown {
        if (!this.#json) {
            const t = this.text.trim();
            let v: unknown;
            if (t.startsWith("{") || t.startsWith("[")) { try { v = JSON.parse(t); } catch { v = undefined; } }
            this.#json = { v };
        }
        return this.#json.v;
    }

    /** Reduce this value further through the text-pipe dialect. */
    pipe(stages: string | string[]): Promise<DerefValue> { return this.#repipe(stages); }

    /** The TS-like shape of it. Throws the same actionable error as `ml.schema` on a non-JSON body. */
    schema(): string { return jsonShape(jsonValue(this.text, `@tool:${this.id || "?"}`)); }
}

export function derefViaBackground(runId: string, ref: string, pipe?: string | string[]): Promise<DerefRead> {
    return new Promise((resolve, reject) => {
        const id = `deref-${Math.random().toString(16).slice(2)}`;
        const onMsg = (e: MessageEvent) => {
            const d = e.data as { type?: string; id?: string; value?: string; warning?: string; meta?: DerefMeta; error?: string } | undefined;
            if (!d || d.type !== "PAGE_DEREF_RESULT" || d.id !== id) return;
            window.removeEventListener("message", onMsg);
            if (d.error) reject(new Error(d.error)); else resolve({ value: d.value ?? "", ...(d.warning ? { warning: d.warning } : {}), ...(d.meta ? { meta: d.meta } : {}) });
        };
        window.addEventListener("message", onMsg);
        // `pipe` may be an ARRAY of stages (structured-clones fine); `??` not `||` so an array survives.
        window.postMessage({ type: "PAGE_DEREF", id, runId, ref, pipe: pipe ?? "" }, "*");
    });
}

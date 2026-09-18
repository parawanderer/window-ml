// contract-agent.ts — the AGENT LOOP contract: what a tool is, what it may be asked, and what a run answers.
//
// MlTool is the centre of it; everything else is the loop around one: the options a run is started with, the
// approval a privileged call has to pass (ApprovalRequest, ApprovalDecision, and the two grant shapes that
// say a human already said yes), the ToolContext a tool runs inside, the per-step event, and AgentResult.
//
// The security shape to keep in mind while editing: an approval is a decision made at the choke point about
// a request, so ApprovalRequest describes what is being ASKED, never what was allowed. A grant is the separate
// record of a human having answered. Merging the two would make a tool's own claim look like consent.
import type { AnswerSet } from "./answer-set";
// Type-only, so the cycle with contract.ts (which re-exports this file) erases at build entirely.
import type { JsonSchema, RequestHint } from "./contract";
import type { DerefRead } from "./contract-pointers";
import type { NeutralMessage } from "./contract-chat";
import type { AnswerMedia, RenderDescriptor, ToolFeedback, ToolRenderInput, TokenRender } from "./contract-render";

/** What ONE tool call returns. `content` is the string the MODEL sees and is the only required field; every
 *  other field is for the humans watching -- the nodes it designated, their serialized visuals, and the
 *  descriptor that draws a pretty view. Whatever is drawn, `content` stays recoverable beside it. */
export interface ToolResult {
    content: string;
    elements?: Node[];
    /** answer's serialized element visuals → the HUD completion card (see AnswerMedia). */
    answerMedia?: AnswerMedia[];
    /** Set by the built-in `answer` tool: it curated the run's answer set ITSELF, so the loop must NOT
     *  also auto-accumulate these `elements` into it (that path is for OTHER answer-capable tools, which
     *  just return nodes and don't know about the set). */
    answerManaged?: boolean;
    image?: string;
    imageLabel?: string;
    /** MULTIPLE inline-vision images from ONE tool call, injected as separate images on the driver's next
     *  turn (look's `views:["overlay","no-overlay"]` → the marked crop + a clean copy). Sits alongside the
     *  single `image` shortcut; the loop pushes both. Full-resolution (not composited into one). */
    images?: { image: string; label?: string }[];
    /** the Out slot: a visualization of the result (e.g. locate's marks) */
    render?: RenderDescriptor;
    /** the In slot: a visualization of the CALL (e.g. python's notebook-cell header) */
    renderIn?: RenderDescriptor;
    /** A REMOTE executor's own measurement of itself. Only a tool that ran somewhere else reports this, and
     *  without it that step's span is the tool plus the network as one unattributable number — the same
     *  confound `prompt_eval_duration` closed for model calls. Rides to the timeline, never to the model. */
    remoteMs?: RemoteTiming;
    /** RESERVED-surface click signal: the target is a cross-origin iframe / sealed closed shadow root that a
     *  synthetic click can't reach, so the tool declines to click and asks the executor to do a CDP click at
     *  this viewport coordinate instead (page loop → CDP_CLICK message; background → cdpClick directly). See
     *  docs/spec/CDP_CLICK.md. `hint` = a stuck-loop re-snap nudge to append when this @pt was clicked before
     *  (the CDP result string is built background-side, so the page threads the nudge here). */
    cdpClick?: { x: number; y: number; hint?: string; verify?: boolean };
    /** STRICT-PAGE exec signal: the page's CSP omits 'unsafe-eval' or enforces Trusted Types, so main-world
     *  `eval`/`new Function` was BLOCKED (threw at compile, nothing ran). The tool declines and asks the
     *  background to re-run the SAME (already-approved) source via CDP `Runtime.evaluate` — the debugger is
     *  exempt from the page's CSP/TT. `source` is the model's exec code. See docs/spec/EXEC_STRICT_CSP.md. */
    cdpExec?: { source: string };
    /** SEALED-SHADOW click signal: a `>>>` selector targets content inside a closed/declarative shadow root a
     *  page selector can't enter, so the tool declines and asks the background to RESOLVE the selector via CDP
     *  (which pierces closed roots) and click the resolved element by coordinate. `selector` is the `>>>` path,
     *  `index` the Nth match. Background-only, like `cdpClick`. See the CDP shadow resolver in background.ts. */
    cdpShadowClick?: { selector: string; index?: number; verify?: boolean };
    /** TRUSTED-KEYBOARD signal: type text via CDP `Input.dispatchKeyEvent` (real, isTrusted key events a
     *  canvas/WebGL/remote-desktop app honours — synthetic KeyboardEvents don't). Three focus modes: a sealed
     *  `>>>` `selector` (CDP-resolve → focus the field) · an `@pt` `x,y` (CDP-click there first to focus) · or
     *  NEITHER (type into the page's CURRENT focus — a canvas/stream). `submit` presses Enter after; `append`
     *  keeps the field's existing value (else clears it first, sealed field only). Background-only, `cdp`-gated. */
    cdpType?: { text: string; submit?: boolean; append?: boolean; x?: number; y?: number; selector?: string; index?: number; verify?: boolean; verifyElement?: string; verifyFocus?: boolean };
    /** what this tool fed into the model's context (locate's snap-inject); surfaced in the debug render + export */
    feedback?: ToolFeedback;
}

/** The RUNTIME execution context handed to a tool's `run(args, ctx)` — things a tool can only learn at run
 *  time, not when it was defined: which OTHER tools are wired this run (so a tool can adapt when a companion
 *  like `locate` isn't available), and the driver model + its capabilities. Built per run at the single tool
 *  choke point (tool-exec.ts) and passed through to `run`; optional, so a tool that ignores it still works. */
export interface ToolContext {
    /** Names of every tool available to the agent THIS run. */
    tools: string[];
    /** Whether a given tool is wired this run — e.g. `ctx.hasTool("locate")` before suggesting a visual path.
     *  This is ALSO the right "can the agent SEE?" signal: `hasTool("look")` reflects the effective vision
     *  (native probe, a delegated reader, OR the defaultModelVision override for a cloud model). */
    hasTool(name: string): boolean;
    /** The resolved driver model (or null when unset). */
    model: string | null;
    /** The driver model's RAW Ollama capabilities (["completion","tools","vision","thinking"]), or null when
     *  undeterminable (cloud / non-Ollama / not probed). NOTE: for "does it see images" use `hasTool("look")`,
     *  NOT this — a cloud model with the vision OVERRIDE has null raw caps but a wired `look` tool. */
    capabilities: string[] | null;
    /** Whether the DRIVER model itself sees the pixels NATIVELY this run (forced `vision:true`, or a probe
     *  confirmed its own model is vision-capable — i.e. `look` was wired native, not delegated). Resolved ONCE
     *  in the auto-wire and carried here so `locate`'s snap-feedback injects an inline image (native) vs a
     *  delegated text description — reading the SAME answer that chose the look tool, never re-deriving it. */
    driverSees: boolean;
    /** The resolved VISION READER for this run — the model a delegated vision sub-call (look/locate describe)
     *  uses. Equals `model` when the driver sees natively (`driverSees`), else a separate reader (the OCR
     *  model); null when no vision model resolved. Carried from the auto-wire's one resolution. */
    visionModel: string | null;
    /** Per-run scratch for `agent_api_docs`'s within-burst dedup — the API chunks it has already shown so a
     *  contiguous dig doesn't re-print them (see DocsMemory). Persisted per run (keyed by the toolset) and
     *  reset by `executeTool` once the model breaks the docs streak; a tool that doesn't use it ignores it. */
    docsMemory?: DocsMemory;
    /** The run's curated user-facing answer set — the `answer` tool adds/removes/clears it, `ml.answer`
     *  mirrors it, and the loop reads it to assemble AgentResult. Per run (keyed by the toolset). */
    answer?: AnswerSet;
    /** Read a `@tool:<id>` pointer from THIS run — what `ml.dereference` binds to inside a tool call. Absent
     *  outside a run, which is why the page can't reach it from its own console. */
    deref?: (ref: string, pipe?: string | string[]) => Promise<DerefRead>;
    /** Bundle ids this run exposed via `serverTools`, and therefore the ONLY ones `ml.dynamicTools` reaches
     *  from inside one of its tool calls. An empty array narrows it to nothing, which is what a run that
     *  asked for no server tools must get; absent is treated the same way. */
    serverAllow?: readonly string[];
    /** The run's hint session (`wml-` + its hash). Bound while a tool runs, so a model call the tool makes is
     *  labelled as part of this run (`use: "agent"`, see RequestHint) rather than as an anonymous one-shot. */
    session?: string;
    /** LIVE partial output — a GENERIC tool-streaming capability. A tool's `run` may call `ctx.stream(text)`
     *  to stream output AS IT WORKS (Jupyter-style: `exec`'s console.log, `python_exec`'s print), so the step's
     *  Out fills in live instead of only appearing at completion. Present ONLY when the run opted into
     *  `streaming` — a tool checks `if (ctx.stream)` and streams if it can; absent → it just returns the full
     *  result at the end (unchanged). The loop throttles + caps the fan; the final result still supersedes it.
     *
     *  `ts` is WHEN THE OUTPUT WAS PRODUCED, and it belongs to the EXECUTOR, not the renderer: a tool whose
     *  work happens elsewhere (python_exec's Pyodide worker; a hypothetical bash tool running on a server)
     *  passes the time recorded THERE, so the displayed clock isn't skewed by however many hops the chunk
     *  crossed to reach us. Omit it only when the producer IS this realm (exec's console patch) — the fan then
     *  stamps `Date.now()`, which is the same instant. The UI only decides whether to SHOW these. */
    stream?: (text: string, ts?: number) => void;
}

/** `agent_api_docs`'s per-run memory: which reference chunks have been shown in the CURRENT burst of docs
 *  calls, plus how many non-docs tool calls have happened since the last one (for the leniency reset). */
export interface DocsMemory {
    /** Section keys already shown this burst (`"type:FetchResult"`, `"member:fetch"`, `"env:…"`, `"ml"`). */
    shown: Set<string>;
    /** Non-`agent_api_docs` tool calls since the last docs call; `shown` clears once it exceeds the leniency. */
    sinceDocs: number;
}

/** A TOOL the agent can call: its name, the JSON Schema of its arguments, the description the model reads,
 *  and the function that runs it. This is the extension point -- `ml.agent({ extraTools })` takes these, and
 *  every built-in is one, so a caller-supplied tool is indistinguishable from a shipped one at the loop. */
export interface MlTool {
    name: string;
    /** the FULL description sent to the model */
    description: string;
    parameters: JsonSchema;
    /** Optional SHORT, human-friendly one-liner (≤ ~12 words) for the debug/HUD UI — shown as a tooltip
     *  when you hover the tool name in a step, in BOTH the debug sidebar and the off-mode card. e.g. look:
     *  "Screenshots the page so the agent can see it." A tool that provides none just has no tooltip. */
    summary?: string;
    /** Args are model-supplied JSON, so tools may destructure a specific shape
     *  (`run({ selector }: { selector: string })`); typed `any` so those narrower
     *  signatures stay assignable to this contract. */
    run: (args: any, ctx?: ToolContext) => string | ToolResult | Promise<string | ToolResult>;
    requiresApproval: boolean;
    /** e.g. "vision" | "answer" | "meta" ("meta" = self-introspection, answered by the agent loop) */
    capabilities: ("vision"|"answer"|"meta")[];
    /** Optional page-side formatter → a serializable RenderDescriptor for the debug
     *  sidebar's IN slot (a visualization of the call; null/throw → the raw args). This
     *  is the method form of `ToolResult.renderIn`; `exec` uses it to show pretty JS.
     *  Never receives/returns code. */
    render?: (input: ToolRenderInput, args: Record<string, unknown>) => RenderDescriptor | null | undefined;
    /** Optional SIDE-EFFECT-FREE pre-check (page-side) for a requiresApproval tool: resolve the target
     *  and return an ERROR STRING if the action is doomed (no element matches, a stale @pt, an invalid
     *  selector), else null to proceed to the gate. The loop uses it to SKIP the approval prompt for an
     *  action that would only fail — approving something that can't do anything is pointless friction.
     *  Must not mutate the DOM or navigate. `click`/`type` implement it (their run() calls it first too). */
    precheck?: (args: any) => string | null;
    /**
     * This tool runs somewhere ELSE — the identity of the remote callable it dispatches to.
     *
     * Not decoration and not derivable from the tool's name: the approval card renders from this, and the
     * background mints its per-call grant from this, so the human sees exactly the callable that will run.
     * A page choosing a friendly tool name cannot make the card say one thing and the grant authorise
     * another, because both read the same field.
     */
    remote?: RemoteToolTarget;
}

/** What a remote executor says it spent, distinct from what we measured around it. The DIFFERENCE is the
 *  network and the far end's overhead, and it is only recoverable because the executor reports its own
 *  number — see docs/spec/REMOTE_TOOL_EXECUTION.md. Absent means unknown, never instant. */
export interface RemoteTiming {
    /** Time spent EVALUATING, excluding transport. */
    durationMs: number;
    /** Elapsed before evaluation began — resolution, scheduling, a downstream connect. */
    queuedMs?: number;
    /** COLD START of the executor's runtime, charged to the call that paid for it and absent on every
     *  later one. The distinction a model's `load_duration` exists to make, for a sandbox: a first
     *  `python_exec` spends seconds fetching Pyodide and its wheels before a line of the script runs, and
     *  a single elapsed figure blames the script for time it never spent. Reported BY the executor — the
     *  worker, here — since anything measured downstream is measuring the message bus too. */
    bootMs?: number;
}

/** Where a remote tool actually runs. `via` names the dispatch mechanism, because "an HTTP endpoint
 *  evaluates this" is a fact about our own dispatch and the only one we can honestly record — an
 *  in-process tool can reach a container over IPC and nothing here would see it. */
export interface RemoteToolTarget {
    via: "openwebui";
    /** The tool BUNDLE's id. */
    toolId: string;
    /** The function within it. */
    fn: string;
}

/** What a privileged call is ASKING to do, handed to the approval gate. It describes the request and never
 *  the verdict: a grant (ReusedGrant, PersistGrant) is the separate record of a human having answered, and
 *  keeping the two apart is what stops a tool own claim from reading as consent. */
export interface ApprovalRequest {
    tool: string;
    arguments: Record<string, unknown>;
}

/** The approval-gate contract: a boolean, or a rich object that can feed a
 *  rejection comment back to the model and/or edit the args before running.
 *  `source` records WHO decided — "user" (a browser UI surface) or "external"
 *  (the __mlApprovals IPC channel: an orchestrator / policy driver) — so a
 *  denial reads back accurately to the model. Absent → treated as "user". */
export type ApprovalDecision =
    | boolean
    | { approved: boolean; feedback?: string; arguments?: Record<string, unknown>; source?: "user" | "external";
        /** button #3: ALSO persist this call's statically-known egress grants (its `ml.fetch` literal URLs)
         *  for the rest of the session, so a later call to the same URL auto-approves. Only ever set on a
         *  positive decision; the grants themselves are re-derived background-side (never trusted from here). */
        persist?: boolean;
        /** The run is being CANCELLED (Stop), not denied — how CANCEL_RUN resolves an open gate. Distinct from
         *  a plain `approved:false`: the loop must EXIT as cancelled, not treat it as a deny and step on. This is
         *  the cancel channel that works even when the run's AbortController is gone (an evicted/re-adopted run),
         *  where aborting the signal can't reach the loop — resolving the gate cancelled still stops it. */
        cancelled?: boolean };

/** A prior grant a tool call REUSED (so it ran without a fresh prompt) — the transparency counterpart of
 *  PersistGrant. `kind` keys the per-kind label/icon; `detail` is the human-readable thing reused (the URL,
 *  the sheet name/id). Extensible: a new grant kind adds a `kind` + a detail here + one render branch. */
export interface ReusedGrant {
    kind: "fetch-url" | "sheet";
    detail: string;
}

/** A persistable egress consent a tool call would establish — the unit button #3 remembers for the session.
 *  Extracted STATICALLY, background-side (grant-extract.ts), so it holds only literal targets the human saw.
 *  `kind` keys the UI's per-kind rendering + the background's per-kind persistence (today: `ml.fetch` URLs). */
export interface PersistGrant {
    kind: "fetch-url";
    /** the distinct static URLs this grant would remember */
    urls: string[];
}

/** ONE entry in a run's transcript: a thought, a tool call with its arguments and result, or the assistant
 *  reply that ended a turn. All optional because a step is any of those -- the transcript is the complete
 *  record of what the run DID and SAID, not a list of tool calls with the prose dropped. */
export interface AgentTranscriptEntry {
    thought?: string;
    tool?: string;
    arguments?: Record<string, unknown>;
    result?: string;
    elements?: Node[];
    /** a turn's final assistant answer (the reply that ended the turn) — so the transcript is a complete
     *  record of what the agent DID and SAID, not just its tool calls. */
    assistant?: string;
}

/** What `ml.agent` RESOLVES to, including when it did not finish. A run that hit the step cap or was
 *  cancelled resolves with `hitCap` / `cancelled` set and its partial transcript intact rather than
 *  rejecting, so a caller reads one shape whatever happened and a partial run is still inspectable. */
export interface AgentResult {
    summary: string;
    steps: number;
    transcript: AgentTranscriptEntry[];
    /** nodes designated via an answer-capable tool */
    elements: Node[];
    /** serialized visuals of the designated elements — for the HUD completion card (see AnswerMedia). */
    answerMedia?: AnswerMedia[];
    /** the curated answer SET resolved to markdown (text items verbatim, elements as bullets, tool
     *  tokens as links) — a self-contained representation of the run's user-facing result. "" / omitted
     *  when nothing was designated. */
    answer?: string;
    hitCap?: boolean;
    /** the caller aborted via opts.signal (partial transcript preserved) */
    cancelled?: boolean;
    /** the run's session hash — pass to ml.agent(task, { resume }) to continue it */
    hash: string;
    /** Structured, ready-to-use JS data for every tool output the model surfaced in its final answer (cited
     *  inline or designated into `ml.answer`) — so `ml.agent()` works for HEADLESS SCRIPTING, not just prose.
     *  A python DataFrame → `{ kind:"table", columns, rows }` (a 2D matrix); a python dict/list return →
     *  `{ kind:"value", value }` with the PARSED object; an image → a data URL; code → its text. In answer
     *  order, deduped. (`elements` designations also come back live in `.elements`, ≡ ml.queryAll.) */
    outputs?: AgentOutput[];
    /** INTERNAL (stripped before ml.agent resolves): per-step render data, so the outputs resolver can turn a
     *  cited/designated token into its structured value. */
    tokenRenders?: TokenRender[];
}

/** Structured data for one tool output surfaced in an agent's answer — the headless-scripting payload. */
export type AgentOutput = { id: string; tool: string } & (
    | { kind: "table"; columns: string[]; rows: (string | number | boolean | null)[][] }   // a DataFrame / DOM table → a 2D matrix + its header
    | { kind: "value"; value: unknown }        // a scalar / a python dict-or-list (PARSED to the real JS object when it was JSON)
    | { kind: "image"; dataUrl: string }       // a screenshot / returned image, as a data: URL
    | { kind: "code"; text: string; lang?: string }             // the executed source (a `:in` citation)
    | { kind: "elements"; items: { path: string; text?: string }[] }   // serialized element previews (live nodes are in AgentResult.elements)
);

/** One live tracer event from ml.agent's `onStep` (a transcript entry + the
 *  step index). Also the shape ml._logStep consumes. */
export interface AgentStepEvent extends AgentTranscriptEntry {
    step: number;
}

/** The run-bound `ml.answer` collection — curate the run's user-facing result. */
export interface MlAnswer {
    /** Add a result: a live Element (or array of them → hoverable/highlighted), a `@tool:` output token
     *  (from a tool result), or literal text/markdown. Returns the new item's index. */
    add(x: Element | Element[] | string): number;
    /** Remove an item by index (from a dump), or by a `@tool:` ref / exact text. Returns how many were removed. */
    remove(which: number | string): number;
    /** Empty the answer. */
    clear(): void;
    /** A compact indexed view of the set — `{ i, kind, preview }` per item (never nodes/media/full content). */
    dump(): { i: number; kind: "text" | "token" | "element"; preview: string }[];
    /** How many items are in the answer. */
    readonly length: number;
}

/** Options for the low-level ml.step turn. */
export interface StepOptions {
    /** client-side tool definitions */
    tools?: unknown[];
    model?: string | null;
    think?: boolean | null;
    /** abort kills the in-flight model fetch and rejects the call */
    signal?: AbortSignal | null;
    /** What this request is for ({@link RequestHint}). Default: an agent step (a program acts on the reply), in the
     *  session of the run whose tool is executing, if any. */
    hint?: RequestHint | null;
}

/** Options for ml.agent — the loop, whitelist, cap and approval gate. */
export interface AgentOptions {
    /** tool registry (default ml.domTools) */
    tools?: MlTool[] | null;
    /** appended to `tools` */
    extraTools?: MlTool[];
    /**
     * Server-side tool BUNDLE ids (from `ml.serverTools()`) to expose to the model — one agent-callable
     * tool per function, with that function's own schema.
     *
     * Opt-in by id, never "all of them": these run on the server with the user's credentials and their
     * arguments leave the machine, so which ones a run may reach is the caller's decision rather than a
     * default. Every call requires approval. Needs the patched OpenWebUI (docs/FORKED-BACKENDS.md); an id
     * that does not resolve is skipped rather than failing the run.
     */
    serverTools?: string[];
    /** REPLACES the built-in preamble */
    system?: string | null;
    /** APPENDED to the built-in preamble */
    systemAppend?: string | null;
    maxSteps?: number;
    model?: string | null;
    /** Toggle the model's separate reasoning pass: true = think before each step, false = don't;
     *  null = omit the param (Ollama-only — some cloud models reject it). */
    think?: boolean | null;
    approve?: (req: ApprovalRequest) => boolean | ApprovalDecision | Promise<boolean | ApprovalDecision>;
    onStep?: ((ev: AgentStepEvent) => void) | null;
    /** prepend page-context note to the system prompt */
    env?: boolean;
    /** auto-wire a `look` tool (null = probe) */
    vision?: boolean | string | null;
    /** install the built-in console tracer */
    logDebug?: boolean;
    /** TOOL TOKENS: a tool result with a rich render (an image/table/code) gets a trailing `@tool:<id>` line,
     *  so the model can cite that EXACT output in its final answer / answer set instead of re-typing it.
     *  Default false; a HUD-started run turns it on (that's where the rich answer card is shown). */
    toolTokens?: boolean;
    /** abort the loop between steps → resolves { cancelled: true } with the partial run */
    signal?: AbortSignal | null;
    /** continue the run with this hash: append `task` as a follow-up turn (same session) */
    resume?: string | null;
    /** images (URLs / data URLs / <img>) to attach to THIS turn's user message — e.g. a screenshot the
     *  user pasted into the HUD/sidebar composer. A vision-capable driver sees them natively; otherwise
     *  they're transcribed via ml.read and injected as text (with a note the model didn't see the pixels). */
    images?: (string | HTMLImageElement)[];
    /** scripting mode: keep this run OUT of the in-page HUD (no working orb, no answer card). Approvals STILL surface (privileged consent can't be silenced). The debug sidebar/panel is unaffected. */
    silent?: boolean;
    /** headless mode: no human to approve, so any approval-gated call is REFUSED with a steer to read-only. exec/python_exec are wired ONLY when their auto-approve config is on (read-only survey / sandbox), and told full/mutating use is disabled; otherwise dropped. Auto-approvable read-only ops still run. */
    unattended?: boolean;
    /** may this run navigate to other pages? Default true: a `navigate(url)` tool is wired (same-origin
     *  only in v1; cross-origin is refused pending per-origin consent), and a background-hosted run SURVIVES
     *  a same-site full-page navigation (re-adopting the new document). false → no `navigate` tool AND no
     *  cross-page persistence (a link/click that loads a new page ends the run), plus a system-prompt note
     *  telling the model it can't navigate. */
    navigate?: boolean;
    /** may this run navigate to OTHER SITES (different origins)? Default false — same-site only (a cross-site
     *  URL is refused). true opts in: the `navigate` tool crosses origins and the background run re-adopts on
     *  the new site. A scope escalation (history rides onto another origin), so it's off by default; needs
     *  `navigate` (no effect when navigation is off). */
    crossOrigin?: boolean;
    /** where a privileged approval gate is resolved (background-hosted runs only). `"ui"` (default) = the
     *  human approves in a browser surface, as always. `"both"` = the UI still shows AND an out-of-browser
     *  driver may resolve it via the SW-only `__mlApprovals` channel (Playwright / a desktop orchestrator).
     *  `"external"` = the UI buttons are SUPPRESSED and ONLY that channel resolves it (headless). A `"ui"`
     *  run is never externally resolvable — the channel lists/decides only opted-in ("both"/"external") runs. */
    approvalRouting?: "ui" | "both" | "external";
    /** STREAM the model's thinking/reply live (emits `agent-stream` deltas → a live "thinking" block in the
     *  sidebar/HUD), so a long reasoning phase shows its words instead of a frozen token count. Default false —
     *  the loop uses a single non-streamed call. Background-hosted runs only (design A); a page-hosted run
     *  ignores it. Accumulates tool_calls from the stream, so the loop still gets its authoritative result. */
    stream?: boolean;
}

/** A stateful ml.agent handle (what ml.createAgent returns) — the agent analogue of ml.createChat's
 *  history. Two primitives: `say` writes a user message into the session, `run` executes the loop until
 *  the agent's turn is complete. Everything shares one `hash` = one sidebar/HUD conversation. */
export interface MlAgentHandle {
    /** the session hash (null until the first run() mints it) */
    hash: string | null;
    /** the live conversation history — readable AND mutable (push/splice or reassign), like MlHistory.messages */
    messages: NeutralMessage[];
    /** the step cap, LIVE: raising it mid-run (a.maxSteps = 40) lets the running loop keep going */
    maxSteps: number;
    /** is a loop in flight right now? */
    running: boolean;
    /** run a full end-to-end loop until the agent completes its turn. Call again for the next turn (same
     *  session). Rejects if a loop is already in flight. With no task, runs over whatever say() has queued.
     *  `images` attach to THIS turn's user message (a composer paste) — native-vision or OCR-transcribed. */
    run(task?: string, images?: (string | HTMLImageElement)[]): Promise<AgentResult>;
    /** put a user message into the session: MID-RUN it steers (injected at the next step boundary); IDLE it
     *  appends to history for the next run() (with a console note). Never throws. */
    say(text: string): void;
    /** abort the in-flight loop → it resolves { cancelled: true }. */
    cancel(): void;
    /** a NEW handle (fresh hash) seeded with a COPY of this history — diverge without touching this one. */
    fork(): MlAgentHandle;
}

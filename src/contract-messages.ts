// contract-messages.ts — the WIRE: what travels between the page, the content script and the worker.
//
// The three message-name unions (PageRequestType, BackgroundMessageType, ContentMessageType) and the payload
// of every message that carries more than a string. Adding a primitive means touching all three worlds, and
// this is the one file that says what each hop sends -- AGENTS.md "message contract" section is the procedure,
// these are the shapes. StoredSession is here rather than with the session types because it is what crosses
// into chrome.storage.local and back, which is the same kind of boundary. Types only; erased at build.
// Re-exported from contract.ts, which stays the address everything imports from.
// Type-only, so the cycle with contract.ts (which re-exports this file) erases at build entirely.
import type { JsonSchema } from "./contract";
import type { RequestHint } from "./contract-run";
import type { LexicalMetric } from "./contract-config";
import type { NeutralMessage, ExtendProfile } from "./contract-chat";
import type { RemoteToolTarget, RemoteTiming, ReusedGrant } from "./contract-agent";
import type { AnswerMedia, RenderDescriptor, ToolFeedback } from "./contract-render";
import type { FetchFormat } from "./contract-fetch";
import type { SubcallUsage } from "./contract-debug";

/** `FETCH_URL` payload — a GET the background performs on the agent's behalf (bypassing CORS via host
 *  permissions). Uncredentialed by default; `credentials` sends the user's cookies, `rendered` loads it in a
 *  tab so its JS runs (incognito unless credentialed). No headers/body/method knobs by design: a locked,
 *  low-surface read primitive. */
export interface FetchUrlPayload { url: string; credentials?: boolean; rendered?: boolean; format?: FetchFormat; }

/** Page-side request types posted over window.postMessage (content.js maps
 *  each to its BackgroundMessageType counterpart via HANDLE_MAP). */
export type PageRequestType =
    | "LLM_REQUEST" | "LLM_STREAM_REQUEST" | "B64_REQUEST" | "LIST_MODELS_REQUEST"
    | "GET_MODEL_REQUEST" | "CONFIG_REQUEST" | "SET_MODEL_REQUEST" | "CAPS_REQUEST" | "EMBED_REQUEST"
    | "PS_REQUEST" | "UNLOAD_REQUEST" | "CAPTURE_TAB_REQUEST" | "DUMP_EVENTS_REQUEST" | "DUMP_LOADS_REQUEST"
    | "DUMP_HOUSEKEEPING_REQUEST"   // ml.__housekeeping(): what the system decided on its own
    | "HOUSEKEEPING_REPORT_REQUEST"   // a page-side mechanism (the fetch cache) reporting what it decided
    | "PYTHON_PREWARM_REQUEST"   // a run with python_exec is starting: start Pyodide now so its first call does not wait
    | "SAVE_SESSION_REQUEST" | "GET_SESSION_REQUEST" | "PYTHON_EXEC_REQUEST" | "FETCH_SHEET_REQUEST" | "FETCH_URL_REQUEST"
    | "CDP_SHADOW_RESOLVE_REQUEST"   // read-only: resolve a `>>>` selector into a SEALED closed shadow root via CDP (discovery)
    | "LIST_SERVER_TOOLS_REQUEST"   // discover the OpenWebUI server-side tools this key may use (valid `toolIds`)
    | "SERVER_TOOL_REQUEST"   // run ONE of them ourselves, in our own loop, streaming its frames back
    | "INFO_REQUEST"                // machine CAPACITY: per-device VRAM totals/free + system RAM (Ollama /api/info)
    | "USER_FOCUS_REQUEST"          // chat_metadata's "user focus" line: where the user is, relative to THIS tab (coarse)
    | "INVOCATION_REQUEST"   // how the user can open the HUD here (live shortcut — user-rebindable, never hardcode it)
    | "START_RUN_REQUEST"   // design A: kick off a background-hosted ml.agent loop
    | "RESUME_RUN_REQUEST"   // design A: continue a background-hosted run (append a follow-up turn to its stored history)
    | "INJECT_MESSAGE_REQUEST"   // a.say() mid-run: steer a RUNNING background loop (its inbox drains at the next step)
    | "CANCEL_RUN_REQUEST"   // a handle cancel()ing its OWN background run: relay CANCEL_RUN so the SW aborts the loop (special-cased, not HANDLE_MAP)
    | "ABORT_REQUEST";   // cancel an in-flight background task by requestId (handled specially, not via HANDLE_MAP)

/** Message types the background worker's onMessage listener handles. */
export type BackgroundMessageType =
    | "FETCH_LLM" | "FETCH_IMAGE_B64" | "LIST_MODELS" | "GET_MODEL" | "GET_CONFIG"
    | "SET_MODEL" | "MODEL_CAPS" | "EMBED" | "OLLAMA_PS" | "OLLAMA_UNLOAD" | "CAPTURE_TAB"
    | "DUMP_EVENTS"   // ml.__events(): the raw inputs the resource panel derives its timeline from
    | "DUMP_LOADS"   // ml.__loads(): one record per model load, collected for tuning the VRAM predictor
    | "DUMP_HOUSEKEEPING"   // ml.__housekeeping() + the DevTools panel: the housekeeping log (housekeeping.ts)
    | "SESSION_STORAGE_STATS"   // extension pages only: where the saved-session store's bytes go (session-storage-stats.ts)
    | "ARCHIVE_FOLDER"   // extension pages only: the archive folder's state, or an action after a click (pick, sync, import)
    | "HUB_RUNTIME"   // extension pages only: this browser's hub connection state, or `paired` / `left` from the page that paired it
    | "STORAGE_HISTORY"   // extension pages only: the Storage section's daily history, today's picture and the largest sessions
    | "HOUSEKEEPING_REPORT"   // another context reporting what it decided; origin is stamped from the sender
    | "PYTHON_PREWARM"   // start Pyodide ahead of a run (run start with python_exec, or the Commander opening)
    | "SAVE_SESSION" | "GET_SESSION" | "PYTHON_EXEC" | "FETCH_SHEET" | "FETCH_SHEET_TITLE" | "FETCH_URL"
    | "CDP_SHADOW_RESOLVE"   // read-only CDP resolve of a `>>>` selector across sealed shadow roots (discovery half of sealed reach)
    | "LIST_SERVER_TOOLS"   // GET OpenWebUI /api/v1/tools/ — the server-side tools, with their function specs
    | "SERVER_TOOL_EXEC"   // run ONE of them ourselves (privileged: the user's API key), streaming NDJSON frames back
    | "OLLAMA_INFO"         // GET Ollama /api/info — machine capacity (per-device VRAM, system RAM)
    | "USER_FOCUS"          // where the user is relative to the SENDER's tab, coarse (user-focus.ts); null when on it
    | "GET_INVOCATION"   // read chrome.commands' LIVE shortcut for the HUD (+ whether the user rebound it)
    | "ABORT_TASK"    // abort the AbortController registered for a requestId (only FETCH_LLM registers one today)
    | "START_RUN"     // design A: run an ml.agent loop in the background (unforgeable gate); tools delegate to the page
    | "RESUME_RUN"    // design A: continue a stored background run (its history lives in the SW) with a follow-up task
    | "INJECT_MESSAGE"   // a.say() mid-run: push a user message into a RUNNING background run's inbox (steer it live)
    | "CONTENT_READY"   // cross-page: a fresh document loaded — the SW replies with any rebuild-config for runs this tab hosts
    | "RUN_READOPTED"   // cross-page: the fresh document re-registered a run's toolset → release the navigation barrier
    | "SET_APPROVAL"; // design A: the sidebar's approve/deny decision for a pending background-run gate (origin-authed)

/** Message types the CONTENT SCRIPT handles INBOUND from the background — the reverse of the
 *  page→background relay above. Design A's agent loop lives in the background (extension origin,
 *  unforgeable approval), but page-context tools (exec/click/type/look/locate/DOM survey) must run
 *  where the DOM is, so the background asks the page to run a named tool by `chrome.tabs.sendMessage`.
 *  content.ts relays it to the main world as a `PAGE_TOOL_RUN` window message and returns the page's
 *  `PAGE_TOOL_RESULT` envelope via sendResponse. */
export type ContentMessageType =
    | "RUN_TOOL_IN_PAGE"   // background → page: run a named tool from an active run's toolset
    | "ML_DEBUG_TO_PAGE";  // background → page: a debug event from a background-hosted run, re-posted as __mlDebug for the overlay

/** START_RUN payload — everything the background needs to run an ml.agent loop with tool execution
 *  delegated back to the page. The system prompt + toolset are built PAGE-SIDE (they need page context,
 *  the vision/answer/compute clauses, and the live tool factories); the background receives the resolved
 *  prompt + serializable tool descriptors (the run() functions stay on the page, keyed by `runId`). */
export interface StartRunPayload {
    runId: string;
    task: string;
    systemPrompt: string;
    tools: { name: string; description: string; parameters: JsonSchema; requiresApproval: boolean; capabilities: string[]; precheck?: boolean; summary?: string; remote?: RemoteToolTarget }[];
    model: string | null;
    think: boolean | null;
    maxSteps: number;
    /** opt-in: STREAM the model's thinking/reply live (emits `agent-stream` deltas) so a long reasoning phase
     *  shows its text instead of a frozen token count. Default false — the loop uses a single non-streamed call. */
    stream?: boolean;
    /** trusted config flag → the background may auto-approve readonly python */
    autoApprovePython: boolean;
    /** config flag → auto-approve a same-origin as-you (credentialed) fetch (the security gate is enforced
     *  background-side from getConfig too, so a forged value only affects the prompt, never the actual fetch) */
    autoApproveSameOriginAuth?: boolean;
    /** config flag → auto-approve an uncredentialed read of the agent's OWN repo source (self-source.ts) */
    autoApproveSelfSource?: boolean;
    /** trusted config flag → the background may auto-approve an in-dialect exec survey */
    autoApproveReadonly: boolean;
    /** agent option → surface `@tool:<id>` tokens on rich tool results (so the model can cite exact outputs) */
    toolTokens?: boolean;
    /** headless run: the background refuses (never prompts) any call that reaches the gate */
    unattended?: boolean;
    /** scripting run: the off-mode HUD card stays hidden for it (no working orb, no answer card). The
     *  background streams it to the card as usual; the card reads this and suppresses itself. Approvals
     *  still surface (privileged consent can't be silenced). */
    silent?: boolean;
    /** A createAgent handle's prior history: when present, the background CONTINUES it (appends `task`)
     *  instead of building a fresh system+task — so the page-side control.messages stays authoritative
     *  across turns (the run's final history rides back in the response). Empty/absent → a fresh first turn
     *  (and the background announces the `agent` session start; a continuation does not, avoiding a reset). */
    resumeMessages?: NeutralMessage[];
    /** Native-vision composer attachments (data URLs) for THIS turn's user message. Resolved page-side
     *  (a text-only driver's OCR fallback is already folded into `task`), so this is only the see-natively
     *  path — the background attaches them to the task turn. */
    images?: string[];
    /** Offsets for this turn's step/seq numbers so the sidebar's turn groups stay distinct across a
     *  handle's turns (the background-path twin of the page loop's control.stepBase/seqBase). The run's own
     *  max step/seq ride back in the response so the page can advance them for the next turn. */
    stepBase?: number;
    seqBase?: number;
    /** Which lexical metric ranks a near-miss on a pointer label (config `labelMatch`); carried so a
     *  background-hosted run resolves labels the same way a page-hosted one does. */
    labelMatch?: LexicalMetric;
    /** Which surface hosts the run's gate/stream (all route through the background): a debug surface
     *  (overlay/devtools) streams steps + gates in the sidebar app; "off" also streams the SAME steps to
     *  the page, where the content-script shell renders them in a lazily-mounted acrylic corner CARD (a
     *  curated view of the run). Every surface gates through the same origin-authed SET_APPROVAL. */
    surface: "overlay" | "devtools" | "off";
    /** where privileged gates are resolved: "ui" (default, human clicks a surface), "both" (UI + the SW-only
     *  __mlApprovals IPC channel), or "external" (channel only — UI buttons suppressed). Opt-in: only
     *  "both"/"external" gates are listed/resolvable by the channel. */
    approvalRouting?: "ui" | "both" | "external";
    /** the page's origin when the run started — seeds the run's consented-origins so a same-site nav needs no
     *  prompt while a NEW cross-origin one does (the cross-origin consent gate). */
    pageOrigin?: string;
    /** The full start URL + title, for the run's `agent` start event. `pageOrigin` exists for the
     *  cross-origin consent gate and is deliberately only an origin; this is for provenance. */
    pageUrl?: string;
    pageTitle?: string;
    /** may this run navigate to OTHER SITES? false → the `navigate` tool refuses cross-origin; true → a new
     *  cross-origin nav gates for consent (see navNeedsConsent). */
    crossOrigin?: boolean;
    /** cross-page persistence: false → this run does NOT survive a navigation (the background skips tracking
     *  it against its tab, so a nav ends it). Default (absent/true) → the navigation barrier holds delegated
     *  tools across a same-site nav until the new document re-adopts the run. Set false by `navigate: false`. */
    crossPage?: boolean;
    /** Enough of the PAGE-resolved run state to rebuild its BUILTIN toolset on a fresh document after a
     *  same-site navigation (cross-page persistence). The background stores it while the run is live and
     *  sends it back on re-adopt; the new page's `_adoptRun` reconstructs + re-registers the toolset. Only
     *  builtin tools cross a nav (custom function tools don't serialize), so this is names + vision facts. */
    rebuild?: RebuildConfig;
}

/** The serializable state a fresh document needs to rebuild a background-hosted run's BUILTIN toolset after
 *  a same-site navigation (see StartRunPayload.rebuild). Vision facts are CARRIED from the original build,
 *  not re-probed, so native-vs-delegated `look` on the new page matches the original run exactly. */
export interface RebuildConfig {
    /** the run's builtin tool NAMES (custom function tools are excluded — they can't cross a nav) */
    toolNames: string[];
    /** the run's driver model (for the re-registered ToolContext) */
    model: string | null;
    /** does the driver's own model see pixels natively (native vs delegated look/locate feedback) */
    driverSees: boolean;
    /** the resolved vision reader a delegated sub-call uses (null = none) */
    visionModel: string | null;
    /** grounding model + coordinate range, for rebuilding `locate` (null model = Set-of-Marks only) */
    groundingModel: string | null;
    groundingRange: number;
    /** re-apply the closed-shadow-piercing module flag on the new document */
    pierceClosed: boolean;
    /** re-apply the CDP-trusted-input module flag (trusted click/type for canvas/opaque targets) */
    cdp: boolean;
    /** may the rebuilt `navigate` tool cross origins? (carried so cross-site nav keeps working after a nav) */
    crossOrigin: boolean;
}

/** SET_APPROVAL payload — the sidebar app's decision for a pending background-run approval, keyed by
 *  the run + the step's `seq`. Origin-authed: the shell only forwards it when the message came from the
 *  real extension-origin iframe (e.source === frame.contentWindow), which a page can't forge. */
export interface SetApprovalPayload {
    runId: string;
    seq: number;
    decision: boolean;
    feedback?: string;
    /** button #3: on a positive decision, ALSO persist the gated call's static egress grants for the
     *  session (the background re-derives them from the call — this is just the "remember it" intent). */
    persist?: boolean;
}

/** CANCEL_RUN payload — abort a background-hosted run by id (the HUD's "Cancel agent run"). Harmless
 *  even if a page could forge it (worst case it aborts its own run) — the loop resolves { cancelled }. */
export interface CancelRunPayload {
    runId: string;
}

/** RESUME_RUN payload — continue a stored background-hosted run with a follow-up turn. The background
 *  holds that run's history + config (keyed by runId); the page just names it + the new task. Only the
 *  tab that owns the run may resume it (checked background-side), and its tools must be re-registered
 *  page-side first (endRun cleared them after the prior turn). */
export interface ResumeRunPayload {
    runId: string;
    task: string;
    /** a budget chosen for this continuation; omitted keeps the one the run was started with */
    maxSteps?: number;
}

/** INJECT_MESSAGE payload — a.say() steering a RUNNING background run: the text is pushed into that
 *  run's inbox and injected as a user turn at the next step boundary (the SW-side twin of the page
 *  loop's control.inbox). Only affects a live run in the owning tab; unknown runId is a no-op. */
export interface InjectMessagePayload {
    runId: string;
    text: string;
    /** A stable id for this steer message, minted page-side, so the SW can fan an `agent-say-seen`
     *  event (the "seen" indicator) keyed to the same bubble when the loop actually drains it. */
    sayId?: string;
}

/** RUN_TOOL_IN_PAGE payload — run a named tool from an active agent run's page-side toolset. The
 *  `callId` correlating the window round-trip is minted content-side (not here); the background
 *  correlates its own request via the sendMessage callback. */
export interface RunToolInPagePayload {
    runId: string;
    name: string;
    args: Record<string, unknown>;
    /** Render-only: DON'T run the tool — just compute its In render (descriptorFor) for the approval
     *  preview, so a blocking gate shows a pretty In (e.g. exec's beautified JS, python's code cell)
     *  instead of raw args. The tool's run() never fires, so this is side-effect-free. */
    renderOnly?: boolean;
    /** Read-only try (design A, exec only): attempt the call via the mediated read-only interpreter
     *  (evalReadonly — no eval, no mutation). If it's in-dialect it BOTH decides "auto-approve" AND
     *  produces the result, so the background can skip the human gate; out-of-dialect → falls through.
     *  Side-effect-free either way (the interpreter can't mutate), which is why it needn't be gated. */
    readonlyTry?: boolean;
    /** Doomed-action precheck (design A, click/type): run the tool's side-effect-free precheck (resolve
     *  the target). A non-null error means the action can only fail → the background SKIPS the human gate
     *  and returns it. The tool's run() never fires; the precheck must not mutate the DOM. */
    precheck?: boolean;
}

/** The result of a delegated tool call, crossing back from the page to the background. Only the
 *  SERIALIZABLE parts of a {@link ToolResult} survive the window bus: the result string, a screenshot
 *  data-URL, the render descriptors (plain data), and an element COUNT. The real DOM Nodes an
 *  answer-capable tool returns can't cross — they stay page-side and are assembled into
 *  {@link AgentResult}.elements there. */
export interface PageToolEnvelope {
    result: string;
    /** real nodes stay page-side; the background only learns how many */
    elementCount?: number;
    /** answer's serialized element visuals (data URLs) — cross the bus to the background → the HUD card */
    answerMedia?: AnswerMedia[];
    /** screenshot data-URL (inline vision — reserved for the parity work) */
    image?: string;
    imageLabel?: string;
    /** MULTIPLE inline-vision images from one call (look's overlay + no-overlay) — the background loop
     *  pushes each to the driver's next turn, same as the page path. */
    images?: { image: string; label?: string }[];
    /** In slot — a visualization of the call. The debug-render slots are computed PAGE-SIDE
     *  (descriptorFor) since the tool's render() method + its live envelope live there — so a
     *  background-hosted run shows the same rendered In/Out as the page. */
    renderIn?: RenderDescriptor;
    /** Out slot — a visualization of the result */
    renderOut?: RenderDescriptor;
    /** what locate fed into the model's context (snap-inject) — computed page-side, surfaced in the render + export */
    feedback?: ToolFeedback;
    /** THE EXECUTOR'S OWN CLOCK — a sandbox's cold start and script time, a remote tool's evaluate and queue.
     *  It has to cross with the result: the background measures wall time around the whole dispatch, which
     *  contains the network and the far end's overhead, so without this the timeline can only draw one
     *  undifferentiated span and a first `python_exec` reads as a slow script rather than as a runtime
     *  being downloaded. */
    remoteMs?: RemoteTiming;
    /** a readonlyTry that the mediated interpreter HANDLED (→ auto-approve) */
    readonly?: boolean;
    /** prior grants a readonlyTry REUSED (cached ml.fetch URLs) — surfaced as the "reused a grant" note on
     *  the step, so a background-hosted run explains why it auto-ran, same as the page path. */
    reused?: ReusedGrant[];
    /** a precheck that found the action doomed (no target) → skip the gate, use `result` */
    precheckFailed?: boolean;
    /** RESERVED-surface click: the page-side tool couldn't synth-click a cross-origin iframe / sealed shadow
     *  target and needs a CDP click at this viewport coordinate — the BACKGROUND (trusted) does it. `hint` is
     *  an optional stuck-loop re-snap nudge the background appends to the click result. */
    cdpClick?: { x: number; y: number; hint?: string; verify?: boolean };
    /** STRICT-PAGE exec: main-world eval was blocked by the page's CSP/Trusted-Types, so the background re-runs
     *  the same approved `source` via CDP `Runtime.evaluate` (debugger is CSP-exempt). See EXEC_STRICT_CSP.md. */
    cdpExec?: { source: string };
    /** SEALED-SHADOW click: the page-side tool couldn't enter a closed/declarative shadow root to click a `>>>`
     *  target, so the BACKGROUND (trusted) CDP-resolves the selector (piercing the closed root) and clicks it. */
    cdpShadowClick?: { selector: string; index?: number; verify?: boolean };
    /** TRUSTED-KEYBOARD type: the BACKGROUND types `text` via CDP (real key events) into a sealed `>>>` field
     *  (`selector`), an `@pt` (`x,y`, clicked first to focus), or the current focus (neither) — for canvas /
     *  WebGL / remote-desktop targets where synthetic KeyboardEvents don't register. `cdp`-gated. */
    cdpType?: { text: string; submit?: boolean; append?: boolean; x?: number; y?: number; selector?: string; index?: number; verify?: boolean; verifyElement?: string; verifyFocus?: boolean };
    /** DELEGATED vision sub-call tokens spent BY THIS tool call (look/locate/verify's own ml.chat) — a DELTA
     *  measured around the page-side run, so the background loop can accumulate the per-turn tally its meta
     *  tool + UI report (the page meter, bus.ts, lives page-side and the SW loop can't read it directly). */
    subUsage?: SubcallUsage;
}

/** A resumable chat session persisted to chrome.storage.local for { save: true }
 *  sessions (main world can't touch storage → background round-trip). No secrets:
 *  just the message history + the createChat options needed to continue it. */
export interface StoredSession {
    hash: string;
    messages: NeutralMessage[];
    model: string | null;
    extend: ExtendProfile | null;
    numCtx: number | null;
    numGpu: number | null;
    think: boolean | null;
    schema: JsonSchema | null;
    toolIds: string[] | null;
    maxTokens: number | null;
    save: boolean;
}

/** FETCH_LLM payload (the main one). `save` is sidebar-only and stays page-side. */
export interface FetchLlmPayload {
    messages: NeutralMessage[];
    model?: string | null;
    /** resolved server-side from the utility-model config */
    extend?: ExtendProfile | null;
    numCtx?: number | null;
    numGpu?: number | null;
    think?: boolean | null;
    schema?: JsonSchema | null;
    toolIds?: string[] | null;
    maxTokens?: number | null;
    tools?: unknown[];
    raw?: boolean;
    ocr?: boolean;
    /** What this request is for ({@link RequestHint}); the service worker sanitizes it and adds what only it
     *  knows (whether this browser's traffic is synthetic). */
    hint?: RequestHint | null;
}

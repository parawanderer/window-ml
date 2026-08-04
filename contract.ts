/**
 * @file Shared interfaces for window.ml — the contracts the main-world primitive
 * (injected), the content-script relay (content), the background worker
 * (background), and the debug sidebar all agree on. Types only; erased at build.
 * Import with `import type { ... } from "./contract"` so nothing survives to JS.
 */

/* ------------------------------- config ------------------------------- */

export type ApiFormat = "openai" | "ollama";
export type Theme = "auto" | "dark" | "light";
/** Which corner the off-mode approval card / working pill anchors to. */
export type CardCorner = "bottom-right" | "bottom-left" | "top-right" | "top-left";
/** The on-page corner HUD's verbosity: "progress" shows the working pill while an agent runs (+ the
 *  approval card + answer); "quiet" drops the idle pill and only surfaces the card for an approval /
 *  the final answer. (An approval can never be fully suppressed — it's the trusted gate.) */
export type AgentHud = "progress" | "quiet";
/** Where the debug UI renders: nowhere (zero cost), the in-page overlay (content-script
 *  shadow-root shell), or the DevTools "window.ml" panel only (no in-page overlay). In
 *  devtools mode the shell still forwards events to the background so the panel receives them. */
export type DebugMode = "off" | "overlay" | "devtools";
/** A user's override for whether a model sees images natively: "" = auto-discover (probe Ollama
 *  /api/show), "yes"/"no" = declared. Used for the default model, to enable NATIVE vision on a
 *  cloud/non-Ollama model the probe can't describe. */
export type VisionSupport = "" | "yes" | "no";

/** Full config held in chrome.storage.sync (background + popup own it). */
export interface MlConfig {
    chatUrl: string;
    apiKey: string;
    /** The default model the user has configured for tasks, used when no model is specified for ml.chat("…") or ml.agent("…"). May not always be set. */
    model: string;
    apiFormat: ApiFormat;
    /** OCR/vision model used for vision tasks by default, e.g. in ml.read(…). May not always be set. */
    ocrModel: string;
    /** Whether the DEFAULT `model` sees images natively — an override for the auto-probe. "" = auto-discover
     *  (read Ollama /api/show); "yes"/"no" = declared. Only consulted when the probe is inconclusive (cloud /
     *  non-Ollama models), so it's the one way a cloud model can use NATIVE vision (e.g. gpt-4o in the HUD).
     *  For an Ollama model whose capability we can read, detection wins and the setting is moot (flagged in UI). */
    defaultModelVision: VisionSupport;
    /** Optional regex WHITELIST: when set, the wrapper only calls models whose id
     *  matches it (every resolved model — main/ocr/grounding/utility). Empty = no filter. */
    modelFilter: string;
    /** where the debug UI renders (off / in-page overlay / DevTools panel) */
    debugMode: DebugMode;
    theme: Theme;
    /** which screen corner the off-mode approval card + working pill anchor to */
    cardCorner: CardCorner;
    /** corner HUD verbosity: "progress" (pill while running) or "quiet" (approvals only) */
    agentHud: AgentHud;
    /** also show the corner HUD alongside the DevTools panel (coexist) */
    agentHudInDevtools: boolean;
    /** Small "utility" model for cheap side tasks (e.g. session-title summaries).
     *  Empty → fall back to the main `model`. numCtx/forceCpu apply only when set. */
    utilityModel: string;
    /** context window for the utility model (Ollama num_ctx) */
    utilityNumCtx: number;
    /** run it on CPU (num_gpu: 0) so it can't evict the main model */
    utilityForceCpu: boolean;
    /** let the utility model summarise session titles in the debug sidebar */
    autoTitles: boolean;
    /** experimental: auto-approve read-only exec surveys via the mediated interpreter */
    autoApproveReadonly: boolean;
    /** experimental: auto-approve python_exec (the sandbox is isolated by construction) */
    autoApprovePython: boolean;
    /** Hostnames the USER has trusted to supply their OWN ml.agent approval gate (a page's
     *  `approve` callback / the page-loop confirm). Empty by default: EVERY other origin's
     *  privileged tool calls route through the unforgeable background gate + trusted surface,
     *  so a hostile page can't self-approve. Managed only in the trusted Settings/popup UI; the
     *  page never sees this list — GET_CONFIG returns only a computed `pageApprovalAllowed` for
     *  the requesting tab's own origin. Exact-hostname match (e.g. "docs.google.com"). */
    pageApprovalDomains: string[];
    /** Optional visual-grounding model for ml.agent's `locate` tool (coordinate
     *  output). OFF by default — enabling loads a 3rd model into VRAM, so it's opt-in. */
    groundingEnabled: boolean;
    /** e.g. qwen2.5vl:7b; empty + enabled → auto-detect a qwen2.5vl on the server */
    groundingModel: string;
    /** Coordinate range the grounding model outputs (the divisor for its x,y). The
     *  screenshot is sent as a 1000×1000 square, so this one number covers every
     *  convention: 1000 (0–1000 normalized, or qwen2.5vl absolute-pixels-of-the-sent
     *  image), 100 (Molmo percent), 1024 (PaliGemma/Florence tokens). */
    groundingRange: number;
}

/** Default grounding coordinate range / the square size the screenshot is sent at.
 *  One value: the image is sent at this many px, so a PIXEL model (qwen2.5vl) outputs
 *  0–this — the same space a 0–1000-NORMALIZED model uses. Override the config range
 *  only for a different convention (100 = percent, 1024 = tokens). */
export const DEFAULT_GROUNDING_RANGE = 1000;

/** Context window (num_ctx) for DELEGATED one-off vision sub-calls — OCR, grounding,
 *  the delegated `look`, and their liveness probes. A screenshot + a short reply needs
 *  only a few thousand tokens, but a vision model's DEFAULT context auto-sizes to its
 *  full window on a big-VRAM box (qwen2.5vl → 128K), pre-allocating tens of GB of KV
 *  cache. Capping it bounds a FRESH load. NOT applied to the native look (that reuses
 *  the agent's own model, which needs its full conversation context). Shared so the
 *  page (util/builtin-tools) and the sidebar's model-test both cap identically. */
export const VISION_NUM_CTX = 8192;

/** The crop transform of a raw element/region screenshot: the crop's top-left in VIEWPORT (CSS) px
 *  and the devicePixelRatio it was captured at. A pixel (px,py) in that image maps to viewport CSS
 *  `left + px/dpr`, `top + py/dpr` — so a python_exec coordinate (computed in image pixels) can be
 *  projected back to the viewport for a clickable @pt/@box (see util.ts projectShotPoint/Box). */
export interface ShotBox { left: number; top: number; dpr: number; }

/** Whether a model id passes the optional `modelFilter` regex whitelist. Empty /
 *  whitespace filter → everything allowed. An INVALID regex → everything allowed
 *  (fail-OPEN: a typo shouldn't silently brick every call; the settings UI flags an
 *  invalid regex separately so the user knows the guard is inactive). Otherwise
 *  `regex.test(model)`. Pure; shared by the background enforcement, the LIST_MODELS
 *  filter, and the settings row/datalist indicators so they all agree. */
export function modelFilterAllows(model: string, filter: string): boolean {
    if (!filter || !filter.trim()) return true;
    try { return new RegExp(filter).test(model); } catch { return true; }
}

/** Single source of truth for config defaults — imported by background.ts,
 *  popup.ts, and the sidebar app so the three can't drift.
 *  - chatUrl: OpenWebUI's OpenAI-compatible endpoint. No root /v1 alias (tested
 *    0.9.5/0.10.2); /api/chat/completions is broken on 0.9.5 (issue #24550).
 *  - apiKey: bearer token (OpenWebUI → Settings → Account).
 *  - ocrModel/utilityModel: empty → fall back to `model`.
 *  - utilityForceCpu: run the utility model on CPU (num_gpu: 0) so it can't
 *    evict the main model from VRAM. */
export const DEFAULT_CONFIG: MlConfig = {
    chatUrl: "http://localhost:3000/api/chat/completions",
    apiKey: "",
    model: "",
    apiFormat: "openai",
    ocrModel: "",
    defaultModelVision: "",
    modelFilter: "",
    debugMode: "off",
    theme: "auto",
    cardCorner: "bottom-right",
    agentHud: "progress",
    agentHudInDevtools: false,
    utilityModel: "",
    utilityNumCtx: 4096,
    utilityForceCpu: false,
    autoTitles: true,
    autoApproveReadonly: false,
    autoApprovePython: false,
    pageApprovalDomains: [],
    groundingEnabled: false,
    groundingModel: "",
    groundingRange: DEFAULT_GROUNDING_RANGE,
};

/** First qwen2.5vl on a server model list (7b → 3b → any qwen*vl) — the grounding
 *  model auto-detect used when the field is blank. "" if none present. Pure; shared
 *  by the settings UI and ml.agent so they resolve the same effective model. */
/** A loaded context window as a compact label: 262144 → "256K", 8192 → "8K", 900 → "900".
 *  Powers of two land exact; anything else keeps one decimal (49152 → "48K", 40000 → "39.1K").
 *  Shared by the sidebar VRAM rows and the popup readout so both read the same. Pure. */
export const fmtCtx = (n: number): string => {
    if (n >= 1024 * 1024) return `${+(n / (1024 * 1024)).toFixed(1)}M`;
    if (n >= 1024) return `${+(n / 1024).toFixed(1)}K`;
    return String(n);
};

export const detectGroundingModel = (models: string[]): string =>
    models.find(m => m === "qwen2.5vl:7b") || models.find(m => m === "qwen2.5vl:3b") || models.find(m => /qwen.*vl/i.test(m)) || "";

/** The non-secret subset GET_CONFIG exposes to the page (never the URL/key). `debugMode` is here so
 *  ml.agent can decide whether to route a run through the unforgeable BACKGROUND loop (design A —
 *  when a debug surface is enabled) or the in-page loop (off). It's UI state, not a secret. */
export type MlPublicConfig = Pick<MlConfig,
    "model" | "ocrModel" | "apiFormat" | "utilityModel" | "utilityNumCtx" | "utilityForceCpu" | "autoApproveReadonly" | "autoApprovePython" | "groundingEnabled" | "groundingModel" | "groundingRange" | "debugMode" | "defaultModelVision"> & {
    /** COMPUTED per request (not stored): whether THIS page's origin is on the user's page-approval
     *  whitelist. When true, ml.agent honours the page's own approve()/confirm gate (the user trusts this
     *  domain); otherwise a privileged tool routes to the unforgeable background gate. The raw domain
     *  list is NEVER sent to the page — only this one boolean for the page's own origin. */
    pageApprovalAllowed?: boolean;
};

/* --------------------------- chat wire shapes -------------------------- */

export type Role = "system" | "user" | "assistant" | "tool";

/** Neutral message shape; each API format converts it to its wire form. */
export interface NeutralMessage {
    role: Role;
    content: string | null;
    /** full data URLs */
    images?: string[];
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    /** OpenWebUI tool/RAG provenance */
    sources?: unknown[];
}

/** Normalized tool call — `{ id, name, arguments }` regardless of backend. */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown> | string;
}

/** Token accounting for ONE request, when the server reports it (OpenWebUI returns a
 *  `usage` block; Ollama-native returns prompt_eval_count/eval_count).
 *
 *  IMPORTANT: `promptTokens` already covers the WHOLE conversation — every turn
 *  re-sends the full history — so live context occupancy is
 *  `promptTokens + completionTokens` of the LATEST call, never a sum across turns
 *  (summing would overcount quadratically). Only cumulative SPEND is a sum. */
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface LlmResult {
    content: string;
    sources?: unknown[] | null;
    /** the model actually used, after server-side resolution (extend/ocr/default) */
    model?: string | null;
    /** separate reasoning/thinking text (reasoning_content / message.thinking) */
    reasoning?: string | null;
    /** token counts, when the server reports them */
    usage?: TokenUsage | null;
}

/* ----------------------------- tools / agent --------------------------- */

export interface JsonSchema {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    enum?: unknown[];
    [k: string]: unknown;
}

/** A tool's return: a string, or an envelope also carrying live DOM nodes
 *  (`elements`, debug-only) and/or a screenshot (`image`, inline vision). A tool
 *  that computes its own visualization (e.g. `locate`'s badged Set-of-Marks
 *  image) returns a `render` descriptor directly — shown in the sidebar but, unlike
 *  `image`, NOT injected into the model's history (it's a debug artifact). */
export interface ToolResult {
    content: string;
    elements?: Node[];
    image?: string;
    imageLabel?: string;
    /** the Out slot: a visualization of the result (e.g. locate's marks) */
    render?: RenderDescriptor;
    /** the In slot: a visualization of the CALL (e.g. python's notebook-cell header) */
    renderIn?: RenderDescriptor;
}

/** One stage of a `locate` run: a vision sub-call (grid cell-pick, Set-of-Marks pick,
 *  grounding box) or a non-model DOM snap. A sub-call carries its `prompt` (In), the
 *  model's raw `output` (Out), the exact `rawImage` sent, and a human `image` overlay
 *  (the raw⇄visualise toggle). A DOM snap carries just `image` + `label` (no prompt). */
export interface LocateSubstep {
    /** header after the [N] badge, e.g. "Cell pick · grid 5×3 · model chose cell 12" */
    label: string;
    /** grey-italic explanation shown ABOVE this substep (e.g. why a hand-off happened) */
    note?: string;
    /** In: the prompt sent to the model (collapsible) */
    prompt?: string;
    /** Out: the model's raw reply (collapsible) */
    output?: string;
    /** the visualise (human overlay) view — shown by default */
    image?: string;
    /** the exact image sent to the model; its presence enables the raw⇄visualise toggle */
    rawImage?: string;
}

/** A serializable description of how to render a tool step in the debug sidebar.
 *  Data, never code — it crosses the window bus and the sidebar owns the actual
 *  UI (safe: only known `type`s render; unknown/absent → the default In:/Out:
 *  view). A tool's `render` produces one page-side; built-ins auto-derive
 *  image/elements from the envelope. */
/** Where a `python_exec` DataFrame came from — for the debug render's source label + tooltip.
 *  `dom` = a table on the current page (label = the selector); `sheet-current` = the Google Sheet
 *  you're on (label = its page title); `sheet-external` = a Google Sheet fetched by URL with the
 *  user's approval (label = its spreadsheet id). */
export interface TableSource { kind: "dom" | "sheet-current" | "sheet-external"; label: string; name?: string | null; }
/** One loaded DataFrame for the `python-in` render: its variable name, its source, and either a
 *  rows preview (`columns`+`rows`) or `html: true` (loaded via `pd.read_html`, no clean preview). */
export interface TablePreview { name: string; source: TableSource; columns?: string[]; rows?: (string | number | null)[][]; html?: boolean; }

export type RenderDescriptor = (
    | { type: "image"; src: string; label?: string }
    | { type: "code"; text: string; lang?: string; format?: boolean }   // format: let the sidebar beautify the source (e.g. exec's JS)
    | { type: "table"; columns: string[]; rows: (string | number)[][] }
    | { type: "keyval"; pairs: [string, string][] }
    | { type: "elements"; items: { path: string; text?: string; index?: number }[] }
    // `locate`'s debug view as an ordered list of SUBSTEPS — each is one vision
    // sub-call (grid cell-pick, Set-of-Marks pick, grounding box) OR a non-model DOM
    // snap. The sidebar renders each with an In(prompt)/image(raw⇄visualise)/Out block,
    // mirroring the tool In/Out mechanics, so a multi-call locate (e.g. grid → hand-off)
    // reads as its distinct stages. `picked`/`pickedBy` are the final result.
    | {
        type: "locate"; mode: "grounding" | "marks" | "grid" | "grid-grounding"; model: string;
        substeps: LocateSubstep[];
        picked?: string;                    // the chosen element (role/name → selector), or none
        pickedBy?: "model" | "snap";        // model → "Model picked" (a badge); snap → "Snapped to" (DOM hit-test)
      }
    // `python_exec`'s In slot: a notebook-cell header — the run mode (from `cast`), the
    // input screenshot the script saw, the Python source (highlighted, NOT beautified), and
    // the loaded DataFrame(s) — each with its variable name + provenance (which sheet/table).
    | { type: "python-in"; mode: "script" | "pt" | "box"; code: string; image?: string; imageToken?: string; tables?: TablePreview[] }
    // `python_exec`'s Out slot: captured stdout, a returned image, a minted @pt/@box token,
    // the raw/JSON value, or a Python traceback.
    | { type: "python-out"; stdout?: string; image?: string; token?: string; value?: string; error?: string; df?: { columns: string[]; rows: (string | number | null)[][] } }
    // A DELEGATED `look`'s Out slot: the exact image the vision reader saw, WHICH model read it, and
    // its text output — so a sub-call look reads like `locate`'s substeps (the native look just shows
    // the screenshot, since the agent itself is the viewer).
    | { type: "look"; image: string; model?: string | null; output: string; label?: string }
    // A tool's INTENT for the user-facing approval card — the deterministic, human-readable description
    // of what the call will DO, produced by the tool's own `render` (so a custom approval-gated tool can
    // describe itself; a tool that returns none falls back to a utility-model description). `verb` is the
    // action ("Click"/"Type"), `kind` the noun ("button"/"link"/"field"/"point"), `target` the human
    // label (accessible name/text), `selector` the page target to HIGHLIGHT (CSS or @pt/@box), `input`
    // any value being entered (type), `note` an extra clause ("then submit"). Rendered in the debug In
    // slot too (as a hoverable line), so both surfaces agree.
    | { type: "action"; verb: string; kind?: string; target?: string; selector?: string; input?: string; note?: string }
);
// The slot a descriptor fills is decided by which hook produced it (a tool's `render()`
// method / run()-returned `renderIn` → the In slot; a run()-returned `render` / an
// auto-derived image/elements → the Out slot) — not by a field on the descriptor.

/** Input to a tool's `render`: the run's stringified result + the raw envelope
 *  extras (live nodes/image), plus the call args. Runs page-side. */
export interface ToolRenderInput {
    result: string;
    elements?: Node[];
    image?: string;
    imageLabel?: string;
    /** an Out render the tool's run() precomputed (wins over auto-derive) */
    render?: RenderDescriptor;
    /** an In render the tool's run() precomputed (wins over the render() method) */
    renderIn?: RenderDescriptor;
}

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
    run: (args: any) => string | ToolResult | Promise<string | ToolResult>;
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
}

export interface ApprovalRequest {
    tool: string;
    arguments: Record<string, unknown>;
}

/** The approval-gate contract: a boolean, or a rich object that can feed a
 *  rejection comment back to the model and/or edit the args before running. */
export type ApprovalDecision =
    | boolean
    | { approved: boolean; feedback?: string; arguments?: Record<string, unknown> };

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

export interface AgentResult {
    summary: string;
    steps: number;
    transcript: AgentTranscriptEntry[];
    /** nodes designated via an answer-capable tool */
    elements: Node[];
    hitCap?: boolean;
    /** the caller aborted via opts.signal (partial transcript preserved) */
    cancelled?: boolean;
    /** the run's session hash — pass to ml.agent(task, { resume }) to continue it */
    hash: string;
}

/** One live tracer event from ml.agent's `onStep` (a transcript entry + the
 *  step index). Also the shape ml._logStep consumes. */
export interface AgentStepEvent extends AgentTranscriptEntry {
    step: number;
}

/** Options for the low-level ml.step turn. */
export interface StepOptions {
    /** client-side tool definitions */
    tools?: unknown[];
    model?: string | null;
    think?: boolean | null;
    /** abort kills the in-flight model fetch and rejects the call */
    signal?: AbortSignal | null;
}

/** Options for ml.agent — the loop, whitelist, cap and approval gate. */
export interface AgentOptions {
    /** tool registry (default ml.domTools) */
    tools?: MlTool[] | null;
    /** appended to `tools` */
    extraTools?: MlTool[];
    /** REPLACES the built-in preamble */
    system?: string | null;
    /** APPENDED to the built-in preamble */
    hints?: string | null;
    maxSteps?: number;
    model?: string | null;
    think?: boolean | null;
    approve?: (req: ApprovalRequest) => boolean | ApprovalDecision | Promise<boolean | ApprovalDecision>;
    onStep?: ((ev: AgentStepEvent) => void) | null;
    /** prepend page-context note to the system prompt */
    env?: boolean;
    /** auto-wire a `look` tool (null = probe) */
    vision?: boolean | string | null;
    /** install the built-in console tracer */
    logDebug?: boolean;
    /** abort the loop between steps → resolves { cancelled: true } with the partial run */
    signal?: AbortSignal | null;
    /** continue the run with this hash: append `task` as a follow-up turn (same session) */
    resume?: string | null;
    /** scripting mode: keep this run OUT of the in-page HUD (no working orb, no answer card). Approvals STILL surface (privileged consent can't be silenced). The debug sidebar/panel is unaffected. */
    silent?: boolean;
    /** headless mode: no human to approve, so any approval-gated call is REFUSED with a steer to read-only. exec/python_exec are wired ONLY when their auto-approve config is on (read-only survey / sandbox), and told full/mutating use is disabled; otherwise dropped. Auto-approvable read-only ops still run. */
    unattended?: boolean;
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
     *  session). Rejects if a loop is already in flight. With no task, runs over whatever say() has queued. */
    run(task?: string): Promise<AgentResult>;
    /** put a user message into the session: MID-RUN it steers (injected at the next step boundary); IDLE it
     *  appends to history for the next run() (with a console note). Never throws. */
    say(text: string): void;
    /** abort the in-flight loop → it resolves { cancelled: true }. */
    cancel(): void;
    /** a NEW handle (fresh hash) seeded with a COPY of this history — diverge without touching this one. */
    fork(): MlAgentHandle;
}

/* ----------------------------- call options ---------------------------- */

/** Config "profile" a call extends. "utility" pulls model + num_ctx/num_gpu
 *  from the saved utility-model config (falling back to the default model when
 *  none is set); "default"/omitted is the plain default-model behaviour.
 *  Explicit options always override the profile ({ ...profile, ...explicit }). */
export type ExtendProfile = "default" | "utility";

export interface ChatOptions {
    system?: string | null;
    model?: string | null;
    extend?: ExtendProfile | null;
    /** Ollama num_ctx (context window); ollama format only */
    numCtx?: number | null;
    /** Ollama num_gpu (0 = force CPU); ollama format only */
    numGpu?: number | null;
    think?: boolean | null;
    images?: (string | HTMLImageElement)[];
    schema?: JsonSchema | null;
    toolIds?: string[] | null;
    maxTokens?: number | null;
    save?: boolean;
    onToken?: (delta: string, full: string) => void;
    /** abort the request (streaming disconnects the Port; both kill the fetch) */
    signal?: AbortSignal | null;
}

/** A stateful multi-turn chat (the object ml.createChat returns). Its methods'
 *  `this` is the history object itself — annotate ml.createChat's return type as
 *  `MlHistory` so `this.model` / `this.messages` resolve (do NOT rewrite `this`
 *  to the captured `ml`; that's window.ml, a different object). */
export interface MlHistory {
    messages: NeutralMessage[];
    hash: string;
    model: string | null;
    extend: ExtendProfile | null;
    numCtx: number | null;
    numGpu: number | null;
    think: boolean | null;
    schema: JsonSchema | null;
    toolIds: string[] | null;
    maxTokens: number | null;
    save: boolean;
    chat(this: MlHistory, prompt: string, opts?: ChatOptions): Promise<string | Record<string, unknown>>;
    fork(this: MlHistory): MlHistory;
}

/* ------------------- relay contract (page ⇄ content ⇄ background) ------------------- */

/** Page-side request types posted over window.postMessage (content.js maps
 *  each to its BackgroundMessageType counterpart via HANDLE_MAP). */
export type PageRequestType =
    | "LLM_REQUEST" | "LLM_STREAM_REQUEST" | "B64_REQUEST" | "LIST_MODELS_REQUEST"
    | "GET_MODEL_REQUEST" | "CONFIG_REQUEST" | "SET_MODEL_REQUEST" | "CAPS_REQUEST"
    | "PS_REQUEST" | "UNLOAD_REQUEST" | "CAPTURE_TAB_REQUEST"
    | "SAVE_SESSION_REQUEST" | "GET_SESSION_REQUEST" | "PYTHON_EXEC_REQUEST" | "FETCH_SHEET_REQUEST"
    | "LIST_SERVER_TOOLS_REQUEST"   // discover the OpenWebUI server-side tools this key may use (valid `toolIds`)
    | "INVOCATION_REQUEST"   // how the user can open the HUD here (live shortcut — user-rebindable, never hardcode it)
    | "START_RUN_REQUEST"   // design A: kick off a background-hosted ml.agent loop
    | "RESUME_RUN_REQUEST"   // design A: continue a background-hosted run (append a follow-up turn to its stored history)
    | "INJECT_MESSAGE_REQUEST"   // a.say() mid-run: steer a RUNNING background loop (its inbox drains at the next step)
    | "CANCEL_RUN_REQUEST"   // a handle cancel()ing its OWN background run: relay CANCEL_RUN so the SW aborts the loop (special-cased, not HANDLE_MAP)
    | "ABORT_REQUEST";   // cancel an in-flight background task by requestId (handled specially, not via HANDLE_MAP)

/** Message types the background worker's onMessage listener handles. */
export type BackgroundMessageType =
    | "FETCH_LLM" | "FETCH_IMAGE_B64" | "LIST_MODELS" | "GET_MODEL" | "GET_CONFIG"
    | "SET_MODEL" | "MODEL_CAPS" | "OLLAMA_PS" | "OLLAMA_UNLOAD" | "CAPTURE_TAB"
    | "SAVE_SESSION" | "GET_SESSION" | "PYTHON_EXEC" | "FETCH_SHEET" | "FETCH_SHEET_TITLE"
    | "LIST_SERVER_TOOLS"   // GET OpenWebUI /api/v1/tools/ — the server-side tools, with their function specs
    | "GET_INVOCATION"   // read chrome.commands' LIVE shortcut for the HUD (+ whether the user rebound it)
    | "ABORT_TASK"    // abort the AbortController registered for a requestId (only FETCH_LLM registers one today)
    | "START_RUN"     // design A: run an ml.agent loop in the background (unforgeable gate); tools delegate to the page
    | "RESUME_RUN"    // design A: continue a stored background run (its history lives in the SW) with a follow-up task
    | "INJECT_MESSAGE"   // a.say() mid-run: push a user message into a RUNNING background run's inbox (steer it live)
    | "SET_APPROVAL"; // design A: the sidebar's approve/deny decision for a pending background-run gate (origin-authed)

/* ------------------- design A: background → page tool delegation ------------------- */

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
    tools: { name: string; description: string; parameters: JsonSchema; requiresApproval: boolean; capabilities: string[]; precheck?: boolean; summary?: string }[];
    model: string | null;
    think: boolean | null;
    maxSteps: number;
    /** trusted config flag → the background may auto-approve readonly python */
    autoApprovePython: boolean;
    /** trusted config flag → the background may auto-approve an in-dialect exec survey */
    autoApproveReadonly: boolean;
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
    /** Offsets for this turn's step/seq numbers so the sidebar's turn groups stay distinct across a
     *  handle's turns (the background-path twin of the page loop's control.stepBase/seqBase). The run's own
     *  max step/seq ride back in the response so the page can advance them for the next turn. */
    stepBase?: number;
    seqBase?: number;
    /** Which surface hosts the run's gate/stream (all route through the background): a debug surface
     *  (overlay/devtools) streams steps + gates in the sidebar app; "off" also streams the SAME steps to
     *  the page, where the content-script shell renders them in a lazily-mounted acrylic corner CARD (a
     *  curated view of the run). Every surface gates through the same origin-authed SET_APPROVAL. */
    surface: "overlay" | "devtools" | "off";
}

/** SET_APPROVAL payload — the sidebar app's decision for a pending background-run approval, keyed by
 *  the run + the step's `seq`. Origin-authed: the shell only forwards it when the message came from the
 *  real extension-origin iframe (e.source === frame.contentWindow), which a page can't forge. */
export interface SetApprovalPayload {
    runId: string;
    seq: number;
    decision: boolean;
    feedback?: string;
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
}

/** INJECT_MESSAGE payload — a.say() steering a RUNNING background run: the text is pushed into that
 *  run's inbox and injected as a user turn at the next step boundary (the SW-side twin of the page
 *  loop's control.inbox). Only affects a live run in the owning tab; unknown runId is a no-op. */
export interface InjectMessagePayload {
    runId: string;
    text: string;
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
    /** screenshot data-URL (inline vision — reserved for the parity work) */
    image?: string;
    imageLabel?: string;
    /** In slot — a visualization of the call. The debug-render slots are computed PAGE-SIDE
     *  (descriptorFor) since the tool's render() method + its live envelope live there — so a
     *  background-hosted run shows the same rendered In/Out as the page. */
    renderIn?: RenderDescriptor;
    /** Out slot — a visualization of the result */
    renderOut?: RenderDescriptor;
    /** a readonlyTry that the mediated interpreter HANDLED (→ auto-approve) */
    readonly?: boolean;
    /** a precheck that found the action doomed (no target) → skip the gate, use `result` */
    precheckFailed?: boolean;
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
}

/** A model resident in Ollama, from OLLAMA_PS. `vramGB` is the portion in VRAM
 *  (null when fully on CPU); `sizeGB` is the total footprint — together they
 *  reveal CPU-only (vram 0) vs partial offload (0 < vram < size) vs full GPU.
 *  `contextLength` is the num_ctx it was LOADED with — Ollama preallocates the
 *  KV cache for the whole window, so it's a big share of `vramGB` (null when the
 *  server is too old to report it). */
/** How the user can invoke the HUD composer on THIS browser, read at runtime (GET_INVOCATION).
 *  The keyboard shortcut is user-rebindable at <scheme>://extensions/shortcuts, so it must never
 *  be hardcoded in a prompt or doc — `shortcut` is whatever is bound right now, `""` when the user
 *  cleared it, and `isDefault` says whether it still matches the manifest's suggested key. */
export interface InvocationInfo {
    /** e.g. "Alt+Space"; "" when the user removed the binding */
    shortcut: string;
    /** the manifest's suggested_key for this platform */
    defaultShortcut: string;
    /** shortcut === defaultShortcut (false also when unbound) */
    isDefault: boolean;
    /** an extension context-menu entry is registered (permission declared) */
    contextMenu: boolean;
}

export interface LoadedModel {
    model: string;
    vramGB: number | null;
    sizeGB: number | null;
    contextLength: number | null;
    expiresAt: string | null;
}

/** One function exposed by an OpenWebUI server-side tool. A tool bundles several
 *  (a Python tool class = one function per method), which is why `toolIds` selects
 *  the BUNDLE while the model calls an individual `name`. */
export interface ServerToolFunction {
    name: string;
    description: string;
    /** JSON-Schema parameters, exactly as the model would be shown them. */
    parameters: JsonSchema | null;
}

/** An OpenWebUI server-side tool, as listed by `ml.serverTools()`. `id` is what you
 *  pass in `ml.chat`'s `toolIds`. `kind` distinguishes a local Python tool from a
 *  proxied OpenAPI/MCP tool server — the servers list as a single entry whose
 *  functions OpenWebUI only resolves at call time, hence the empty `functions`. */
export interface ServerTool {
    id: string;
    name: string;
    description: string;
    kind: "local" | "openapi" | "mcp";
    functions: ServerToolFunction[];
}

/* ------------------- debug sidebar contract (core → sidebar, window bus) ------------------- */

/** Groups turns of one createChat conversation; `turn` is the 0-based index. */
export interface SessionRef {
    hash: string;
    turn: number;
}

export interface DebugChatRequest {
    model: string | null;
    /** so a pending turn can resolve its model from the config before the result lands */
    extend: ExtendProfile | null;
    messages: NeutralMessage[];
    images: string[] | null;
    toolIds: string[] | null;
    schema: boolean;
    think: boolean | null;
    maxTokens: number | null;
}

/** The session's creation config — the options passed to createChat (à la
 *  `ml.createChat({ think: true })`). This is what the sidebar shows as the
 *  "options" block, kept distinct from the per-turn request + message history
 *  (full history is a separate export feature). */
export interface DebugSessionConfig {
    system: string | null;
    model: string | null;
    think: boolean | null;
    schema: boolean;
    toolIds: string[] | null;
    maxTokens: number | null;
    save: boolean;
}

interface DebugBase {
    /** correlates start ↔ result/error */
    id: string;
    ts: number;
    save: boolean;
    session: SessionRef;
}
export interface DebugChatStart extends DebugBase { kind: "chat"; streaming: boolean; request: DebugChatRequest; config: DebugSessionConfig; }
export interface DebugChatResult extends DebugBase { kind: "chat-result"; content: string; sources: unknown[] | null; structured: boolean; model: string | null; extend: ExtendProfile | null; reasoning: string | null; usage: TokenUsage | null; }
export interface DebugChatError extends DebugBase { kind: "chat-error"; error: string; }

/** ml.agent runs: a run-start, one event per step (a thought OR a tool call +
 *  result), then a result. `elements` is a COUNT — real DOM nodes can't cross the
 *  window bus (they reach the console via onStep instead). */
/** The agent run's resolved setup — for the sidebar's "agent options" block. */
export interface DebugAgentConfig {
    /** the resolved system prompt the model actually received */
    system: string;
    /** caller supplied their own `system` (vs the built-in preamble) */
    customSystem: boolean;
    /** description/parameters let the sidebar show the FULL tool definitions (a JSON tree), not just names. */
    tools: { name: string; requiresApproval: boolean; vision?: boolean; description?: string; parameters?: JsonSchema; summary?: string }[];
    maxSteps: number;
    think: boolean | null;
    env: boolean;
    vision: boolean | string | null;
    hints: string | null;
    /** scripting run: kept out of the in-page HUD (the card reads this to stay hidden) */
    silent?: boolean;
    /** headless run: approval-gated calls are refused (no human to approve) */
    unattended?: boolean;
}
export interface DebugAgentStart extends DebugBase { kind: "agent"; task: string; model: string | null; maxSteps: number; config: DebugAgentConfig; }
export interface DebugAgentStep extends DebugBase {
    kind: "agent-step"; step: number;
    /** The PER-TURN step number (1-based, resets each run()), for the "STEP x/maxSteps" display — `step`
     *  is offset cumulatively across turns so the sidebar's turn groups don't collide, but maxSteps is a
     *  per-turn budget, so the pill must show this local count (turn 2 starts at 1/N again, not 18/20). */
    localStep?: number;
    /** A monotonic id per TOOL-call step in a run, so the sidebar can correlate the in-flight START
     *  (pending: true, no result yet) with the completed DONE and patch the row in place. Thoughts
     *  have no seq. `pending` marks the START (render "running…" until the DONE arrives). */
    seq?: number; pending?: boolean;
    /** Design A: a pending step whose background-hosted tool is BLOCKED on the human gate. The sidebar
     *  renders approve/deny controls (instead of "running…") and posts the decision back via SET_APPROVAL. */
    awaitingApproval?: boolean;
    /** `thought` = the assistant's user-facing PROSE (content); `reasoning` = its separate thinking
     *  channel (reasoning_content / message.thinking), rendered as a collapsible "think" section. */
    thought?: string; reasoning?: string | null; tool?: string; arguments?: Record<string, unknown>; result?: string; elements?: number;
    /** rich render for the In slot (the call) — else the raw args */
    renderIn?: RenderDescriptor;
    /** rich render for the Out slot (the result) — else the raw result */
    renderOut?: RenderDescriptor;
    /** JSON-Schema mismatches between the args and the tool's parameters */
    argIssues?: string[];
    /** How an approval-gated tool call was decided (undefined for tools that don't
     *  require approval). The sidebar renders it as a green/red provenance badge —
     *  and it's the slot a future interactive-approval control resolves into. */
    approval?: "readonly" | "sandbox" | "user" | "denied" | "skipped";
    /** Token counts for this step's driver call, when the server reports them. Each
     *  step re-sends the full growing history, so the LATEST step's usage is the run's
     *  current context occupancy (not a sum across steps — see TokenUsage). */
    usage?: TokenUsage | null;
}
export interface DebugAgentResult extends DebugBase { kind: "agent-result"; summary: string; steps: number; hitCap: boolean; cancelled?: boolean; error?: string | null; }

/** A handle raised the step cap mid-run (a.maxSteps = N) — the sidebar/HUD updates its "STEP x/N" display. */
export interface DebugAgentCap extends DebugBase { kind: "agent-cap"; maxSteps: number; }
/** A handle inserted a user message into a RUNNING loop (a.say(text)) — shown immediately (pending), even
 *  though the model only sees it at the next step boundary. */
export interface DebugAgentSay extends DebugBase { kind: "agent-say"; text: string; }

/** The event stream injected.js emits over window.postMessage for the sidebar. */
export type MlDebugEvent = DebugChatStart | DebugChatResult | DebugChatError
    | DebugAgentStart | DebugAgentStep | DebugAgentResult | DebugAgentCap | DebugAgentSay;

/** Window-bus envelopes between the core (main world) and the sidebar. */
export interface MlDebugMessage { __mlDebug: MlDebugEvent; }
export interface MlSidebarReady { __mlSidebar: "ready"; }

/* ------------------------------ the API ------------------------------- */

/** The full `window.ml` surface — the fixed signature every caller (page
 *  scripts, userscripts, the devtools console) type-checks against, and the
 *  contract the object literal in injected.ts is verified against on build.
 *
 *  Underscore-prefixed members are internal plumbing exposed for debugging;
 *  they are NOT part of the stable public API and may change. */
export interface MlApi {
    /** The agent's persistent JS scratchpad — a plain object, also injected into every `exec` body as the
     *  lexical `state` variable. Stash reusable functions/results across `exec` calls (the Jupyter/kernel
     *  paradigm). Page-lifetime, shared across runs; read-only binding (mutate its properties). */
    readonly state: Record<string, unknown>;
    /* ---- chat ---- */
    /** Create a stateful multi-turn chat session. Same raw-model contract as ml.chat —
     *  the turns accumulate, but the model still never sees the page. */
    createChat(opts?: ChatOptions & { save?: boolean }): MlHistory;
    /** Resume a chat by its session hash (shown in the debug sidebar). Returns a
     *  history you can `.chat()` on. Same-tab sessions resume from memory; across
     *  reloads/tabs only `{ save: true }` sessions survive (persisted to storage). */
    resumeChat(hash: string): Promise<MlHistory>;
    /** One-shot chat — a throwaway single-turn history. A RAW model call: it sees ONLY the
     *  prompt string you pass (plus any `images`), NOT the page. No DOM access, no tools —
     *  to ask about the page, extract the text yourself and pass it in, or use ml.agent. */
    chat(prompt: string, options?: ChatOptions): Promise<string | unknown>;
    /** One-shot chat that always returns a string (never a parsed schema). */
    chatShort(prompt: string, options: ChatOptions): Promise<string>;
    /** ml.chat but the reply is also console.logged. */
    logChat(prompt: string, options: ChatOptions): Promise<void>;
    /** ml.chatShort but the reply is also console.logged. */
    logChatShort(prompt: string, options: ChatOptions): Promise<void>;

    /* ---- tools / agent ---- */
    /** Low-level single model turn WITH client-side tools; you own the loop. */
    step(messages: NeutralMessage[], opts?: StepOptions): Promise<{ content: string; tool_calls: ToolCall[]; reasoning?: string | null; usage?: TokenUsage | null }>;
    /** Build one agent tool (JSON-schema signature + page-side run). */
    defineTool(tool?: Partial<MlTool>): MlTool;
    /** Run a full agent loop over a tool registry until it stops or hits maxSteps. THE
     *  page-aware entry point — unlike ml.chat, the model discovers and acts on the live DOM
     *  through tools (and vision), one step at a time. Use it for anything about "this page". */
    agent(task: string, opts?: AgentOptions): Promise<AgentResult>;
    /** A stateful agent session (the agent analogue of ml.createChat): run(task) executes a turn,
     *  say(text) writes a user message, run() again continues the SAME session; also cancel/fork +
     *  hash/messages/maxSteps. Everything shares one hash so the sidebar/HUD keep it as one conversation. */
    createAgent(opts?: AgentOptions): MlAgentHandle;
    /** Re-acquire a live agent handle by its session hash (the agent analogue of resumeChat) — read/mutate
     *  its `messages`, say()/run() to continue, fork() or cancel(). Same-tab createAgent / HUD-started runs
     *  only; a one-shot ml.agent(task) or a background run isn't handle-resumable (use ml.agent(task,
     *  { resume }) to continue those). Throws if no handle-backed run exists for the hash. */
    resumeAgent(hash: string): MlAgentHandle;
    /** An approve() gate that auto-approves the first call, then denies. */
    approveOnce(): (req: ApprovalRequest) => boolean;
    /** The default DOM tool registry (added right after injection). */
    domTools?: MlTool[];

    /** Built-in vision tool factory (OCR/screenshot look). */
    lookTool(opts?: { model?: string | null; maxTokens?: number }): MlTool;
    /** Built-in delegated visual locator (find an element by describing it): grounding
     *  VLM when configured, else Set-of-Marks; both snap to the DOM by hit-testing. */
    locateTool(opts?: { model?: string | null; groundingModel?: string | null; groundingRange?: number; maxTokens?: number }): MlTool;
    /** Built-in click tool factory. */
    clickTool(): MlTool;
    /** Built-in type tool factory. */
    typeTool(): MlTool;
    /** Run a sandboxed Python snippet (Pyodide/WASM, numpy + Pillow) with an optional
     *  screenshot injected as `img`/`img_np`. No network/filesystem/DOM. */
    pythonExec(code: string, opts?: { image?: string | Element | null; mode?: "readonly" | "full"; margin?: number; tableRaw?: boolean; tables?: string | Element | Record<string, string | Element> | null }): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string; inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox; resultTable?: { columns: string[]; rows: (string | number | null)[][] } }>;
    /** Built-in sandboxed-Python tool factory (numpy/Pillow pixel/array work). */
    pythonTool(): MlTool;
    /** Read-only self-introspection tool for ml.agent (pass via `extraTools`): reports the run's model,
     *  context window + usage, tokens generated, message/image counts, and the model's capabilities. The
     *  agent loop answers it, so the counts are accurate on both the page and background paths. */
    chatMetaTool(): MlTool;

    /* ---- vision / OCR / capture ---- */
    /** OCR/describe an image (element, url or data URL). */
    read(image: string | HTMLImageElement, opts?: { model?: string | null; prompt?: string | null }): Promise<string>;
    /** Capture the tab (or an element) to a data URL. */
    screenshot(target?: string | Element | null, opts?: { scroll?: boolean; fullPage?: boolean; index?: number; raw?: boolean; margin?: number }): Promise<string>;

    /* ---- server / model management ---- */
    models(): Promise<string[]>;
    capabilities(model?: string | null): Promise<string[] | null>;
    /** Gets the `default` model the user has configured for tasks */
    getModel(): Promise<string | null>;
    config(): Promise<MlPublicConfig>;
    setModel(model: string): Promise<string>;
    ps(): Promise<LoadedModel[]>;
    unload(model?: string | null): Promise<string[]>;
    /** List the OpenWebUI server-side tools available to the configured API key —
     *  the valid ids for `ml.chat`'s `toolIds`, with each one's function specs.
     *  Empty on a bare-Ollama endpoint (no such concept). */
    serverTools(): Promise<ServerTool[]>;

    /** Resolves once window.ml is fully wired (synchronous; set right after
     *  injection). See the `ml:ready` event for the pre-resolution hook. */
    ready?: Promise<MlApi>;

    /* ---- internal plumbing (underscore-prefixed; unstable) ---- */
    _logStep(ev: AgentStepEvent): void;
    /** Design A — register/end an agent run's page-side toolset so the background loop can run its
     *  tools via RUN_TOOL_IN_PAGE (see run-delegation.ts). Called by ml.agent's START_RUN shim. */
    _registerRun(runId: string, tools: MlTool[]): void;
    _endRun(runId: string): void;
    _truncate(str: string, n: number): string;
    _suspiciousChars(str: string): { index: number; code: string; name: string }[];
    _renderArgs(args: unknown): string;
    _elPath(el: Element): string;
    _describeSkeleton(el: Element, depth: number, indent?: string): string;
    _queryAll(selector: string): Element[];
    _selectorError(selector: string, err: Error): string;
    _parseJSON(text: string): unknown;
    _imageToDataUrl(image: string | HTMLImageElement): Promise<string>;
    _fetchImageBase64(url: string): Promise<string>;
    _stitchFullPage(capture: () => Promise<string>): Promise<string>;
    _resolveTable(target: string | Element, raw?: boolean): { kind: "rows"; columns: string[]; rows: (string | number | null)[][] } | { kind: "html"; html: string };
    _loadTable(name: string, src: string | Element, raw?: boolean): Promise<{ name: string; source: TableSource; data: { kind: "rows"; columns: string[]; rows: (string | number | null)[][] } | { kind: "html"; html: string } }>;
    _resolveVisionModel(agentModel: string | null, vision: boolean | string | null): Promise<string | null>;
    _modelSees(model: string | null): Promise<boolean>;
    _nativeLookTool(): MlTool;
    /** The crop transform (viewport top-left + dpr) of a raw screenshot of `target` — so a python_exec
     *  image-pixel coordinate can be projected to the viewport for a clickable @pt/@box. */
    _shotBox(target: string | Element, margin?: number): ShotBox | null;
}

/* --------------------------- global augmentation -------------------------- */
// injected.js defines window.ml (the whole public API) on the page's main world.
declare global {
    interface Window { ml: MlApi; }
}
export {};

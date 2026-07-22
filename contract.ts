/**
 * @file Shared interfaces for window.ml — the contracts the main-world primitive
 * (injected), the content-script relay (content), the background worker
 * (background), and the debug sidebar all agree on. Types only; erased at build.
 * Import with `import type { ... } from "./contract"` so nothing survives to JS.
 */

/* ------------------------------- config ------------------------------- */

export type ApiFormat = "openai" | "ollama";
export type Theme = "auto" | "dark" | "light";

/** Full config held in chrome.storage.sync (background + popup own it). */
export interface MlConfig {
    chatUrl: string;
    apiKey: string;
    model: string;
    apiFormat: ApiFormat;
    ocrModel: string;
    sidebar: boolean;
    theme: Theme;
    // Small "utility" model for cheap side tasks (e.g. session-title summaries).
    // Empty → fall back to the main `model`. numCtx/forceCpu apply only when set.
    utilityModel: string;
    utilityNumCtx: number;      // context window for the utility model (Ollama num_ctx)
    utilityForceCpu: boolean;   // run it on CPU (num_gpu: 0) so it can't evict the main model
    autoTitles: boolean;        // let the utility model summarise session titles in the debug sidebar
    autoApproveReadonly: boolean;   // experimental: auto-approve read-only exec surveys via the mediated interpreter
    // Optional visual-grounding model for ml.agent's `locate` tool (coordinate
    // output). OFF by default — enabling loads a 3rd model into VRAM, so it's opt-in.
    groundingEnabled: boolean;
    groundingModel: string;     // e.g. qwen2.5vl:7b; empty + enabled → auto-detect a qwen2.5vl on the server
    // Coordinate range the grounding model outputs (the divisor for its x,y). The
    // screenshot is sent as a 1000×1000 square, so this one number covers every
    // convention: 1000 (0–1000 normalized, or qwen2.5vl absolute-pixels-of-the-sent
    // image), 100 (Molmo percent), 1024 (PaliGemma/Florence tokens).
    groundingRange: number;
}

/** Default grounding coordinate range / the square size the screenshot is sent at.
 *  One value: the image is sent at this many px, so a PIXEL model (qwen2.5vl) outputs
 *  0–this — the same space a 0–1000-NORMALIZED model uses. Override the config range
 *  only for a different convention (100 = percent, 1024 = tokens). */
export const DEFAULT_GROUNDING_RANGE = 1000;

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
    sidebar: false,
    theme: "auto",
    utilityModel: "",
    utilityNumCtx: 4096,
    utilityForceCpu: false,
    autoTitles: true,
    autoApproveReadonly: false,
    groundingEnabled: false,
    groundingModel: "",
    groundingRange: DEFAULT_GROUNDING_RANGE,
};

/** First qwen2.5vl on a server model list (7b → 3b → any qwen*vl) — the grounding
 *  model auto-detect used when the field is blank. "" if none present. Pure; shared
 *  by the settings UI and ml.agent so they resolve the same effective model. */
export const detectGroundingModel = (models: string[]): string =>
    models.find(m => m === "qwen2.5vl:7b") || models.find(m => m === "qwen2.5vl:3b") || models.find(m => /qwen.*vl/i.test(m)) || "";

/** The non-secret subset GET_CONFIG exposes to the page (never the URL/key). */
export type MlPublicConfig = Pick<MlConfig,
    "model" | "ocrModel" | "apiFormat" | "utilityModel" | "utilityNumCtx" | "utilityForceCpu" | "autoApproveReadonly" | "groundingEnabled" | "groundingModel" | "groundingRange">;

/* --------------------------- chat wire shapes -------------------------- */

export type Role = "system" | "user" | "assistant" | "tool";

/** Neutral message shape; each API format converts it to its wire form. */
export interface NeutralMessage {
    role: Role;
    content: string | null;
    images?: string[];              // full data URLs
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    sources?: unknown[];            // OpenWebUI tool/RAG provenance
}

/** Normalized tool call — `{ id, name, arguments }` regardless of backend. */
export interface ToolCall {
    id: string;
    name: string;
    arguments: Record<string, unknown> | string;
}

export interface LlmResult {
    content: string;
    sources?: unknown[] | null;
    model?: string | null;   // the model actually used, after server-side resolution (extend/ocr/default)
    reasoning?: string | null;   // separate reasoning/thinking text (reasoning_content / message.thinking)
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
    render?: RenderDescriptor;
}

/** A serializable description of how to render a tool step in the debug sidebar.
 *  Data, never code — it crosses the window bus and the sidebar owns the actual
 *  UI (safe: only known `type`s render; unknown/absent → the default In:/Out:
 *  view). A tool's `render` produces one page-side; built-ins auto-derive
 *  image/elements from the envelope. */
export type RenderDescriptor = (
    | { type: "image"; src: string; label?: string }
    | { type: "code"; text: string; lang?: string; format?: boolean }   // format: let the sidebar beautify the source (e.g. exec's JS)
    | { type: "table"; columns: string[]; rows: (string | number)[][] }
    | { type: "keyval"; pairs: [string, string][] }
    | { type: "elements"; items: { path: string; text?: string; index?: number }[] }
    // `locate`'s per-mechanism debug view. grounding: the VLM prompt + the square the
    // model saw with ITS box (or none), then the element-location pass (red candidate
    // boxes + a yellow, possibly-expanded search area). marks: just the badged shot.
    | {
        type: "locate"; mode: "grounding" | "marks" | "grid"; model: string;
        picked?: string;                 // the chosen element (role/name → selector), or none
        resultImage?: string;            // element-location pass (red boxes [+ yellow area]); absent for a grounding no-box
        prompt?: string;                 // grounding/grid: the full VLM prompt
        groundingImage?: string;         // grounding: the square the model saw, with its box
        gaveBox?: boolean;               // grounding: did the model return a box?
        boxCoords?: string;              // grounding: the raw coords it gave, for display
        margin?: number;                 // grounding: the search-area expansion applied
        // grid: the numbered grid the model saw (selected cell(s) highlighted), which
        // cell(s) it chose, the aspect-matched grid dimensions, and — when the picked
        // cell held several elements — how many a SECOND (Set-of-Marks) sub-call chose
        // among (absent when a single element was snapped directly).
        griddedImage?: string;
        cells?: number[];
        cols?: number;
        rows?: number;
        handoff?: number;
        // marks: when 'auto' tried grounding and it missed, why (+ what it saw), so the
        // fallback still shows the grounding attempt instead of hiding it.
        fallbackNote?: string;
        fallbackImage?: string;
      }
    // Which block the descriptor renders (default "out"). `exec` renders its "in"
    // (the JS); output-derived descriptors (image/elements) render "out".
) & { target?: "in" | "out" };

/** Input to a tool's `render`: the run's stringified result + the raw envelope
 *  extras (live nodes/image), plus the call args. Runs page-side. */
export interface ToolRenderInput {
    result: string;
    elements?: Node[];
    image?: string;
    imageLabel?: string;
    render?: RenderDescriptor;   // a render the tool's run() precomputed (wins over auto-derive)
}

export interface MlTool {
    name: string;
    description: string;
    parameters: JsonSchema;
    // Args are model-supplied JSON, so tools may destructure a specific shape
    // (`run({ selector }: { selector: string })`); typed `any` so those narrower
    // signatures stay assignable to this contract.
    run: (args: any) => string | ToolResult | Promise<string | ToolResult>;
    requiresApproval: boolean;
    capabilities: ("vision"|"answer")[];         // e.g. "vision" | "answer"
    // Optional page-side formatter → a serializable RenderDescriptor for the
    // debug sidebar (null/throw → the default renderer). Never receives/returns code.
    render?: (input: ToolRenderInput, args: Record<string, unknown>) => RenderDescriptor | null | undefined;
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
}

export interface AgentResult {
    summary: string;
    steps: number;
    transcript: AgentTranscriptEntry[];
    elements: Node[];               // nodes designated via an answer-capable tool
    hitCap?: boolean;
}

/** One live tracer event from ml.agent's `onStep` (a transcript entry + the
 *  step index). Also the shape ml._logStep consumes. */
export interface AgentStepEvent extends AgentTranscriptEntry {
    step: number;
}

/** Options for the low-level ml.step turn. */
export interface StepOptions {
    tools?: unknown[];              // client-side tool definitions
    model?: string | null;
    think?: boolean | null;
}

/** Options for ml.agent — the loop, whitelist, cap and approval gate. */
export interface AgentOptions {
    tools?: MlTool[] | null;        // tool registry (default ml.domTools)
    extraTools?: MlTool[];          // appended to `tools`
    system?: string | null;        // REPLACES the built-in preamble
    hints?: string | null;         // APPENDED to the built-in preamble
    maxSteps?: number;
    model?: string | null;
    think?: boolean | null;
    approve?: (req: ApprovalRequest) => boolean | ApprovalDecision | Promise<boolean | ApprovalDecision>;
    onStep?: ((ev: AgentStepEvent) => void) | null;
    env?: boolean;                  // prepend page-context note to the system prompt
    vision?: boolean | string | null;   // auto-wire a `look` tool (null = probe)
    logDebug?: boolean;            // install the built-in console tracer
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
    numCtx?: number | null;     // Ollama num_ctx (context window); ollama format only
    numGpu?: number | null;     // Ollama num_gpu (0 = force CPU); ollama format only
    think?: boolean | null;
    images?: (string | HTMLImageElement)[];
    schema?: JsonSchema | null;
    toolIds?: string[] | null;
    maxTokens?: number | null;
    save?: boolean;
    onToken?: (delta: string, full: string) => void;
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
    | "SAVE_SESSION_REQUEST" | "GET_SESSION_REQUEST";

/** Message types the background worker's onMessage listener handles. */
export type BackgroundMessageType =
    | "FETCH_LLM" | "FETCH_IMAGE_B64" | "LIST_MODELS" | "GET_MODEL" | "GET_CONFIG"
    | "SET_MODEL" | "MODEL_CAPS" | "OLLAMA_PS" | "OLLAMA_UNLOAD" | "CAPTURE_TAB"
    | "SAVE_SESSION" | "GET_SESSION";

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
    extend?: ExtendProfile | null;   // resolved server-side from the utility-model config
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
 *  reveal CPU-only (vram 0) vs partial offload (0 < vram < size) vs full GPU. */
export interface LoadedModel {
    model: string;
    vramGB: number | null;
    sizeGB: number | null;
    expiresAt: string | null;
}

/* ------------------- debug sidebar contract (core → sidebar, window bus) ------------------- */

/** Groups turns of one createChat conversation; `turn` is the 0-based index. */
export interface SessionRef {
    hash: string;
    turn: number;
}

export interface DebugChatRequest {
    model: string | null;
    extend: ExtendProfile | null;   // so a pending turn can resolve its model from the config before the result lands
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
    id: string;                     // correlates start ↔ result/error
    ts: number;
    save: boolean;
    session: SessionRef;
}
export interface DebugChatStart extends DebugBase { kind: "chat"; streaming: boolean; request: DebugChatRequest; config: DebugSessionConfig; }
export interface DebugChatResult extends DebugBase { kind: "chat-result"; content: string; sources: unknown[] | null; structured: boolean; model: string | null; extend: ExtendProfile | null; reasoning: string | null; }
export interface DebugChatError extends DebugBase { kind: "chat-error"; error: string; }

/** ml.agent runs: a run-start, one event per step (a thought OR a tool call +
 *  result), then a result. `elements` is a COUNT — real DOM nodes can't cross the
 *  window bus (they reach the console via onStep instead). */
/** The agent run's resolved setup — for the sidebar's "agent options" block. */
export interface DebugAgentConfig {
    system: string;         // the resolved system prompt the model actually received
    customSystem: boolean;  // caller supplied their own `system` (vs the built-in preamble)
    tools: { name: string; requiresApproval: boolean; vision?: boolean }[];
    maxSteps: number;
    think: boolean | null;
    env: boolean;
    vision: boolean | string | null;
    hints: string | null;
}
export interface DebugAgentStart extends DebugBase { kind: "agent"; task: string; model: string | null; maxSteps: number; config: DebugAgentConfig; }
export interface DebugAgentStep extends DebugBase {
    kind: "agent-step"; step: number;
    thought?: string; tool?: string; arguments?: Record<string, unknown>; result?: string; elements?: number;
    render?: RenderDescriptor;   // tool-supplied or auto-derived rich render (else the default In:/Out:)
    argIssues?: string[];        // JSON-Schema mismatches between the args and the tool's parameters
    // How an approval-gated tool call was decided (undefined for tools that don't
    // require approval). The sidebar renders it as a green/red provenance badge —
    // and it's the slot a future interactive-approval control resolves into.
    approval?: "readonly" | "user" | "denied";
}
export interface DebugAgentResult extends DebugBase { kind: "agent-result"; summary: string; steps: number; hitCap: boolean; }

/** The event stream injected.js emits over window.postMessage for the sidebar. */
export type MlDebugEvent = DebugChatStart | DebugChatResult | DebugChatError
    | DebugAgentStart | DebugAgentStep | DebugAgentResult;

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
    /* ---- chat ---- */
    /** Create a stateful multi-turn chat session. */
    createChat(opts?: ChatOptions & { save?: boolean }): MlHistory;
    /** Resume a chat by its session hash (shown in the debug sidebar). Returns a
     *  history you can `.chat()` on. Same-tab sessions resume from memory; across
     *  reloads/tabs only `{ save: true }` sessions survive (persisted to storage). */
    resumeChat(hash: string): Promise<MlHistory>;
    /** One-shot chat — a throwaway single-turn history. */
    chat(prompt: string, options?: ChatOptions): Promise<string | unknown>;
    /** One-shot chat that always returns a string (never a parsed schema). */
    chatShort(prompt: string, options: ChatOptions): Promise<string>;
    /** ml.chat but the reply is also console.logged. */
    logChat(prompt: string, options: ChatOptions): Promise<void>;
    /** ml.chatShort but the reply is also console.logged. */
    logChatShort(prompt: string, options: ChatOptions): Promise<void>;

    /* ---- tools / agent ---- */
    /** Low-level single model turn WITH client-side tools; you own the loop. */
    step(messages: NeutralMessage[], opts?: StepOptions): Promise<{ content: string; tool_calls: ToolCall[] }>;
    /** Build one agent tool (JSON-schema signature + page-side run). */
    defineTool(tool?: Partial<MlTool>): MlTool;
    /** Run a full agent loop over a tool registry until it stops or hits maxSteps. */
    agent(task: string, opts?: AgentOptions): Promise<AgentResult>;
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

    /* ---- vision / OCR / capture ---- */
    /** OCR/describe an image (element, url or data URL). */
    read(image: string | HTMLImageElement, opts?: { model?: string | null; prompt?: string | null }): Promise<string>;
    /** Capture the tab (or an element) to a data URL. */
    screenshot(target?: string | Element | null, opts?: { scroll?: boolean; fullPage?: boolean; index?: number }): Promise<string>;

    /* ---- server / model management ---- */
    models(): Promise<string[]>;
    capabilities(model?: string | null): Promise<string[] | null>;
    getModel(): Promise<string | null>;
    config(): Promise<MlPublicConfig>;
    setModel(model: string): Promise<string>;
    ps(): Promise<LoadedModel[]>;
    unload(model?: string | null): Promise<string[]>;

    /** Resolves once window.ml is fully wired (synchronous; set right after
     *  injection). See the `ml:ready` event for the pre-resolution hook. */
    ready?: Promise<MlApi>;

    /* ---- internal plumbing (underscore-prefixed; unstable) ---- */
    _logStep(ev: AgentStepEvent): void;
    _truncate(str: string, n: number): string;
    _suspiciousChars(str: string): { index: number; code: string; name: string }[];
    _elPath(el: Element): string;
    _describeSkeleton(el: Element, depth: number, indent?: string): string;
    _queryAll(selector: string): Element[];
    _selectorError(selector: string, err: Error): string;
    _parseJSON(text: string): unknown;
    _imageToDataUrl(image: string | HTMLImageElement): Promise<string>;
    _fetchImageBase64(url: string): Promise<string>;
    _stitchFullPage(capture: () => Promise<string>): Promise<string>;
    _resolveVisionModel(agentModel: string | null, vision: boolean | string | null): Promise<string | null>;
    _modelSees(model: string | null): Promise<boolean>;
    _nativeLookTool(): MlTool;
}

/* --------------------------- global augmentation -------------------------- */
// injected.js defines window.ml (the whole public API) on the page's main world.
declare global {
    interface Window { ml: MlApi; }
}
export {};

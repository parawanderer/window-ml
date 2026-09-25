/**
 * @file Shared interfaces for window.ml — the contracts the main-world primitive
 * (injected), the content-script relay (content), the background worker
 * (background), and the debug sidebar all agree on. Types only; erased at build.
 * Import with `import type { ... } from "./contract"` so nothing survives to JS.
 */

// Type-only (erased): the curated answer-set class, referenced by ToolContext.answer. answer-set.ts
// imports AnswerMedia back from here — a type-only cycle, which is fine.
import { MlAnswer, StepOptions, MlTool, AgentOptions, AgentResult, MlAgentHandle, ApprovalRequest, AgentStepEvent } from "./contract-agent";
import { ChatOptions, MlHistory, NeutralMessage, ToolCall, TokenUsage } from "./contract-chat";
import { MlPublicConfig } from "./contract-config";
import { TablePreview, TableValue, FetchResult, FetchFormat, TableSource } from "./contract-fetch";

// THE BARREL. A themed module is where a type LIVES; this file is where every consumer still finds it, and
// that is not a convenience. Roughly a hundred references across the codebase are written as the inline type
// query `import("./contract").SubcallUsage`, which no refactoring tool rewrites because it is a string, and
// three generators read this file by path (gen-api-docs, gen-export-schema, and the model-facing API doc the
// first one builds). Both follow an `export … from` out to the real declaration. Re-exporting is what makes
// the split invisible to all of them; it is not a deprecation shim.
export * from "./contract-debug";
export * from "./contract-messages";
export * from "./contract-server";
export * from "./contract-fetch";
export * from "./contract-render";
export * from "./contract-agent";
export * from "./contract-chat";
export * from "./contract-config";
export * from "./contract-pointers";
export * from "./contract-run";
import { RebuildConfig } from "./contract-messages";
import { DerefValue } from "./contract-pointers";
import { VisionMemory, ShotBox } from "./contract-render";
import { LoadedModel, ServerTool, ServerToolResult, OllamaInfo } from "./contract-server";

// Type-only: the unit-vector wrapper `ml.embed` resolves to. embedding.ts imports nothing, so no cycle.
import type { Embedding } from "./embedding";

/* ------------------------------- config ------------------------------- */

/* --------------------------- chat wire shapes -------------------------- */

/* ----------------------------- tools / agent --------------------------- */

export interface JsonSchema {
    type?: string;
    properties?: Record<string, unknown>;
    required?: string[];
    enum?: unknown[];
    [k: string]: unknown;
}

// The slot a descriptor fills is decided by which hook produced it (a tool's `render()`
// method / run()-returned `renderIn` → the In slot; a run()-returned `render` / an
// auto-derived image/elements → the Out slot) — not by a field on the descriptor.

/* ----------------------------- call options ---------------------------- */

/* ------------------- relay contract (page ⇄ content ⇄ background) ------------------- */

/* ------------------- design A: background → page tool delegation ------------------- */

/* ------------------- debug sidebar contract (core → sidebar, window bus) ------------------- */

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
    /** Curate the CURRENT run's user-facing answer (what the user sees as the result). A run-bound collection —
     *  valid only WHILE your run is executing; from the console outside a run it throws. Free to call from
     *  `exec` (no approval — curating your own answer is a safe operation). Keep it MINIMAL and matched to the
     *  ask. `add` a live element (→ hoverable/highlighted), a `@tool:` output token, or text; `remove` by index,
     *  `clear`, `length`; the bare object dumps a compact index (never the heavy media). */
    readonly answer: MlAnswer;
    /** Read a `@tool:<id>` pointer — an output this run already produced — instead of re-running the tool that
     *  made it. Reaches the FULL capture, not the truncated copy the model was shown. `pipe` reduces it first,
     *  as a dialect string (".rows | head 5") or an array with one stage per entry ([".rows", "head 5"]) —
     *  an array entry is never re-split, so use it when a stage holds a `|` (["grep -E error|warn"]). Run-bound like
     *  `ml.answer`: live inside a tool call (an approved `exec`), throws from the console outside a run.
     *
     *  SYNCHRONOUS inside `exec` for a reference written LITERALLY — `@tool:abc1234`, or the same string
     *  passed directly — and for the no-argument listing, because all of those are resolved before the
     *  script starts. So `@tool:abc1234.length` is a number, not `undefined` on a promise, and the macro
     *  and the longhand call it expands to are the same object. Two cases stay a promise: a COMPUTED
     *  reference (built at runtime, so no static pass can see it), and a call with `pipe`, which mints its
     *  own pointer for the reduction and so has to go back to the run rather than reduce what is in hand. `await` is safe on
     *  both, since awaiting a non-promise is a no-op — so if in doubt, await. */
    dereference(ref: string, options?: { pipe?: string | string[] | null }): DerefValue | Promise<DerefValue>;
    /** The TS-like type of some JSON — one document's shape, or the JOINED type of several. Same-shaped
     *  documents collapse into one object with optional keys where they differ; different ones stay a
     *  union. Arguments are awaited, so `ml.schema(ml.dereference(a), ml.dereference(b))` works. */
    schema(...values: unknown[]): Promise<string>;
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
     *  { resume }) to continue those). A distinct PREFIX of the hash works too, at least 8 characters, the way git
     *  takes a short commit — ids are 32 hex characters and get copied, not retyped. Throws if no handle-backed run
     *  exists for the hash, or if a prefix matches more than one (it names them rather than guessing). */
    resumeAgent(hash: string): MlAgentHandle;
    /** An approve() gate that auto-approves the first call, then denies. */
    approveOnce(): (req: ApprovalRequest) => boolean;
    /** The default DOM tool registry (added right after injection). */
    domTools?: MlTool[];

    /** Built-in vision tool factory (OCR/screenshot look). `memory` (when auto-wired) is the shared
     *  near-area registry so a `look({@pt})` marks that spot seen — feeding `locate`'s auto-inject dedup. */
    lookTool(opts?: { model?: string | null; maxTokens?: number; memory?: VisionMemory }): MlTool;
    /** Built-in delegated visual locator (find an element by describing it): grounding
     *  VLM when configured, else Set-of-Marks; both snap to the DOM by hit-testing.
     *  Whether a grounding snap feeds the crop back as an inline IMAGE (native driver) or a delegated text
     *  DESCRIPTION comes from `ctx.driverSees` at run time (not a build opt — one resolved source). `memory` =
     *  the shared near-area dedup so a re-snap onto an already-seen spot doesn't re-inject the crop. */
    locateTool(opts?: { model?: string | null; groundingModel?: string | null; groundingRange?: number; maxTokens?: number; memory?: VisionMemory }): MlTool;
    /** Built-in click tool factory. */
    clickTool(): MlTool;
    /** Built-in type tool factory. */
    typeTool(): MlTool;
    /** Built-in `navigate(url)` tool factory (auto-wired into ml.agent unless `navigate: false`): navigate
     *  the tab to another URL, continuing the run on the new page. Same-origin only unless `crossOrigin`. */
    navigateTool(opts?: { crossOrigin?: boolean }): MlTool;
    /** Built-in `fetch_url` tool factory (auto-wired into ml.agent): GET a URL's content via the background so
     *  the agent can READ a file/API/other page without navigating (uncredentialed by default; opt into the
     *  user's session with `credentials`, or a JS render with `rendered`). requiresApproval. */
    fetchTool(): MlTool;
    /** Run a sandboxed Python snippet (Pyodide/WASM, numpy + Pillow) with an optional
     *  screenshot injected as `img`/`img_np`. No network/filesystem/DOM. */
    pythonExec(code: string, opts?: { image?: string | Element | null; mode?: "readonly" | "full"; margin?: number; tableRaw?: boolean; tables?: string | Element | TableValue | Record<string, string | Element | TableValue> | null; onStdout?: (chunk: string, ts?: number) => void }): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string; render?: "latex" | "img"; inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox; resultTable?: { columns: string[]; rows: (string | number | null)[][] }; bootMs?: number; runMs?: number }>;
    /** Built-in sandboxed-Python tool factory (numpy/Pillow pixel/array work). */
    pythonTool(): MlTool;
    /** Read-only self-introspection tool for ml.agent (pass via `extraTools`): reports the run's model,
     *  context window + usage, tokens generated, message/image counts, and the model's capabilities. The
     *  agent loop answers it, so the counts are accurate on both the page and background paths. */
    chatMetaTool(): MlTool;

    /* ---- DOM query ---- */
    /** Like `document.querySelectorAll(selector)` but returns a real Array and understands the SAME
     *  selector dialect the DOM tools use. Boundary crossing: `host >>> inner` crosses OPEN (and, if
     *  enabled, closed) shadow roots and SAME-ORIGIN iframes — one `>>>` per boundary, nesting
     *  `a >>> b >>> c`; plain CSS/text also pierces same-origin frames + open shadow roots automatically.
     *  Extended pseudos (usable on ANY step, not just the last): `:contains("t")` / `:has-text("t")`
     *  (visible-text substring), `:eq(n)` (0-based pick). Playwright-style ENGINES (whole selector):
     *  `text="t"` (smallest text carrier), `role=button[name="Save"]` / `role=heading[level=1]` (ARIA role
     *  + accessible-name substring + state), `label="Username"` (form control by its label/accessible
     *  name). Use this instead of hand-chaining `.shadowRoot`/`.contentDocument`. Read-only. */
    /** By default EXCLUDES the extension's own injected UI (the HUD overlay/card/highlight/lightbox); pass
     *  `includeExtensionUi: true` to reach those page elements too. */
    queryAll(selector: string, includeExtensionUi?: boolean): Element[];
    /** The screen-reader + actionable view of ONE element, as a single object — the same expertise the
     *  `interactives` tool uses, so you can COMPOSE your own finder in an `exec` survey:
     *  `ml.queryAll("button").map(b => ml.a11y(b)).filter(a => /delete/i.test(a.name))` then act on `a.selector`.
     *  `role` (screen-reader role) · `name` (aria-label → aria-labelledby → label/placeholder → text) ·
     *  `state` (aria checked/expanded/disabled/… , "" if none) · `selector` (the stable `>>>` reference you pass
     *  to click/type/answer). Read-only. */
    a11y(el: Element): { role: string; name: string; state: string; selector: string };
    /** PRIVATE debug helper (underscore → dropped from agent_api_docs). Lists every shadow-root host + whether
     *  the tools can enter it — `state`: open (reachable) · pierced (a closed root captured at load) · sealed
     *  (renders content behind a boundary a selector can't enter) · empty (rendering nothing — an unopened
     *  menu/emulated host, NOT a barrier). Temporary console-only diagnostic, kept off the agent's radar. */
    _shadowRoots(): { open: number; pierced: number; sealed: number; empty: number; hosts: { selector: string; tag: string; state: "open" | "pierced" | "sealed" | "empty" }[] };

    /* ---- vision / OCR / capture ---- */
    /** OCR/describe an image (element, url or data URL). */
    read(image: string | HTMLImageElement, opts?: { model?: string | null; prompt?: string | null; numCtx?: number | null }): Promise<string>;
    /** Capture the tab (or an element) to a data URL. */
    screenshot(target?: string | Element | null, opts?: { scroll?: boolean; fullPage?: boolean; index?: number; raw?: boolean; margin?: number; noOverlay?: boolean; capture?: string | null }): Promise<string>;

    /* ---- server / model management ---- */
    models(): Promise<string[]>;
    capabilities(model?: string | null): Promise<string[] | null>;
    /** Gets the `default` model the user has configured for tasks */
    getModel(): Promise<string | null>;
    /** A bounded integer range, like Python's `range()` — a terminating counter loop for `exec` (no
     *  `for`/`while`): `ml.range(8).map(i => …)`. `range(stop)` / `range(start, stop)` / `range(start,
     *  stop, step)`. Returns a real array capped at 100k (over → throws), so it can never run away. */
    range(a: number, b?: number, step?: number): number[];
    /** Scan/filter a string with the same small shell-style dialect the tools' `pipe` parameter takes, but over
     *  ANY text — not just one tool's output. `ml.pipe(await ml.fetch(url), "grep -i pricing | head -20")`.
     *  Pass a fetch result directly and its readable form is used (`.markdown`, else `.text`). The pipe is the
     *  dialect string, or an ARRAY with one stage per entry (never re-split, so a stage may hold a bare `|`:
     *  `["grep -E error|warn", "head 5"]`). Synchronous and pure — no network, no tokens. Throws an actionable
     *  Error naming the supported verbs if a stage is wrong. */
    pipe(source: string | FetchResult, pipe?: string | string[] | null): string;
    /** Embed text with the configured embedding model, for comparing MEANING rather than spelling. Returns
     *  an {@link Embedding} (or one per input), a unit vector whose `.dot(other)` IS cosine similarity —
     *  normalised on construction, so a model that returns non-unit vectors cannot silently mis-rank. Pass
     *  an array to embed in ONE round trip. `.rank(candidates)` sorts by similarity, which is the shape you
     *  usually want: the useful guard is the MARGIN between the best and the runner-up, not the best score.
     *  Throws when no embedding model is configured, naming the setting. */
    embed<T extends string | string[]>(input: T, opts?: { model?: string }): Promise<T extends string[] ? Embedding[] : Embedding>;
    /** GET a URL's content via the background (bypasses CORS; UNCREDENTIALED BY DEFAULT — no cookies unless you
     *  ask). Use it to READ a page/file the current DOM can't reach — a raw file, a JSON API, another site —
     *  instead of navigating there. Returns a {@link FetchResult}: `.type` classifies the body (json/csv/html/
     *  text) so you can chain (`.json` is pre-parsed; hand `.text` of a CSV to `python_exec`). Each new URL
     *  requires the user's one-time approval (then it's remembered for the session). GET only — no custom
     *  headers or body. `credentials: true` fetches AS THE USER (sends cookies; always prompts, never cached).
     *  `rendered: true` loads the URL in a background tab so its JavaScript runs, then returns the SETTLED DOM
     *  (for SPA / client-rendered pages a raw GET can't see); by default it renders PRIVATELY in incognito (no
     *  session — rememberable like a plain fetch), or in the user's session when combined with `credentials`.
     *  Rendered is never cached.
     *
     *  `format` (default `"markdown"`) NEGOTIATES for the site's OWN Markdown version of a page before falling
     *  back to converting its HTML: the same request asking for Markdown, then any version the page declares,
     *  then the conventional `.md` URL. When one is found `.type` is `"markdown"` and `.text` IS that document;
     *  `.negotiation` records every rung and which one produced the body — the difference between the site's
     *  authored text and our reduction of its markup. `format: "html"` skips all of it for the original markup
     *  in one request. A data body (JSON/CSV/code) never negotiates and costs one request either way. */
    fetch(url: string, opts?: { fresh?: boolean; credentials?: boolean; rendered?: boolean; format?: FetchFormat }): Promise<FetchResult>;
    /** Internal: CACHE-ONLY read of a prior `ml.fetch(url)` result (or undefined on a miss). The read-only
     *  `exec` dialect binds its `ml.fetch` to this, so re-reading an already-fetched URL is free (no egress).
     *  Not part of the stable public API. */
    _fetchCached(url: string, mode?: { credentials?: boolean; rendered?: boolean; format?: string }): FetchResult | undefined;
    config(): Promise<MlPublicConfig>;
    setModel(model: string): Promise<string>;
    ps(): Promise<LoadedModel[]>;
    /** DEBUG DUMP of everything the resource panel derives its timeline from — the `__mlDebug` stream, the
     *  server's event frames, the current ps/info. Underscored: a debugging aid, not API, and its shape may
     *  change freely. `{ download: true }` saves it as a file rather than only returning it. */
    __events(opts?: { download?: boolean }): Promise<Record<string, unknown>>;
    /** One record per model LOAD, collected while the resource panel's "load predictions" toggle is on: the
     *  server's prediction (`estimate`), the load's own figures (`load.complete`), and the measured trace — its
     *  peak, where it settled, and every sample between. For tuning the server's VRAM predictor. Underscored: a
     *  debugging aid, not API. `{ download: true }` saves it as a file; `{ clear: true }` empties the store. */
    __loads(opts?: { download?: boolean; clear?: boolean }): Promise<unknown[]>;
    /** The HOUSEKEEPING LOG: what the system decided on its own — evictions, sweeps, service-worker restarts
     *  (inferred), Python cold starts — oldest first, one structured event each (`{ t, subsystem, kind, reason?,
     *  key?, bytes?, ms?, origin, detail? }`). `origin` says who reported it, and a page sees `key` and string
     *  `detail` values only on events its own tab reported. Underscored: a debugging aid, not API. `{ download: true }` saves it. */
    __housekeeping(opts?: { download?: boolean }): Promise<unknown[]>;
    unload(model?: string | null): Promise<string[]>;
    /** List the OpenWebUI server-side tools available to the configured API key —
     *  the valid ids for `ml.chat`'s `toolIds`, with each one's function specs.
     *  Empty on a bare-Ollama endpoint (no such concept). */
    serverTools(): Promise<ServerTool[]>;
    /** Run ONE of them ourselves, in our own loop, with the arguments we chose — as opposed to `ml.chat`'s
     *  `toolIds`, which hands the whole loop to the model. PRIVILEGED (the user's API key, a caller-chosen
     *  tool), so from an untrusted page it only runs a call an agent run already approved. Needs the
     *  patched OpenWebUI — see docs/FORKED-BACKENDS.md. */
    execServerTool(toolId: string, name: string, args?: Record<string, unknown>, options?: { onOutput?: (text: string, ts?: number) => void; signal?: AbortSignal }): Promise<ServerToolResult>;
    /** The same tools as a callable NAMESPACE — `ml.dynamicTools.<bundle>.<fn>(args)`, with the function's
     *  own `.schema` on the callable and the arguments checked against it before anything is dispatched.
     *  See `dynamic-tools.ts`. */
    dynamicTools: import("./dynamic-tools").DynamicToolNamespace;
    /** @internal memoised namespace behind {@link dynamicTools}. */
    _dynamicTools?: import("./dynamic-tools").DynamicToolNamespace;
    /** The machine's memory CAPACITY — per-device VRAM totals/free and system RAM (Ollama `/api/info`).
     *  `ml.ps()` says what is RESIDENT; this says what there is room for. Returns `null` when the route
     *  isn't available (stock Ollama, or an OpenWebUI without the passthrough) — treat that as "capacity
     *  unknown", never as zero. All figures are raw BYTES and BINARY. */
    info(): Promise<OllamaInfo | null>;

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
    _resolveTable(target: string | Element, raw?: boolean): { kind: "rows"; columns: string[]; rows: (string | number | boolean | null)[][] } | { kind: "html"; html: string };
    _loadTable(name: string, src: string | Element | TableValue, raw?: boolean): Promise<{ name: string; source: TableSource; preview?: (string | number | boolean | null)[][]; rowCount?: number; data: { kind: "rows"; columns: string[]; rows: (string | number | boolean | null)[][] } | { kind: "html"; html: string } | { kind: "value"; key: string; label: string; columns: string[]; delimiter?: string; headerless?: boolean } }>;
    _resolveVisionModel(agentModel: string | null, vision: boolean | string | null): Promise<string | null>;
    _modelSees(model: string | null): Promise<boolean>;
    _nativeLookTool(memory?: VisionMemory): MlTool;
    /** Cross-page persistence: rebuild a run's BUILTIN toolset from a serializable RebuildConfig (tool names
     *  + carried vision facts) on a fresh document after a same-site navigation. */
    _rebuildToolset(rebuild: RebuildConfig): MlTool[];
    /** Cross-page persistence: re-adopt a background-hosted run on a fresh document — rebuild + re-register
     *  its toolset so the held delegated tool can run here (called from the CONTENT_READY → adopt round-trip). */
    _adoptRun(runId: string, rebuild: RebuildConfig): void;
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

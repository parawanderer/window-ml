/**
 * @file Shared interfaces for window.ml — the contracts the main-world primitive
 * (injected), the content-script relay (content), the background worker
 * (background), and the debug sidebar all agree on. Types only; erased at build.
 * Import with `import type { ... } from "./contract"` so nothing survives to JS.
 */

// Type-only (erased): the curated answer-set class, referenced by ToolContext.answer. answer-set.ts
// imports AnswerMedia back from here — a type-only cycle, which is fine.
import type { AnswerSet } from "./answer-set";
// Type-only: the unit-vector wrapper `ml.embed` resolves to. embedding.ts imports nothing, so no cycle.
import type { Embedding } from "./embedding";

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

/** The lexical metrics that can rank a near-miss on a pointer LABEL. Names here (shared config surface),
 *  implementations in label-match.ts. */
export const LEXICAL_METRICS = ["hybrid", "edit", "trigram", "tokenset"] as const;
export type LexicalMetric = (typeof LEXICAL_METRICS)[number];

/** Full config held in chrome.storage.sync (background + popup own it). */
export interface MlConfig {
    chatUrl: string;
    apiKey: string;
    /** The default model the user has configured for tasks, used when no model is specified for ml.chat("…") or ml.agent("…"). May not always be set. */
    model: string;
    apiFormat: ApiFormat;
    /** OCR/vision model used for vision tasks by default, e.g. in ml.read(…). May not always be set. */
    ocrModel: string;
    /** Context window (Ollama num_ctx) for ml.read's OCR call — kept SMALL by default so the OCR model
     *  doesn't load at its full 256K window (a huge KV allocation for a task that needs a few K tokens).
     *  Overridable per-call via ml.read(img, { numCtx }); a model already resident at a bigger window is
     *  reused, not reloaded (prepareRequest's residency guard). */
    ocrNumCtx: number;
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
    /** Which lexical metric ranks a near-miss on a pointer LABEL. Swappable because it is genuinely
     *  undecided: measured on the motivating cases, plain edit distance INVERTS (it ranks a different table
     *  above the correct one reworded), token-set is perfect on rewording and blind to typos, and trigram
     *  survives both without excelling. `hybrid` (the better of the last two) is the default. Exposed so the
     *  benchmark can vary it — see docs/POINTER-IDENTIFIERS.md. */
    labelMatch: LexicalMetric;
    /** Model used for `ml.embed`. Only models reporting the `embedding` capability are offered in Settings.
     *  Empty = no embedding model configured, and `ml.embed` says so rather than guessing one. */
    embeddingModel: string;
    /** Keep the embedding model RESIDENT with no expiry (Ollama `keep_alive: -1`). Default ON, and the
     *  argument is the access PATTERN rather than the model's size: measured, a cold embed costs 2726ms
     *  against 95ms warm — 29x — and a label-resolution fallback fires rarely and unpredictably, so under
     *  Ollama's default 5-minute expiry it would be almost always cold. Sparse use is exactly the pattern a
     *  timeout never helps. Evicting it from the VRAM panel still works and needs no state here: keep_alive
     *  is sent per request, so the next call simply re-pins it. */
    embeddingKeepAlive: boolean;
    /** Run the embedding model on CPU (`num_gpu: 0`). Default ON: measured, CPU is 33ms slower warm
     *  (128 vs 95), FASTER cold (1628 vs 2726 — no VRAM transfer), and uses zero VRAM. On a box whose GPU is
     *  holding the chat model, spending ~700MB of VRAM to save 33ms is the wrong trade. Turn it off if the
     *  embedding model is large enough that CPU inference stops being cheap. */
    embeddingForceCpu: boolean;
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
    /** include the FULL tool definitions (pretty JSON) in a run's markdown/PDF export (default off — spammy) */
    exportToolDefs: boolean;
    /** experimental: auto-approve read-only exec surveys via the mediated interpreter */
    autoApproveReadonly: boolean;
    /** experimental: auto-approve python_exec (the sandbox is isolated by construction) */
    autoApprovePython: boolean;
    /** also pierce CLOSED shadow roots. A document_start patch (shadow-patch.ts, main world) wraps
     *  attachShadow to capture each closed root as it's created; when this is ON the DOM tools treat those
     *  captured roots like open ones (same `host >>> inner` syntax). ON by default — the capture patch runs
     *  on every page regardless of this flag (the main world can't read config at document_start), so this
     *  only gates whether the tools USE the captured roots; on is strictly more capable at no extra cost.
     *  Declarative (`shadowrootmode=closed`) / native roots still can't be captured, so the tools keep
     *  steering those to visual `locate`/@pt. */
    pierceClosedShadow: boolean;
    /** experimental: let the agent CLICK "reserved" surfaces — cross-origin iframes and declarative/native
     *  closed shadow roots — that no selector or synthetic click can reach, AND run imperative `exec` on
     *  strict-CSP / Trusted-Types pages where main-world eval is blocked — via chrome.debugger (CDP)
     *  Input.dispatchMouseEvent / Runtime.evaluate (real, trusted, CSP-exempt). Off by default; also needs
     *  the runtime `debugger` permission (requested when you enable this) and the per-action approval.
     *  Attaching flashes Chrome's "is debugging" banner — only for these reserved actions, so the flash marks
     *  the risk. Specs: docs/spec/CDP_CLICK.md, docs/spec/EXEC_STRICT_CSP.md. */
    cdp: boolean;
    /** Advanced, default OFF. When ON, a SAME-ORIGIN fetch that uses the user's cookies/session — a
     *  `credentials:true` GET, or a `rendered:true` load in a normal (non-incognito) tab — auto-approves
     *  (no prompt), like a same-origin navigate. OFF → those always ask, so the user stays in charge of when
     *  their session is spent. NEVER affects CROSS-origin (always asks) or the uncredentialed same-origin free
     *  path (already free). */
    autoApproveSameOriginAuth: boolean;
    /** Default ON. When ON, an UNCREDENTIALED `fetch_url`/`ml.fetch` GET of the agent's OWN repo SOURCE —
     *  committed files (raw.githubusercontent) or structural/code API endpoints (api.github /repos), locked to
     *  `BUILD_INFO.repoUrl` — auto-approves (no prompt), so the agent can read its own code. Never applies to
     *  user-generated PROSE endpoints (issues/pulls/comments/discussions/reviews/releases — a prompt-injection
     *  surface) or a credentialed fetch: those still ask. See self-source.ts. */
    autoApproveSelfSource: boolean;
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

/** Does this model generate TEXT? The right test for the chat/utility/vision pickers.
 *
 *  Measured against a real Ollama (2026-09-03): the obvious rule — "hide anything with `embedding`" — is
 *  WRONG. `qwen3-embedding:0.6b` reports `['tools','thinking','embedding']` and `:8b` reports
 *  `['tools','embedding']`, so an embedding model can advertise other capabilities too. Requiring
 *  `completion` is the semantically correct test, and no embedding model has it.
 *
 *  Unknown (null) capabilities mean a cloud/non-Ollama model, which we CANNOT classify — so it passes.
 *  Failing open matches `modelFilter`: never hide a model we merely failed to interrogate. */
export const generatesText = (caps: string[] | null): boolean => !caps || caps.includes("completion");

/** Does this model produce EMBEDDINGS? Unlike {@link generatesText} this fails CLOSED — an unclassifiable
 *  model is not offered as an embedding model, because picking one that turns out not to embed produces a
 *  confusing runtime failure rather than a mildly shorter list. A user can still name one explicitly and
 *  have it validated by an actual embed call. */
export const producesEmbeddings = (caps: string[] | null): boolean => !!caps && caps.includes("embedding");

/** What a pointer READ returns across the run boundary: the value, plus an optional advisory the caller must
 *  surface on a SIDE channel. The two exist separately because `ml.dereference` inside `exec` returns a value
 *  the script then operates on — JSON.parse it, split it, pipe it — so appending a note to `value` would
 *  corrupt the data. The tool path appends the advisory to its result text; the exec path console.warn()s it. */
/** What the value at a pointer actually IS. The loop knows — it holds the step's `RenderDescriptor` — so the
 *  pointer carries its type rather than flattening everything to text the reader must re-sniff. */
export type TokenKind = "text" | "json" | "table" | "image" | "code";

/** The pointer's metadata, travelling BESIDE the text so a script can branch on what it got rather than
 *  guessing from the bytes. Every field is JSON-serializable: the same read crosses the page↔background
 *  relay when the run is background-hosted. */
export interface DerefMeta {
    /** The stable id, even when the read came in through a tool-name alias. */
    id: string;
    tool: string;
    kind: TokenKind;
    /** The step that captured it — with the reader's own step, this is the value's age. */
    step: number;
    /** The model's own short name for it, when it gave one. A claim, not a fact. */
    label?: string;
    /** The structural value, when the step produced a grid — no need to reparse a rendered table. */
    table?: { columns: string[]; rows: unknown[][] };
    /** A `data:image/…;base64,…` URL when the step produced an image. */
    image?: string;
    latex?: string;
}

export interface DerefRead { value: string; warning?: string; meta?: DerefMeta }

/**
 * What `ml.dereference` resolves to: the pointer's text, with what the loop knows about it attached.
 *
 * It IS a string at runtime (a `String` subclass), so everything that worked when this returned a bare
 * string still does — `JSON.parse(await ml.dereference(id))`, template literals, `.split`, `.length`. The
 * metadata rides along for the cases that had to guess before: whether a value is JSON worth parsing,
 * whether it is an image rather than text, how old it is.
 *
 * The one behaviour that changes: `typeof` is `"object"`, so a `typeof x === "string"` check now fails.
 * Compare `x.text`, or call `String(x)`.
 */
export interface DerefValue extends String {
    /** The text, explicitly — the same string the previous contract returned. */
    readonly text: string;
    /** What this is, from the capturing step's render descriptor. */
    readonly type: TokenKind;
    readonly id: string;
    readonly tool: string;
    readonly step: number;
    readonly label?: string;
    /** The parsed body when the text is JSON, else undefined. Parsed once, lazily. */
    readonly json?: unknown;
    readonly table?: { columns: string[]; rows: unknown[][] };
    readonly image?: string;
    readonly latex?: string;
    /** Reduce it further through the text-pipe dialect, resolving to a new value. */
    pipe(stages: string | string[]): Promise<DerefValue>;
    /** The TS-like shape of it, when it is JSON (see `ml.schema`). Throws on non-JSON. */
    schema(): string;
}

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

/** Build an `Accept-Language` header value from the browser's language list (navigator.languages), the way a
 *  real browser sends it: the first language at q=1.0, each later one at a descending q-weight (floored at
 *  0.1). ["en-US","en","fr"] → "en-US,en;q=0.9,fr;q=0.8". Dedupes, trims, drops empties. Pure (unit-tested);
 *  used to make an ml.fetch request look like it came from the user's own browser. Empty list → "". */
export function acceptLanguageFrom(langs: string[]): string {
    const seen = new Set<string>();
    const clean = (langs || []).map(l => (l || "").trim()).filter(l => l !== "" && !seen.has(l) && (seen.add(l), true));
    return clean.map((l, i) => i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i * 0.1).toFixed(1)}`).join(",");
}

/** Is this error message a BACKEND-UNREACHABLE failure (server down / wrong host / refused / DNS / TLS) —
 *  as opposed to an HTTP status error (a reachable server that rejected the request)? The background
 *  translates a bare fetch reject into "Couldn't reach the server at …"; this also catches the raw forms
 *  in case one slips through (Failed to fetch / NetworkError / ERR_CONNECTION_* / ECONNREFUSED / Could not
 *  reach). Pure; shared by the HUD card + the devtools panel banner so both flag the same condition. An
 *  HTTP 4xx/5xx is NOT unreachable — the box answered. */
export function isBackendUnreachable(msg?: string | null): boolean {
    if (!msg) return false;
    if (/^HTTP\s\d/i.test(msg)) return false;   // "HTTP 500 from …" = reachable, it answered
    return /couldn't reach the server|could not reach|failed to fetch|networkerror|err_connection|err_name_not_resolved|econnrefused|enotfound|net::err/i.test(msg);
}

/** Per-tool output truncation limits. The agent alone is capped at `default` (so it can't spam its own
 *  context); a human can unlock up to `ceiling` for one call, never past it. */
export const OUTPUT_CAP = {
    exec: { default: 500, ceiling: 8000 },
    python_exec: { default: 2000, ceiling: 20000 },
} as const;
export type OutputCapTool = keyof typeof OUTPUT_CAP;

/** Resolve a tool call's effective output cap and whether RAISING it is an escalation that needs the human
 *  gate + a justification. `requested` is the call's `maxChars` arg (undefined → the default). A value at or
 *  below the tool default is free — a smaller cap is harmless, so it never escalates. A value above the
 *  default is clamped to the ceiling and flagged `escalated`; `reasonMissing` is true until the model gives a
 *  non-empty `reason`. Pure — unit-tested. The escalation decision is enforced in the trusted world (the
 *  readonly try for exec, autoApprovePython for python), so a page can't forge "this raise is fine". */
export function resolveOutputCap(
    tool: OutputCapTool,
    requested?: unknown,
    reason?: unknown,
): { cap: number; escalated: boolean; reasonMissing: boolean; clamped: boolean; def: number; ceiling: number } {
    const { default: def, ceiling } = OUTPUT_CAP[tool];
    const n = typeof requested === "number" && isFinite(requested) ? Math.floor(requested) : null;
    if (n == null || n <= def) {
        // Absent/invalid → default; a positive smaller value is honored (a tighter cap is always allowed).
        return { cap: n != null && n > 0 ? n : def, escalated: false, reasonMissing: false, clamped: false, def, ceiling };
    }
    const cap = Math.min(n, ceiling);
    const hasReason = typeof reason === "string" && reason.trim().length > 0;
    return { cap, escalated: true, reasonMissing: !hasReason, clamped: n > ceiling, def, ceiling };
}
/** True when a call's `maxChars` raises the cap above the tool default (→ must not auto-approve). */
export function outputCapEscalated(tool: OutputCapTool, args: Record<string, unknown>): boolean {
    return resolveOutputCap(tool, (args as { maxChars?: unknown }).maxChars, (args as { maxCharsReason?: unknown }).maxCharsReason).escalated;
}
/** The precheck error shown when a raise lacks its required justification (→ the loop skips the gate and the
 *  model retries WITH a reason, so the human sees the justification on the approval card). Null when fine. */
export function outputCapPrecheck(tool: OutputCapTool, args: Record<string, unknown>): string | null {
    const c = resolveOutputCap(tool, (args as { maxChars?: unknown }).maxChars, (args as { maxCharsReason?: unknown }).maxCharsReason);
    if (c.escalated && c.reasonMissing) return `Error: raising the output limit to ${c.cap} chars needs a justification. Pass \`maxCharsReason\` explaining why THIS call needs more than the default ${c.def} chars — the human sees it when approving. (Prefer returning a filtered summary instead.)`;
    return null;
}

/** `FETCH_URL` payload — a GET the background performs on the agent's behalf (bypassing CORS via host
 *  permissions). Uncredentialed by default; `credentials` sends the user's cookies, `rendered` loads it in a
 *  tab so its JS runs (incognito unless credentialed). No headers/body/method knobs by design: a locked,
 *  low-surface read primitive. */
export interface FetchUrlPayload { url: string; credentials?: boolean; rendered?: boolean; format?: FetchFormat; }

/** What DOCUMENT a fetch goes and gets — a fetch-level concern, so it is the one option shared by `ml.fetch`
 *  and the `fetch_url` tool. `"markdown"` (the default) runs the negotiation ladder for the site's OWN
 *  Markdown; `"html"` skips it entirely and returns the original markup in one plain GET. Data bodies
 *  (json/csv/code) are unaffected either way. This REPLACED `raw`, which straddled the line between "what do
 *  we fetch" and "what does the model receive" and so read as a second, overlapping knob. */
export type FetchFormat = "markdown" | "html";

/** One rung of the Markdown ladder, as it actually ran. Recorded for every attempt — including the ones that
 *  were skipped — because the failure modes here are INVISIBLE in the body alone: a stub twin is a valid 200
 *  Markdown document that is simply the wrong page, and a site-authored twin is content written specifically
 *  to be read by agents (GitBook appends an "Agent Instructions" section), so "which URL did these bytes come
 *  from" is provenance for an injection surface, not decoration. */
export interface FetchAttempt {
    /** `accept` = the same URL with `Accept: text/markdown`; `declared` = the `<link rel="alternate">` the
     *  page named; `sibling` = the derived `.md`/`index.md`; `convert` = our own HTML→Markdown. */
    strategy: "accept" | "declared" | "sibling" | "convert";
    url: string;
    status?: number;
    contentType?: string;
    bytes?: number;
    ms?: number;
    outcome: "hit" | "not-markdown" | "error" | "skipped";
    /** Why, when the outcome needs one ("not attempted — already resolved", a cross-origin declaration). */
    note?: string;
}

/** The ladder's trace: what was tried, what worked, what was never needed. */
export interface FetchNegotiation {
    wanted: FetchFormat;
    attempts: FetchAttempt[];
    resolvedBy: FetchAttempt["strategy"];
}
/** The result of `ml.fetch(url)`. Content type is resolved BOTH ways so a mislabel is visible: `type` is the
 *  final pick (header when specific, else the content sniff), `typeByHeader`/`typeByContent` are the raw
 *  signals. `json` is pre-parsed when `type === "json"`. `text` is the raw body (size-capped → `truncated`). */
export type ContentKind = "json" | "csv" | "html" | "xml" | "markdown" | "code" | "text";
export interface FetchResult {
    url: string;              // the response URL (after any redirects)
    status: number;           // HTTP status code
    ok: boolean;              // status in 200–299
    type: ContentKind;        // the resolved kind (header, else structured content, else URL extension, else text)
    language?: string;        // for type === "code": the language from the URL extension ("typescript", "python", …)
    typeByHeader: ContentKind | null;   // null = the header was generic (text/plain, octet-stream, …)
    typeByContent: ContentKind;         // the structural content sniff
    typeByExtension: { type: ContentKind; language?: string } | null;   // the URL-extension cue
    contentType: string;      // the raw Content-Type header
    text: string;             // the body, raw (capped)
    markdown?: string;        // for type === "html": a clean Markdown distillation (scripts/nav/chrome stripped),
                              // attached by ml.fetch so any caller reads the content without re-converting; `.text` is still the raw HTML
    json?: unknown;           // parsed JSON when type === "json" and it parsed
    schema?: string;          // a compact TS-like SHAPE of `json` (see dom.ts jsonShape) — the structure to
                              // write code against without the whole payload; present iff `json` is set
    truncated?: boolean;      // the body was clipped to the size cap
    redirected?: boolean;     // the request followed ≥1 redirect (`url` above is the FINAL landing URL — the
                              // intermediate chain isn't visible to fetch; a redirect log needs chrome.webRequest)
    /** The Markdown ladder's trace, when negotiation ran (absent for `format: "html"` and for data bodies that
     *  never negotiate). `resolvedBy` says which rung produced `text` — in particular whether the Markdown is
     *  the SITE's or our own Turndown reduction, which is the difference that matters when debugging why a
     *  model missed a detail. */
    negotiation?: FetchNegotiation;
    rendered?: boolean;       // the body is the SETTLED DOM after the page's JS ran in a background tab (rendered
                              // mode), not the raw HTTP response — so client-rendered/SPA content is present
    /** A SAFELIST of NON-SENSITIVE response headers — the ONLY headers ever exposed. Auth-bearing headers
     *  (Cookie, Set-Cookie, Authorization, WWW-Authenticate, CSRF/API-key headers, …) are STRUCTURALLY excluded
     *  and never appear here, so a fetch can never leak the user's session. Each field is absent when the server
     *  didn't send it. (Rendered mode is a DOM snapshot, not an HTTP response, so it has none of these.) */
    headers?: {
        link?: string;               // RFC-5988 pagination (rel="next"/"last") — count or page through a list API
        etag?: string;               // opaque version tag (caching / optimistic concurrency)
        lastModified?: string;       // the resource's last-modified date
        retryAfter?: string;         // 429/503 backoff — seconds, or an HTTP date
        contentLength?: string;      // the server's declared body size in bytes
        contentDisposition?: string; // e.g. `attachment; filename="report.zip"` — the intended download filename
        cacheControl?: string;       // cache directives (max-age, no-store, …)
        date?: string;               // the server's response date
    };
}

/** Append a debug event to a per-tab HUD replay ring, dropping the oldest past `cap` — but NEVER dropping a
 *  run's `agent` START event. A re-adopting page (cross-page / cross-DOMAIN nav) rebuilds its corner card from
 *  this replay; without the start the reducer can't CREATE the session, so every replayed step orphans and the
 *  card renders EMPTY ("the HUD never appears after a navigate"). This bit the cross-domain case because a LONG
 *  prior session overflowed the ring and evicted the start. Re-pin any dropped start at the head (usually 0-1).
 *  Mutates `buf`. Pure — unit-tested in tests/replay.test.mjs. */
export function pushReplay(buf: unknown[], event: unknown, cap: number): void {
    buf.push(event);
    if (buf.length <= cap) return;
    const dropped = buf.splice(0, buf.length - cap);
    const lostStarts = dropped.filter(e => (e as { kind?: string })?.kind === "agent");
    if (lostStarts.length) buf.unshift(...lostStarts);   // the session-creating events survive the cap
}

/** How stale a persisted background-run snapshot may be and still auto-resume. A real MV3 eviction respawns
 *  within seconds and each step re-stamps the snapshot, so a live run's snapshot is always fresh; anything
 *  older than this is a zombie (the SW died and never came back for it) and must NOT be silently resumed. */
export const STALE_BGRUN_MS = 5 * 60 * 1000;
/** Decide whether a persisted background-run snapshot may be RESUMED on SW startup, or must be invalidated.
 *  A snapshot from a DIFFERENT extension version (a reload/update happened between writing and reading it —
 *  its code may be incompatible, and a reload is often how you kill a runaway) or a STALE one (older than a
 *  live eviction-respawn would ever be) is dropped, never resumed. An un-stamped legacy snapshot (no version)
 *  fails the version check and is purged — the self-heal for zombies written before this guard shipped.
 *  Pure — unit-tested (`tests/bgrun.test.mjs`); the SW deletes the storage key when this returns false. */
export function bgRunResumable(snap: { version?: string; ts?: number }, currentVersion: string, now: number): boolean {
    if ((snap.version || "") !== currentVersion) return false;              // cross-version → a reload/update invalidates it
    if (snap.ts != null && now - snap.ts > STALE_BGRUN_MS) return false;    // stale → no live respawn is ever this old
    return true;
}

/** Sanitize composer image attachments relayed from the sidebar app (a pasted/uploaded screenshot):
 *  keep only `data:image/*` strings, size-capped so a runaway paste can't bloat a postMessage, max 8 per
 *  turn. Returns undefined when there's nothing valid (keeps the relayed message clean). Pure; shared by
 *  the overlay shell and the DevTools panel relays so both validate identically. */
export function cleanImages(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    const out = v.filter((x): x is string => typeof x === "string" && /^data:image\//.test(x) && x.length <= 8_000_000).slice(0, 8);
    return out.length ? out : undefined;
}

/** The clean, token-efficient context payload for a right-click "ask about this" — what it sends instead
 *  of a screenshot or raw HTML. Block-structured visible TEXT + the media/links the model would otherwise
 *  miss + a `selector` scope handle so the agent's DOM tools (click/read/findByText) keep working inside
 *  the resolved container. Built page-side by domToContext; travels the bus to the Commander pill. */
export interface ElementContext {
    selector: string;                              // the container's scope handle (clickSelector)
    role: string;                                  // ARIA role (roleOf) — "article", "listitem", …
    text: string;                                  // clean block-structured visible text (capped)
    anchorText?: string;                           // the leaf the user actually right-clicked
    media: { src: string; alt: string }[];
    links: { text: string; href: string }[];
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
    ocrNumCtx: 8192,
    defaultModelVision: "",
    modelFilter: "",
    debugMode: "off",
    labelMatch: "hybrid",
    embeddingModel: "",
    embeddingKeepAlive: true,
    embeddingForceCpu: true,
    theme: "auto",
    cardCorner: "bottom-right",
    agentHud: "progress",
    agentHudInDevtools: false,
    utilityModel: "",
    utilityNumCtx: 4096,
    utilityForceCpu: false,
    autoTitles: true,
    exportToolDefs: false,
    autoApproveReadonly: true,
    autoApprovePython: true,
    autoApproveSameOriginAuth: false,   // Advanced, default off: a same-origin as-you fetch always asks
    autoApproveSelfSource: true,        // default on: an uncredentialed read of the agent's OWN repo source is free
    pierceClosedShadow: true,
    cdp: false,
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
    "model" | "ocrModel" | "ocrNumCtx" | "apiFormat" | "utilityModel" | "utilityNumCtx" | "utilityForceCpu" | "autoApproveReadonly" | "autoApprovePython" | "autoApproveSameOriginAuth" | "autoApproveSelfSource" | "pierceClosedShadow" | "cdp" | "groundingEnabled" | "groundingModel" | "groundingRange" | "debugMode" | "defaultModelVision" | "labelMatch"> & {
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
    /** Wall-clock ms of THIS model call, measured at the source (around the fetch). ALWAYS available; it
     *  includes the call's own network/queue latency (TTFT) — the honest "time spent waiting on the model". */
    genMs?: number;
    /** Ollama-native `eval_duration` (generation-only, ns → ms) when the native route reports it. PREFERRED
     *  over `genMs` for a tok/s rate (it excludes network/queue); absent for cloud / OpenWebUI-OpenAI. */
    evalMs?: number;
    /** Ollama-native `load_duration` (ns → ms): how long THIS call spent loading the model before generating.
     *  Small and constant when the model was already resident; seconds-to-a-minute when it was not — which is
     *  the difference between "the model was slow" and "the model wasn't there yet", and the only place that
     *  answer exists. Absent for cloud / OpenWebUI-OpenAI, which don't report it. */
    loadMs?: number;
}

/** How much captured tool output the UI keeps. Deliberately FAR larger than the model-facing cap: the model's
 *  clip protects its context budget, but the human watching a stream shouldn't see the output SHRINK when the
 *  step finishes. The surplus is shown MARKED as "captured, but not sent to the model" (see `seen`), so the two
 *  views never get confused. Shared by exec / python_exec and the loop's live-stream fan so live == final. */
export const UI_OUT_CAP = 12000;

/** Whole-run token accounting, cumulative across every model call — the numbers API consumers care about
 *  (spend) plus a generation rate. Computed by {@link runStats} and shared by the DevTools bottom bar, the
 *  chat_metadata tool, and the exports so all three agree. */
export interface RunStats {
    inTokens: number;      // cumulative prompt-token SPEND: Σ promptTokens (billed every call — a real sum, unlike live occupancy)
    outTokens: number;     // cumulative completion tokens (all generated output, incl. thinking)
    totalTokens: number;   // in + out
    calls: number;         // model calls that reported usage
    tokPerSec: number | null;   // outTokens ÷ Σ per-call generation seconds; null when no timing was captured
    genBasis: "eval" | "wall" | "mixed" | null;   // eval = Ollama generation-only; wall = includes network/queue; mixed = some of each
}

/** Fold per-call usage samples into a whole-run summary. Cumulative in/out are SUMS (each call is billed the
 *  full prompt it re-sends). The tok/s denominator prefers Ollama's `evalMs` (generation-only) per call and
 *  falls back to the wall-clock `genMs` (which includes that call's network/queue) — `genBasis` records which,
 *  so a surface can be honest about what the rate measures. Pure; null/empty samples are skipped. */
export function runStats(usages: readonly (TokenUsage | null | undefined)[]): RunStats {
    let inTokens = 0, outTokens = 0, totalTokens = 0, calls = 0;
    let ratedOut = 0, genMs = 0, evalCount = 0, wallCount = 0;   // rate basis: only calls that carried timing
    for (const u of usages) {
        if (!u) continue;
        calls++;
        inTokens += u.promptTokens || 0;
        outTokens += u.completionTokens || 0;
        totalTokens += u.totalTokens || ((u.promptTokens || 0) + (u.completionTokens || 0));
        const ms = u.evalMs ?? u.genMs;   // prefer generation-only (Ollama); else wall-clock (incl. network)
        if (ms != null && ms > 0) {
            genMs += ms; ratedOut += u.completionTokens || 0;
            if (u.evalMs != null) evalCount++; else wallCount++;
        }
    }
    const tokPerSec = genMs > 0 ? ratedOut / (genMs / 1000) : null;
    const genBasis = (evalCount || wallCount) ? (evalCount && wallCount ? "mixed" : evalCount ? "eval" : "wall") : null;
    return { inTokens, outTokens, totalTokens, calls, tokPerSec, genBasis };
}

/** The tok/s rate as a short display string ("42 tok/s" / "6.3 tok/s"), or null when no timing was captured. */
export function fmtTokPerSec(s: RunStats): string | null {
    if (s.tokPerSec == null) return null;
    return `${s.tokPerSec >= 100 ? Math.round(s.tokPerSec) : s.tokPerSec.toFixed(1)} tok/s`;
}

/** A one-line PROVENANCE explanation for the tok/s figure — what the denominator actually measured — for a
 *  hover tooltip, so the rate is never presented as more precise than it is. */
export function runStatsProvenance(s: RunStats): string {
    const basis = s.genBasis === "eval" ? "Ollama generation time (eval_duration — excludes network/queue)"
        : s.genBasis === "wall" ? "wall-clock per model call (includes network + queue latency)"
        : s.genBasis === "mixed" ? "Ollama generation time where reported, else wall-clock (includes network)"
        : "no per-call timing was available";
    const rate = s.tokPerSec == null ? `rate unavailable — ${basis}` : `${s.outTokens} generated tokens ÷ ${basis}`;
    return `${rate}. Cumulative spend: ${s.inTokens} in + ${s.outTokens} out across ${s.calls} model call${s.calls === 1 ? "" : "s"}.`;
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
/** Per-run near-area vision memory shared by the auto-wired `look` + `locate`. Records the viewport
 *  points whose marked crop the DRIVER has already been shown (a `look({@pt})` or a `locate` auto-inject),
 *  so `locate`'s snap-feedback doesn't re-inject a near-identical crop the model already has in context
 *  (the re-snap-loop case). `seen` grows for the run's lifetime; near-area = within `SEEN_RADIUS` px. */
export interface VisionMemory {
    seen: { x: number; y: number }[];
    /** DOM-legend boundary lines (cross-origin/same-origin iframe + shadow-root notices) already shown to
     *  the driver this run, so a look/locate crop doesn't RE-append the identical structural warning on
     *  every vision turn. Deduped by exact string — a genuinely new boundary still shows. */
    boundariesSeen?: Set<string>;
}

/** What a tool fed back INTO the model's context, for the debug render + export to surface (the model
 *  received it via the normal channels — an inline image, or appended result text). `locate`'s snap-inject
 *  sets it: a marked crop (vision driver) or a delegated description (text-only driver), plus the `reason`
 *  it was sent (a point is automatic; a selector/@box only when `verify:true`). */
export interface ToolFeedback {
    reason: string;
    via: "image" | "text";
    /** the marked crop (data URL) — shown in the render even for a text-only driver (what got described) */
    image?: string;
    /** the delegated description text (via:"text" only) */
    text?: string;
    /** the exact prompt the reader was asked over the crop (via:"text") — shown in the debug render + export */
    prompt?: string;
    label?: string;
}

/** A serialized VISUAL of an element designated via `answer` — rendered in the HUD "Task complete" card
 *  (user-facing output), NOT the debug sidebar. Data URLs so it crosses the window bus (real nodes can't).
 *  `kind` "image" = an <img>'s own full-res picture; "element" = a screenshot crop of any other element.
 *  `mode` = how the card PRESENTS it: "inline" shows the picture; "highlight" is a compact chip that points
 *  at the live element on the page. Hovering EITHER highlights the element on the page (via `selector`, the
 *  same debug highlighter the sidebar uses). Default per kind: image→inline, element→highlight. */
export interface AnswerMedia { image: string; label?: string; selector?: string; kind?: "image" | "element"; mode?: "inline" | "highlight" }

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
    | { type: "python-out"; stdout?: string; seen?: number; image?: string; token?: string; value?: string; error?: string; latex?: boolean; df?: { columns: string[]; rows: (string | number | null)[][] } }
    // `exec`'s Out, the JS twin of python-out: the SAME data its raw result string carries, split into
    // sections (console / value / error) so a JS run reads like a notebook cell too instead of one blob.
    | { type: "exec-out"; stdout?: string; seen?: number; value?: string; error?: string; token?: string }
    // A DELEGATED `look`'s Out slot: the exact image the vision reader saw, WHICH model read it, and
    // its text output — so a sub-call look reads like `locate`'s substeps (the native look just shows
    // the screenshot, since the agent itself is the viewer).
    | { type: "look"; image: string; model?: string | null; output: string; label?: string; prompt?: string }
    // A tool's INTENT for the user-facing approval card — the deterministic, human-readable description
    // of what the call will DO, produced by the tool's own `render` (so a custom approval-gated tool can
    // describe itself; a tool that returns none falls back to a utility-model description). `verb` is the
    // action ("Click"/"Type"), `kind` the noun ("button"/"link"/"field"/"point"), `target` the human
    // label (accessible name/text), `selector` the page target to HIGHLIGHT (CSS or @pt/@box), `input`
    // any value being entered (type), `note` an extra clause ("then submit"). Rendered in the debug In
    // slot too (as a hoverable line), so both surfaces agree.
    // `ask` (fetch_url distill): the question; `answeredBy`/`tokens` the reader sub-call's provenance; and
    // `askBody`/`askBodyLang`/`askBodyTruncated` the RAW fetched content handed to that reader — the
    // in-the-middle step, shown as a collapsed code block (like locate's per-substep prompt), so the distill
    // is auditable: you can read exactly what the model saw before it answered.
    // `pipe` (fetch_url): the grep/head/tail/… shell pipeline the model scanned the fetched text through —
    // shown as a `bash` code block in the In slot so it reads as the interpreted command it is.
    // `attempts`/`resolvedBy` (fetch_url): the Markdown ladder as it actually ran — rendered as a resolution
    // TREE, every rung shown including the ones never needed. Not decoration: a stub twin is a valid 200
    // Markdown document that is simply the wrong page, so "which URL did these bytes come from" is the only
    // place that failure is visible; and the winning rung says whether the Markdown is the SITE's authored
    // text or our own reduction of its markup. Present only on the POST-call render (the approval card's
    // `render()` runs before any rung has been tried).
    | { type: "action"; verb: string; kind?: string; target?: string; selector?: string; input?: string; note?: string; crossOrigin?: string; ask?: string; answeredBy?: string; tokens?: number; askBody?: string; askBodyLang?: string; askBodyTruncated?: boolean; pipe?: string; attempts?: FetchAttempt[]; resolvedBy?: FetchAttempt["strategy"] }
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
    /** multiple inline images the tool sent the model (look's overlay + no-overlay crops) — the Out render
     *  shows the FIRST when there's no single `image`, so a multi-crop look still renders its screenshot */
    images?: { image: string; label?: string }[];
    /** an Out render the tool's run() precomputed (wins over auto-derive) */
    render?: RenderDescriptor;
    /** an In render the tool's run() precomputed (wins over the render() method) */
    renderIn?: RenderDescriptor;
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
}

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
    | { kind: "table"; columns: string[]; rows: (string | number | null)[][] }   // a DataFrame / DOM table → a 2D matrix + its header
    | { kind: "value"; value: unknown }        // a scalar / a python dict-or-list (PARSED to the real JS object when it was JSON)
    | { kind: "image"; dataUrl: string }       // a screenshot / returned image, as a data: URL
    | { kind: "code"; text: string; lang?: string }             // the executed source (a `:in` citation)
    | { kind: "elements"; items: { path: string; text?: string }[] }   // serialized element previews (live nodes are in AgentResult.elements)
);

/** INTERNAL: a citable step's render + raw result, carried out of the loop so the outputs resolver can build
 *  {@link AgentOutput}s from the tokens the answer actually cites. */
export interface TokenRender { id: string; tool: string; render?: RenderDescriptor; result?: string }

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
    /** Toggle the model's separate reasoning pass: true = think before answering, false = don't;
     *  null = omit the param (Ollama-only — some cloud models reject it). The thinking text is
     *  returned separately from the reply, not inline. */
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
    | "GET_MODEL_REQUEST" | "CONFIG_REQUEST" | "SET_MODEL_REQUEST" | "CAPS_REQUEST" | "EMBED_REQUEST"
    | "PS_REQUEST" | "UNLOAD_REQUEST" | "CAPTURE_TAB_REQUEST"
    | "SAVE_SESSION_REQUEST" | "GET_SESSION_REQUEST" | "PYTHON_EXEC_REQUEST" | "FETCH_SHEET_REQUEST" | "FETCH_URL_REQUEST"
    | "CDP_SHADOW_RESOLVE_REQUEST"   // read-only: resolve a `>>>` selector into a SEALED closed shadow root via CDP (discovery)
    | "LIST_SERVER_TOOLS_REQUEST"   // discover the OpenWebUI server-side tools this key may use (valid `toolIds`)
    | "INFO_REQUEST"                // machine CAPACITY: per-device VRAM totals/free + system RAM (Ollama /api/info)
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
    | "SAVE_SESSION" | "GET_SESSION" | "PYTHON_EXEC" | "FETCH_SHEET" | "FETCH_SHEET_TITLE" | "FETCH_URL"
    | "CDP_SHADOW_RESOLVE"   // read-only CDP resolve of a `>>>` selector across sealed shadow roots (discovery half of sealed reach)
    | "LIST_SERVER_TOOLS"   // GET OpenWebUI /api/v1/tools/ — the server-side tools, with their function specs
    | "OLLAMA_INFO"         // GET Ollama /api/info — machine capacity (per-device VRAM, system RAM)
    | "GET_INVOCATION"   // read chrome.commands' LIVE shortcut for the HUD (+ whether the user rebound it)
    | "ABORT_TASK"    // abort the AbortController registered for a requestId (only FETCH_LLM registers one today)
    | "START_RUN"     // design A: run an ml.agent loop in the background (unforgeable gate); tools delegate to the page
    | "RESUME_RUN"    // design A: continue a stored background run (its history lives in the SW) with a follow-up task
    | "INJECT_MESSAGE"   // a.say() mid-run: push a user message into a RUNNING background run's inbox (steer it live)
    | "CONTENT_READY"   // cross-page: a fresh document loaded — the SW replies with any rebuild-config for runs this tab hosts
    | "RUN_READOPTED"   // cross-page: the fresh document re-registered a run's toolset → release the navigation barrier
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

/** One accelerator a resident model occupies, from `/api/ps` `gpus[]`. ABSENT entirely for a CPU-resident
 *  model — that is the server's contract for "on the CPU", not a missing field. */
export interface LoadedModelGpu { id: string; runner: string; vramBytes: number }

export interface LoadedModel {
    model: string;
    vramGB: number | null;
    sizeGB: number | null;
    /** EXACT bytes, beside the rounded GB the existing readouts use. The resource panel subtracts these from
     *  exact capacity figures to size its bands, so 0.1 GB rounding would accumulate visible error. */
    vramBytes: number | null;
    sizeBytes: number | null;
    /** Which devices it sits on, and how much on each. Absent (not empty) when the model is CPU-resident. */
    gpus?: LoadedModelGpu[];
    contextLength: number | null;
    expiresAt: string | null;
}

/** One accelerator the machine has, from `/api/info` `compute.supported_gpus[]`. All memory figures are raw
 *  BYTES and all are BINARY — render through `formatBytes` (resource-model.ts), never a hand-rolled /1e9. */
export interface GpuInfo {
    gpu_id: string;
    name: string;
    runner: string;
    /** cuDeviceTotalMem — what ollama places against. */
    total_memory: number;
    /** The DRIVER's framebuffer total (what nvidia-smi shows). Newer servers only; absent on older ones. */
    physical_memory?: number;
    free_memory: number;
    /** CUDA/ROCm only — absent on Metal, which is itself a signal of unified memory. */
    compute?: string;
    driver?: string;
}

export interface SystemCompute {
    cpu_cores?: number;
    total_memory: number;
    free_memory: number;
    /** 0 on macOS whether or not swap exists — treat 0 as UNKNOWN, not as "no swap". */
    free_swap?: number;
}

/** `/api/info` — the machine's CAPACITY, as opposed to `/api/ps`'s residency. Only a patched Ollama +
 *  OpenWebUI serves this route; everything else answers with the SPA's HTML, which is why `ml.info()`
 *  resolves to `null` rather than throwing. */
export interface OllamaInfo {
    models?: { store?: string; count?: number; filesystem_used?: number; running?: number; vram_used?: number };
    compute: { system_compute: SystemCompute; supported_gpus?: GpuInfo[] };
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
    /** the `vision` option AS PASSED (true=forced native · false=off · string=forced reader · null=auto) */
    vision: boolean | string | null;
    /** RESOLVED: does the driver's own model see the pixels natively this run (native vs delegated look)? */
    driverSees?: boolean;
    /** RESOLVED: the vision reader a delegated sub-call uses (equals the driver when native; null = none) */
    visionModel?: string | null;
    hints: string | null;
    /** scripting run: kept out of the in-page HUD (the card reads this to stay hidden) */
    silent?: boolean;
    /** headless run: approval-gated calls are refused (no human to approve) */
    unattended?: boolean;
    /** may this run navigate to other pages (the `navigate` tool + cross-page persistence)? false = off */
    navigate?: boolean;
    /** may this run navigate to OTHER SITES (different origins)? true only when opted in */
    crossOrigin?: boolean;
    /** where privileged gates are resolved: "ui" (default) · "both" (UI + __mlApprovals IPC) · "external" (IPC only) */
    approvalRouting?: "ui" | "both" | "external";
    /** did this run STREAM the model's thinking/reply live (opt-in `stream:true`)? Shown in the agent-options
     *  block so you can tell whether a step's "thinking" was live or only landed at the turn's end. */
    stream?: boolean;
}
/** Live model output DURING a step, before the turn resolves — only when the run opted into `stream:true`.
 *  Carries the ACCUMULATED-so-far reasoning/content (the UI REPLACES, not appends, so a dropped/duplicated
 *  event still converges). Lets a long "thinking" phase show its text live instead of a frozen token count. */
export interface DebugAgentStream extends DebugBase { kind: "agent-stream"; step: number; localStep?: number; reasoning?: string; content?: string; }
export interface DebugAgentStart extends DebugBase { kind: "agent"; task: string; images?: string[]; model: string | null; maxSteps: number; config: DebugAgentConfig; resumed?: boolean; }
export interface DebugAgentStep extends DebugBase {
    kind: "agent-step"; step: number;
    /** The PER-TURN step number (1-based, resets each run()), for the "STEP x/maxSteps" display — `step`
     *  is offset cumulatively across turns so the sidebar's turn groups don't collide, but maxSteps is a
     *  per-turn budget, so the pill must show this local count (turn 2 starts at 1/N again, not 18/20). */
    localStep?: number;
    /** How long the tool itself RAN, in ms — measured around the dispatch, so it excludes the approval gate
     *  (a human deciding is not the tool being slow). Absent when nothing was executed: a denial, a
     *  doomed-action skip, or a step that only carried a thought. */
    toolMs?: number;
    /** How long the approval gate was OPEN, in ms — a human deciding, which is the step's wall time but not
     *  the machine's work. Absent when nothing was gated (auto-approved, read-only, denied without a prompt). */
    approveMs?: number;
    /** A monotonic id per TOOL-call step in a run, so the sidebar can correlate the in-flight START
     *  (pending: true, no result yet) with the completed DONE and patch the row in place. Thoughts
     *  have no seq. `pending` marks the START (render "running…" until the DONE arrives). */
    seq?: number; pending?: boolean;
    /** Design A: a pending step whose background-hosted tool is BLOCKED on the human gate. The sidebar
     *  renders approve/deny controls (instead of "running…") and posts the decision back via SET_APPROVAL. */
    awaitingApproval?: boolean;
    /** `thought` = the assistant's user-facing PROSE (content); `reasoning` = its separate thinking
     *  channel (reasoning_content / message.thinking), rendered as a collapsible "think" section. */
    thought?: string; reasoning?: string | null; tool?: string; arguments?: Record<string, unknown>; result?: string;
    /** What the model ACTUALLY saw as the tool result when it differs from `result` — i.e. `result` PLUS an
     *  appended `@tool:<id>` token line. Kept so the log's raw view stays complete (the AGENTS raw-view rule);
     *  the pretty Out shows `result`, a collapsed "raw · as the model saw it" shows this. */
    modelResult?: string;
    /** LIVE partial output streamed by the tool as it runs (`ctx.stream` — console.log / print), for the
     *  in-flight Jupyter-style Out. A delta emit carries ONLY `{ step, seq, streamOutput }` (no `tool`) so the
     *  reducer patches it additively onto the pending row; the DONE (with `result`) supersedes it. */
    streamOutput?: string;
    /** When each streamed chunk was PRODUCED, as `[offsetInStreamOutput, epochMs]` marks — supplied by the
     *  executor (see ToolContext.stream), never inferred here. The UI reads the mark at or before a line's
     *  offset to show its time; absent → no timestamps to show (a non-streamed result has none). */
    streamMarks?: [number, number][];
    /** the `@tool:<id>` this step was MINTED (opt-in `token:true` on a citable call). The answer renderer matches
     *  it EXACTLY to resolve a `[label](@tool:<id>)` citation — no re-derivation, so it can't drift. */
    token?: string;
    elements?: number;
    /** rich render for the In slot (the call) — else the raw args */
    renderIn?: RenderDescriptor;
    /** rich render for the Out slot (the result) — else the raw result */
    renderOut?: RenderDescriptor;
    /** what this tool fed into the model's context (locate's snap-inject) — the sidebar + export show a
     *  "sent to the model" section (the crop / description + why) */
    feedback?: ToolFeedback;
    /** JSON-Schema mismatches between the args and the tool's parameters */
    argIssues?: string[];
    /** How an approval-gated tool call was decided (undefined for tools that don't
     *  require approval). The sidebar renders it as a green/red provenance badge —
     *  and it's the slot a future interactive-approval control resolves into. */
    approval?: "readonly" | "sandbox" | "same-origin" | "consented" | "self-source" | "user" | "denied" | "skipped" | "cancelled";
    /** button #3: the persistable egress grants this call would establish (its `ml.fetch` literal URLs),
     *  extracted background-side. Present on a pending approval step when there's ≥1 — the sidebar/HUD then
     *  offer an "Approve + remember" control and unfurl exactly this list (what's shown IS what persists). */
    grants?: PersistGrant[];
    /** transparency: prior grants this step REUSED (so it auto-ran without a prompt) — a cached `ml.fetch`
     *  URL a read-only `exec` re-read, an already-approved Google Sheet a `python_exec` reused. The sidebar
     *  shows a collapsed "reused a grant you approved" note in the In area, so a no-prompt run explains itself. */
    reused?: ReusedGrant[];
    /** Token counts for this step's driver call, when the server reports them. Each
     *  step re-sends the full growing history, so the LATEST step's usage is the run's
     *  current context occupancy (not a sum across steps — see TokenUsage). */
    usage?: TokenUsage | null;
    /** Running tally (this turn) of tokens spent by DELEGATED vision sub-calls — the auto-wired
     *  look/locate/verify make their own ml.chat() calls the loop never sees. Separate SPEND, not
     *  context occupancy (a different context, gone after the call). Shown beside the UI usage bar. */
    subUsage?: SubcallUsage;
}
/** Delegated-sub-call token tally (look/locate/verify's own vision calls). See DebugAgentStep.subUsage.
 *  `byModel` breaks the aggregate down per vision model, for chat_metadata's "which model cost what". */
export interface SubcallUsageByModel { model: string; prompt: number; completion: number; calls: number; }
/** ONE delegated sub-call: a vision reader, or (when it lands) a background embedding. `ts` is when it
 *  FINISHED and `ms` how long it took, so it can be drawn as a span nested under the step that spawned it —
 *  a total tells you what the reader cost, but not when, or inside which step. */
export interface SubcallRecord { model: string; ts: number; ms: number; prompt: number; completion: number; }
export interface SubcallUsage { prompt: number; completion: number; calls: number; byModel?: SubcallUsageByModel[];
    /** The individual calls behind `byModel`. Named `calls_` because `calls` is already the COUNT. */
    calls_?: SubcallRecord[]; }
export interface DebugAgentResult extends DebugBase { kind: "agent-result"; summary: string; steps: number; hitCap: boolean; cancelled?: boolean; error?: string | null; answerMedia?: AnswerMedia[];
    /** the curated answer SET resolved to markdown (AgentResult.answer) — the card renders it when it carries a
     *  `@tool:` citation (a designated tool output, e.g. a table/image), which the plain summary can't show. */
    answer?: string; }

/** A handle raised the step cap mid-run (a.maxSteps = N) — the sidebar/HUD updates its "STEP x/N" display. */
export interface DebugAgentCap extends DebugBase { kind: "agent-cap"; maxSteps: number; }
/** A handle inserted a user message into a RUNNING loop (a.say(text)) — shown immediately (pending), even
 *  though the model only sees it at the next step boundary. */
export interface DebugAgentSay extends DebugBase { kind: "agent-say"; text: string; images?: string[]; sayId?: string; }
/** The agent's loop DRAINED a queued steer at a step boundary — flips the bubble's "seen" indicator.
 *  Keyed by `sayId` to the originating `agent-say`; may arrive before OR after it (cross-page replay
 *  reorders), so the reducer converges either way. */
export interface DebugAgentSaySeen extends DebugBase { kind: "agent-say-seen"; sayId: string; }

/** The event stream injected.js emits over window.postMessage for the sidebar. */
export type MlDebugEvent = DebugChatStart | DebugChatResult | DebugChatError
    | DebugAgentStart | DebugAgentStep | DebugAgentResult | DebugAgentCap | DebugAgentSay | DebugAgentSaySeen | DebugAgentStream;

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
     *  `ml.answer`: live inside a tool call (an approved `exec`), throws from the console outside a run. */
    dereference(ref: string, options?: { pipe?: string | string[] | null }): Promise<DerefValue>;
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
     *  { resume }) to continue those). Throws if no handle-backed run exists for the hash. */
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
    pythonExec(code: string, opts?: { image?: string | Element | null; mode?: "readonly" | "full"; margin?: number; tableRaw?: boolean; tables?: string | Element | Record<string, string | Element> | null; onStdout?: (chunk: string, ts?: number) => void }): Promise<{ ok: boolean; value?: unknown; stdout: string; error?: string; render?: "latex" | "img"; inputImage?: string; inputTables?: TablePreview[]; imageBox?: ShotBox; resultTable?: { columns: string[]; rows: (string | number | null)[][] } }>;
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
    _fetchCached(url: string): FetchResult | undefined;
    config(): Promise<MlPublicConfig>;
    setModel(model: string): Promise<string>;
    ps(): Promise<LoadedModel[]>;
    unload(model?: string | null): Promise<string[]>;
    /** List the OpenWebUI server-side tools available to the configured API key —
     *  the valid ids for `ml.chat`'s `toolIds`, with each one's function specs.
     *  Empty on a bare-Ollama endpoint (no such concept). */
    serverTools(): Promise<ServerTool[]>;
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
    _resolveTable(target: string | Element, raw?: boolean): { kind: "rows"; columns: string[]; rows: (string | number | null)[][] } | { kind: "html"; html: string };
    _loadTable(name: string, src: string | Element, raw?: boolean): Promise<{ name: string; source: TableSource; data: { kind: "rows"; columns: string[]; rows: (string | number | null)[][] } | { kind: "html"; html: string } }>;
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

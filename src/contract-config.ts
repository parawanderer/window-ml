// contract-config.ts — the SAVED SETTINGS: what is stored, what the defaults are, and what a page may see.
//
// MlConfig is the schema of chrome.storage.sync and DEFAULT_CONFIG is its every default in one place. Two
// rules live with them, both of which have been broken by accident before: DEFAULT_CONFIG is DUPLICATED in
// popup.ts and the two must stay in step, and a new flag MUST appear in the DevTools Settings panel, which is
// the superset -- adding one to the toolbar popup alone inverts that.
//
// MlPublicConfig is the narrow subset a PAGE is allowed to read back. The server URL, the API key and the
// model filter are not in it, and that is a security boundary rather than an omission.
// Type-only where it can be; DEFAULT_GROUNDING_RANGE is a real value DEFAULT_CONFIG reads.
import type { VisionSupport } from "./contract-render";
import { DEFAULT_GROUNDING_RANGE } from "./contract-render";

/** Which wire shape the backend speaks. It selects an entry in API_FORMATS (sw-llm.ts), which is what knows
 *  how to build a request body and read a reply back -- so this one setting decides routes, streaming parser
 *  and where runtime options like num_ctx and think have to be placed. */
export type ApiFormat = "openai" | "ollama";

/** The extension's own surfaces' colour scheme. `auto` follows the browser rather than being a third look. */
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

/** How hard to try for the protobuf chat stream. THREE states rather than a checkbox because "ask" and
 *  "insist" are different intentions with the same request: the negotiation is one `Accept` header and the
 *  answer's Content-Type decides, so a miss is silent by construction — which is right when you are merely
 *  hoping and wrong when you believe your backend serves it and want to know that it did not.
 *  - `"off"`  — never send the header.
 *  - `"auto"` — send it, take whatever comes back, say nothing. Safe on every backend, hence the default.
 *  - `"on"`   — send it and REPORT a reply that is not protobuf. The reply still arrives (over SSE): a wire
 *    format must never cost you an answer, so "on" buys visibility, not a hard failure. */
export type ProtoMode = "off" | "auto" | "on";

/** The lexical metrics that can rank a near-miss on a pointer LABEL. Names here (shared config surface),
 *  implementations in label-match.ts. */
export const LEXICAL_METRICS = ["hybrid", "edit", "trigram", "tokenset"] as const;

/** One of LEXICAL_METRICS: which string distance ranks a near-miss when a pointer LABEL does not match
 *  exactly. Derived from the array so the setting and the implementations cannot drift apart. */
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
    /** With the debug panel off, still report every page's own sessions (console calls, page scripts) to the chat
     *  page's session index. Off by default: it wakes each page's debug bus, which is otherwise dormant and free. */
    listPageSessions: boolean;
    /** Keep the sessions this browser's own UI starts (the Commander HUD), so they survive the worker being evicted
     *  and can be read tomorrow. A session started from CODE is unaffected: `ml.agent()` and `ml.chat()` stay
     *  ephemeral unless they ask to be saved, which is the rule `ml.createChat({ save: true })` already follows. */
    persistUiRuns: boolean;
    /** The page a run started "on a blank tab" opens, when the client names no URL of its own. Empty: the client
     *  must name one, since the extension cannot run on the browser's own new-tab page. */
    agentStartPage: string;
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
    /** Server-side tool FUNCTIONS the user has turned off, as the `<bundle>__<fn>` names a run would see.
     *  A run can still ask for the bundle; the disabled functions are simply not built, so a backend with
     *  forty tools can be curated down to the handful worth offering a model. Per FUNCTION rather than per
     *  bundle, because a bundle usually mixes something worth calling with several that are not. */
    serverToolsOff: string[];
    /** Server-side tool bundles a HUD-started run always gets, without naming them. A run driven from the
     *  Commander bar has no code to pass `serverTools`, so without this there is no way to give it one. */
    commanderServerTools: string[];
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
    /** The most disk, in MB, the value store may hold: the whole bodies of fetched tables too large for their preview,
     *  kept so a later step can read every row by pointer. Least recently read goes first past it; the browser's own
     *  quota caps it further. */
    valueStoreBudgetMB: number;
    /** Ask for the chat stream as varint-delimited PROTOBUF instead of OpenAI SSE, where the backend serves
     *  it (a patched Ollama). One `Accept` header; a backend that does not speak it answers with the SSE it
     *  always did, so this is a preference rather than a commitment. Measured at 25x fewer bytes for the same
     *  tokens (7343 → 292), because the envelope JSON repeats per token is sent once. Tool calls and
     *  reasoning ride it; a `toolIds` call does not, since OpenWebUI's citations are emitted on a route
     *  protobuf is not served over. `"auto"` by DEFAULT — asking costs one header and the miss is the
     *  fallback, so there is nothing to protect a stock backend from. Read it through `protoMode()`, never
     *  raw: storage may still hold the boolean this replaced. */
    protoStream: ProtoMode;
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

/** Read `config.protoStream` as a `ProtoMode`, whatever is actually stored. The setting shipped as a
 *  BOOLEAN and `chrome.storage.sync` keeps what it was given, so a config read on an existing profile can
 *  hand back `true`/`false` long after the type changed — mapped here rather than at each of the four call
 *  sites, which is how one of them ends up treating `true` as an unrecognised value and silently meaning
 *  "off". `true` becomes `"auto"` and not `"on"`: that user asked for the negotiation, not for a report
 *  about it. Anything unrecognised (including a missing key, when a caller passes a config that was not
 *  merged with the defaults) falls back to the DEFAULT rather than to off — the same fail-open shape as an
 *  invalid `modelFilter`, and for the same reason: a garbled preference should not disable a feature whose
 *  failure mode is a header nobody reads. Pure; shared by the background gate and the settings UI. */
export function protoMode(v: unknown): ProtoMode {
    if (v === "off" || v === "auto" || v === "on") return v;
    if (v === true) return "auto";
    if (v === false) return "off";
    return "auto";
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
    listPageSessions: false,
    persistUiRuns: true,
    agentStartPage: "",
    utilityModel: "",
    utilityNumCtx: 4096,
    utilityForceCpu: false,
    autoTitles: true,
    exportToolDefs: false,
    autoApproveReadonly: true,
    serverToolsOff: [],
    commanderServerTools: [],
    autoApprovePython: true,
    autoApproveSameOriginAuth: false,   // Advanced, default off: a same-origin as-you fetch always asks
    autoApproveSelfSource: true,        // default on: an uncredentialed read of the agent's OWN repo source is free
    valueStoreBudgetMB: 1024,           // capped at half the browser's quota for the extension
    protoStream: "auto",                // ask every time: one header, and a backend that won't serve it answers as it always did
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

/** The non-secret subset GET_CONFIG exposes to the page (never the URL/key). `debugMode` is here so
 *  ml.agent can decide whether to route a run through the unforgeable BACKGROUND loop (design A —
 *  when a debug surface is enabled) or the in-page loop (off). It's UI state, not a secret. */
export type MlPublicConfig = Pick<MlConfig,
    "model" | "ocrModel" | "ocrNumCtx" | "apiFormat" | "utilityModel" | "utilityNumCtx" | "utilityForceCpu" | "autoApproveReadonly" | "serverToolsOff" | "commanderServerTools" | "autoApprovePython" | "autoApproveSameOriginAuth" | "autoApproveSelfSource" | "pierceClosedShadow" | "cdp" | "groundingEnabled" | "groundingModel" | "groundingRange" | "debugMode" | "defaultModelVision" | "labelMatch"> & {
    /** COMPUTED per request (not stored): whether THIS page's origin is on the user's page-approval
     *  whitelist. When true, ml.agent honours the page's own approve()/confirm gate (the user trusts this
     *  domain); otherwise a privileged tool routes to the unforgeable background gate. The raw domain
     *  list is NEVER sent to the page — only this one boolean for the page's own origin. */
    pageApprovalAllowed?: boolean;
};

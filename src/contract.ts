/**
 * @file Shared interfaces for window.ml — the contracts the main-world primitive
 * (injected), the content-script relay (content), the background worker
 * (background), and the debug sidebar all agree on. Types only; erased at build.
 * Import with `import type { ... } from "./contract"` so nothing survives to JS.
 */

// Type-only (erased): the curated answer-set class, referenced by ToolContext.answer. answer-set.ts
// imports AnswerMedia back from here — a type-only cycle, which is fine.
import { MlAnswer, StepOptions, MlTool, AgentOptions, AgentResult, MlAgentHandle, ApprovalRequest, AgentStepEvent } from "./contract-agent";
import { TableLike, Table, TablePreview, TableValue, FetchResult, FetchFormat, TableSource } from "./contract-fetch";

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
import { RebuildConfig } from "./contract-messages";
import { VisionSupport, TokenKind, DEFAULT_GROUNDING_RANGE, VisionMemory, ShotBox } from "./contract-render";
import { LoadedModel, ServerTool, ServerToolResult, OllamaInfo } from "./contract-server";

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
    /** The structural value, when the step produced a grid — no need to reparse a rendered table. A full
     *  {@link TableLike}, so a dereferenced table describes itself exactly as a fetched one does: `shape`,
     *  `columns`, `dtypes`, `rows`. The read-only dialect can traverse it as plain data. */
    table?: TableLike;
    /** The value-store key of the WHOLE table when `table` is only its preview. Present only for a run that holds it. */
    value?: string;
    /** A `data:image/…;base64,…` URL when the step produced an image. */
    image?: string;
    latex?: string;
}

// `readColumns` is attached PAGE-SIDE by the resolver of a background-hosted run when `meta.value` names a stored table;
// it never crosses a message boundary. It is what turns the pointer's table facade into a stored one (asTable).
export interface DerefRead { value: string; warning?: string; meta?: DerefMeta; readColumns?: import("./table-data").StoredColumnReader }

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
    readonly table?: Table;
    readonly image?: string;
    readonly latex?: string;
    /** Reduce it further through the text-pipe dialect, resolving to a new value. */
    pipe(stages: string | string[]): Promise<DerefValue>;
    /** The TS-like shape of it: for a TABLE its `shape` + `dtypes` (the frame without the rows), else the
     *  JSON shape (see `ml.schema`). Throws only on a body that is neither. */
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

/** WHO WAITS FOR THE OUTPUT of a request, which is the rule the server's hints are built on: a person reading it
 *  (`interactive`), a program that cannot continue without it (`agent`), nothing urgent (`utility`), throughput
 *  with nobody waiting (`batch`). */
export type RequestUse = "interactive" | "agent" | "utility" | "batch";

/**
 * WHAT A REQUEST IS FOR, told to a patched ollama (`ollama-slop:hints`, docs/FORKED-BACKENDS.md). It is recorded
 * on the server's `gen.end` beside that request's measured timings, so placement and keep-alive can be learned
 * from real usage; it never changes an answer, and a server that does not know it ignores it. Every field is
 * optional, and an ABSENT `use` means unknown — nothing is guessed on the caller's behalf.
 */
export interface RequestHint {
    use?: RequestUse;
    /** Shared by every request of one conversation or agent run: `wml-` + the session hash ({@link hintSession}).
     *  Never per message, which would make every request its own session. */
    session?: string;
    /** What this session waited on since its previous request: a person deciding (an approval gate, a follow-up
     *  turn) or a tool running. Labels the gap before this request, so "a person is deciding" is not read as "the
     *  model is no longer wanted". */
    after?: "human" | "tool";
}

/** The `session` for a window.ml session hash. The prefix tells our traffic apart from Open WebUI's own `owui-`. */
export const hintSession = (hash: string): string => `wml-${hash}`;

/**
 * The `hint` object a request carries on the wire, from what the caller said plus what only the service worker
 * knows (our per-request `request` id, and whether this browser's traffic is synthetic). Pure; the one place the
 * server's limits are applied (`use`/`after` 32 characters, `session` 128, `request` 64), so a
 * page cannot send more than the spec allows. `extend: "utility"` is a side task by construction, so it defaults
 * `use` to `utility`; anything else without a `use` stays unknown. `synthetic` marks generated traffic (benchmark
 * sweeps): served exactly like real traffic, kept out of what the server learns from.
 */
export function wireHint(hint: RequestHint | null | undefined, opts: { extend?: string | null; synthetic?: boolean; request?: string } = {}): Record<string, unknown> | null {
    const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
    const use = str(hint?.use, 32) ?? (opts.extend === "utility" ? "utility" : undefined);
    const session = str(hint?.session, 128);
    const after = hint?.after === "human" || hint?.after === "tool" ? hint.after : undefined;
    const request = str(opts.request, 64);
    const out: Record<string, unknown> = {
        ...(use ? { use } : {}), ...(session ? { session } : {}), ...(request ? { request } : {}), ...(after ? { after } : {}),
        ...(opts.synthetic ? { synthetic: true } : {}),
    };
    return Object.keys(out).length ? out : null;
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
    listPageSessions: false,
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
    /** OUR id for the request this usage came back from, sent as `hint.request` and echoed on a patched ollama's
     *  `gen.end` — what lets the panel match the server's record of this generation to it exactly. */
    requestId?: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** How much of the prompt the server's prefix cache served — OpenAI's standard
     *  `usage.prompt_tokens_details.cached_tokens` (ollama's own OpenAI route, and OpenWebUI's once its fork is
     *  deployed), ollama-native `prompt_eval_cached_count`, or the protobuf `End.cached_tokens`. `0` is a COLD
     *  prefill; ABSENT is "not reported" — never collapsed, since a count of 0 is a measurement. A cache hit is
     *  invisible in `promptTokens`, which is the same either way; this and the prefill's duration are the
     *  evidence. Cheap in TIME, never in tokens — do not fold it into a spend figure. */
    cachedTokens?: number;
    /** How many of `completionTokens` were THINKING — COUNTED, not estimated from text. From the server's own
     *  `completion_tokens_details.reasoning_tokens` when it reports a nonzero one (ollama and OpenWebUI send 0
     *  whatever the model did, so a 0 there is not taken), else from a streamed turn: the engine's running count on
     *  the last chunk while the call was still in its thinking phase. Absent on a call that neither reported nor
     *  streamed a count — a surface then estimates, and says so. */
    reasoningTokens?: number;
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
    /** Ollama-native `prompt_eval_duration` (ns → ms): reading the prompt, before a token comes back. Real
     *  model work, and it scales with the conversation — a system prompt re-sent every turn is paid for every
     *  turn. It is the difference between a model that is slow to answer and a BOX that is slow to reach:
     *  without it, `genMs - evalMs` lumps prompt eval together with queue and network, and a gap between two
     *  models cannot be attributed to either. Absent for cloud / OpenWebUI-OpenAI. */
    promptEvalMs?: number;
    /** WHAT the model was doing across this call, when we could observe it — see {@link GenPhase}. STREAMED
     *  CALLS ONLY: a non-streaming response is one object with one `eval_duration`, which says how long the
     *  generation took but not when it stopped thinking and started answering. Splitting that by text length
     *  would be inventing a timestamp, so it stays absent and the surfaces draw one undifferentiated block. */
    genPhases?: GenPhase[];
}

/** One stretch of a generation, by what the model was emitting: its thinking channel, its reply, or the
 *  fragments of a tool call.
 *
 *  A MARK, not a span: `atMs` is where the phase STARTED, as an offset from the call's own start, and it runs
 *  until the next mark (or the end of the call). Offsets rather than absolute stamps so the marks stay
 *  meaningful without carrying a clock alongside them, and so they line up with `genMs` — which is measured
 *  from the same origin — instead of drifting against it.
 *
 *  A SEQUENCE, deliberately, not three buckets. Models interleave: reasoning resumes after a tool call's
 *  fragments, and a run that thinks-calls-thinks is a real shape. Bucketing would collapse the re-entry and
 *  draw one long block that never happened. */
export interface GenPhase {
    /** `think` the reasoning channel · `answer` the reply content · `call` tool-call fragments. */
    kind: "think" | "answer" | "call";
    /** Offset in ms from the START of the model call. */
    atMs: number;
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

// The slot a descriptor fills is decided by which hook produced it (a tool's `render()`
// method / run()-returned `renderIn` → the In slot; a run()-returned `render` / an
// auto-derived image/elements → the Out slot) — not by a field on the descriptor.

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
    /** Who waits for the output, told to a patched ollama so it can learn how models are used ({@link RequestUse}).
     *  Omit it when you cannot tell — a script and a person at the console call this alike — and nothing is
     *  guessed; `extend: "utility"` defaults to `"utility"`. Never changes the answer. */
    use?: RequestUse;
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

/** Stable short hex id per session (crypto.getRandomValues, Math.random fallback).
 *  Shown in the sidebar and used to resume a conversation. */
export const shortHash = (): string => {
    try {
        const b = new Uint8Array(4); crypto.getRandomValues(b);
        return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
    } catch { return Math.random().toString(16).slice(2, 10); }
};

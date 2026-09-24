// contract-render.ts — how a step's output is SHOWN: the descriptor a tool returns, and what reads it.
//
// RenderDescriptor is the union a tool result carries when the pretty view differs from the string the model
// saw -- a table, an image, a diff, a Python cell. The sidebar, the HUD and both exports render from it, and
// AGENTS.md rule holds: whatever is drawn here, the raw model-facing text must stay recoverable beside it.
// The vision shapes (ShotBox, VisionSupport, the grounding range and vision context size) sit here because a
// screenshot is where most of these descriptors come from, and a box drawn on one is the same coordinates.
// Type-only, so the cycle with contract.ts (which re-exports this file) erases at build entirely.
import type { TablePreview, FetchAttempt } from "./contract-fetch";

/** A user's override for whether a model sees images natively: "" = auto-discover (probe Ollama
 *  /api/show), "yes"/"no" = declared. Used for the default model, to enable NATIVE vision on a
 *  cloud/non-Ollama model the probe can't describe. */
export type VisionSupport = "" | "yes" | "no";

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

/** What a pointer READ returns across the run boundary: the value, plus an optional advisory the caller must
 *  surface on a SIDE channel. The two exist separately because `ml.dereference` inside `exec` returns a value
 *  the script then operates on — JSON.parse it, split it, pipe it — so appending a note to `value` would
 *  corrupt the data. The tool path appends the advisory to its result text; the exec path console.warn()s it. */
/** What the value at a pointer actually IS. The loop knows — it holds the step's `RenderDescriptor` — so the
 *  pointer carries its type rather than flattening everything to text the reader must re-sniff. */
export type TokenKind = "text" | "json" | "table" | "image" | "code";

/** A retry's link back to the call it revises — the model names an earlier call with `revises`, and the
 *  panel draws a diff of the two sources. WE compute that diff, never the model: asked what it changed a
 *  model answers from what it MEANT to change, and the two disagree exactly when the diff is worth reading.
 *  Its `claim` therefore sits BESIDE the diff and never instead of it (the same rule a `token:` label
 *  follows). `before` is the earlier source verbatim; both sides are reflowed by the renderer before
 *  comparing, or pure spacing differences drown the real change.
 *  @unstable */
export interface CodeRevision {
    /** The resolved pointer, canonicalised to its minted id — so it is stable even when the model named a
     *  tool alias or a label. */
    ref: string;
    /** Which tool made the earlier call. */
    tool: string;
    /** The step seq to scroll to, when the earlier call still has one. */
    seq?: number;
    /** The model's own name for that output, if it labelled it. */
    label?: string;
    /** The earlier source, verbatim. */
    before: string;
    /** The model's one-line account of what it changed. A CLAIM, shown beside the computed diff. */
    claim?: string;
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

/** @unstable INTERNAL, and reachable from the published JSON export — a new variant/member may
 *  appear in any release, so the generated `docs/spec/export.schema.json` marks it open rather
 *  than pinning it. Adding to it is NOT a breaking export change. */
export type RenderDescriptor = (
    | { type: "image"; src: string; label?: string }
    // `note`: a one-line caption for when the rendered text is not literally what the caller wrote — `exec`
    // uses it to say that pointer macros were expanded, so a reader comparing this against the raw args does
    // not conclude the log is lying to them. `marks`: byte ranges in `text` a renderer may highlight, each
    // with the original it replaced (hover fodder).
    | { type: "code"; text: string; lang?: string; format?: boolean; note?: string; marks?: { start: number; end: number; from: string }[]; revision?: CodeRevision }
    // `null` is a real cell: a numeric column's blanks become null (pandas NaN) when a table is cast, and
    // RenderTable has always drawn them as empty — this type was simply narrower than both.
    // `rowCount` is the SOURCE's row count when `rows` is only a PREFIX of it (a fetched CSV caps what it
    // ships to the UI and the export). Without it a pointer to a 50,000-row table reports the 200 rows that
    // happened to be drawn — a plausible wrong number, and the one a model would answer with.
    // `dtypes`/`delimiter`/`headerless` let the VIEW say what the model is already told: what each column is,
    // how the body was split (a guess, so a wrong one should be visible rather than inferred from mangled
    // columns), and whether the column names were decided rather than read.
    // `value` is the value-store key of the WHOLE table when this descriptor's source is only a preview of it.
    | { type: "table"; columns: string[]; rows: (string | number | boolean | null)[][]; rowCount?: number; truncated?: boolean; dtypes?: Record<string, string>; delimiter?: string; headerless?: boolean; value?: string }
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
    | { type: "python-in"; mode: "script" | "pt" | "box"; code: string; image?: string; imageToken?: string; tables?: TablePreview[]; revision?: CodeRevision }
    // `python_exec`'s Out slot: captured stdout, a returned image, a minted @pt/@box token,
    // the raw/JSON value, or a Python traceback.
    // `valueSeen` (python-out, exec-out): how many characters of `value` the model received; absent → all of it. The
    // panel keeps more of a value than the tool's output cap, and marks the rest as never sent.
    | { type: "python-out"; stdout?: string; seen?: number; image?: string; token?: string; value?: string; valueSeen?: number; error?: string; latex?: boolean; df?: { columns: string[]; rows: (string | number | null)[][]; rowCount?: number; value?: string } }
    // `exec`'s Out, the JS twin of python-out: the SAME data its raw result string carries, split into
    // sections (console / value / error) so a JS run reads like a notebook cell too instead of one blob.
    // `errorLine` is the line of the MODEL'S source that threw (exec-trace.ts) — absent when it cannot be
    // known, never guessed. The python twin reads its line out of the traceback text; JS has no traceback
    // worth rendering (an evaluated script's stack is mostly the wrapper), so it carries the number.
    | { type: "exec-out"; stdout?: string; seen?: number; value?: string; valueSeen?: number; error?: string; errorLine?: number; token?: string; stdoutLabel?: string }
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
    | { type: "action"; verb: string; kind?: string; target?: string; selector?: string; input?: string; note?: string; crossOrigin?: string; offMachine?: string; asYou?: string; ask?: string; answeredBy?: string; tokens?: number; askBody?: string; askBodyLang?: string; askBodyTruncated?: boolean; pipe?: string; attempts?: FetchAttempt[]; resolvedBy?: FetchAttempt["strategy"] }
);

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

/** INTERNAL: a citable step's render + raw result, carried out of the loop so the outputs resolver can build
 *  {@link AgentOutput}s from the tokens the answer actually cites. */
export interface TokenRender { id: string; tool: string; render?: RenderDescriptor; result?: string }

// python-tool.ts — the `python_exec` agent tool: its schema and description, and how a run's result becomes the
// model-facing text and the sidebar's python-in / python-out descriptors. Moved out of builtin-tools.ts; the sandbox
// itself is `ml.pythonExec` (injected.ts) → the offscreen document → python-worker.ts.
import { type MlApi } from "../contract";
import { PYTHON } from "../tools/tool-details";
import { outputCapPrecheck, resolveOutputCap } from "../contract/contract-pointers";
import { UI_OUT_CAP } from "../contract/contract-chat";
import { clipHeadTail, panelHead, ceilingNote } from "../agent/output-clip";
import { type MlTool, type ToolResult } from "../contract/contract-agent";
import { type RenderDescriptor, READER_MAX_TOKENS, VISION_NUM_CTX } from "../contract/contract-render";
import { googleSheetCsvUrl, nonEmptyTables, clipOut, clipValue, tablesMapFromJson } from "../dom/dom";
import type { Box } from "../dom/locate";
import { pyValueParts } from "./py-render";
import { PY_PACKAGE_LABELS } from "./python-env";
import { outputCapParams, retryParams } from "../tools/tool-params";
import { POINT_RE, BOX_RE, projectShotPoint, mintPoint, projectShotBox, mintBox } from "../util";

// --- python_exec: a sandboxed Python (Pyodide/WASM) tool for pixel/array work ---
// The value the script returns is interpreted into the SAME coordinate currency as
// locate: a point → @pt, a box → @box, a data-URL → an image render. The model only
// describes/computes; we mint the token (delegation-safe — no coordinates authored here).
const asPoint = (v: unknown): { x: number; y: number } | null => {
    if (Array.isArray(v) && v.length === 2 && v.every(n => typeof n === "number")) return { x: v[0], y: v[1] };
    if (v && typeof v === "object" && typeof (v as any).x === "number" && typeof (v as any).y === "number") return { x: (v as any).x, y: (v as any).y };
    return null;
};

const asBoxVal = (v: unknown): Box | null => {
    if (Array.isArray(v) && v.length === 4 && v.every(n => typeof n === "number")) return { left: v[0], top: v[1], right: v[2], bottom: v[3] };
    if (v && typeof v === "object" && ["left", "top", "right", "bottom"].every(k => typeof (v as any)[k] === "number")) return v as Box;
    return null;
};

// A LIST of points/boxes — the model keeps finding new ways to hand back coordinates (here:
// [[666,529],[697,529]], multiple candidates). A single [x,y]/4-array is NOT a list (its members
// are numbers, not points/boxes), so these don't clash with asPoint/asBoxVal above.
const asPointList = (v: unknown): { x: number; y: number }[] | null =>
    Array.isArray(v) && v.length > 0 && v.every(it => asPoint(it)) ? v.map(it => asPoint(it)!) : null;

const asBoxList = (v: unknown): Box[] | null =>
    Array.isArray(v) && v.length > 0 && v.every(it => asBoxVal(it)) ? v.map(it => asBoxVal(it)!) : null;

/** How a python_exec run in the worker mints a `cast`'s token: in the PAGE's `@pt`/`@box` registry (worker-media.ts
 *  `workerMint`), pinned to the document its image came from, since a token in the worker's own registry would resolve
 *  nowhere a click looks. The page's `ml` has none, and mints in its own realm (`mintPoint`/`mintBox`). */
export type MintToken = (q: { pt: { x: number; y: number } } | { box: { left: number; top: number; right: number; bottom: number } }, documentId: string | null) => Promise<string>;

/** The result for a `cast` over an image whose crop transform is unknown: its coordinates are the image's pixels, and
 *  minting them as viewport coordinates would point somewhere else on the page. */
export const CAST_NO_TRANSFORM = "cast refused: where the image was cropped from is not known, so its pixel coordinates cannot be turned into a point on the page. Run it again.";

/** The question a vision reader is asked about an image a script made, for a driver that cannot see it (`verify`). */
export const PY_VERIFY_QUESTION = "The image was just produced by a Python script, usually a chart. Describe what it shows: the kind of " +
    "chart, the axes with their labels and ranges, the title, the legend, and the shape of the data. Then say plainly anything " +
    "that looks wrong: empty or blank axes, labels that overlap or are cut off, a legend covering the data, an unreadable scale.";

/**
 * What `verify: true` adds to an image result: the image itself for a driver that sees, a vision reader's description
 * for one that does not, and a sentence saying neither is possible when there is no reader. Never automatic: a picture
 * costs the driver tokens, and a description costs a model call.
 * @param ml the `ml` the tool was built on (its `chat` reaches the reader)
 * @param ctx the call's context: `driverSees` and `visionModel`
 * @param png the image, as a data URL
 */
export async function verifyPyImage(ml: MlApi, ctx: import("../contract").ToolContext | undefined, png: string): Promise<Partial<ToolResult>> {
    const reason = "verify: the image the script made";
    if (ctx?.driverSees) return { content: "\n\nYou set verify: true, so the image is attached: check it before you cite it.", image: png, imageLabel: reason, feedback: { reason, via: "image", image: png } };
    const reader = ctx?.visionModel || null;
    if (!reader) return { content: "\n\n(verify was requested, but no vision model is available to look at the image.)" };
    let desc: string;
    try { desc = String(await ml.chat(PY_VERIFY_QUESTION, { images: [png], model: reader, maxTokens: READER_MAX_TOKENS, numCtx: VISION_NUM_CTX })).trim(); }
    catch (e) { return { content: `\n\n(verify was requested, but the vision model could not describe the image: ${(e as Error)?.message || e})` }; }
    if (!desc) return { content: `\n\n(verify was requested, but ${reader} returned an empty description. Ask it a narrower question with look({ selector: "@tool:python_exec", question: "…" }).)`, feedback: { reason, via: "text", text: "", prompt: PY_VERIFY_QUESTION, image: png } };
    return { content: `\n\n👁 You can't see images, so this is ${reader}'s description of it:\n${desc}`, feedback: { reason, via: "text", text: desc, prompt: PY_VERIFY_QUESTION, image: png } };
}

export const buildPythonTool = (ml: MlApi): MlTool => {
    const mintVia = (ml as MlApi & { _mintToken?: MintToken })._mintToken;
    // `current` is only advertised when it actually resolves to something — the page is a Google Sheet,
    // OR it has EXACTLY one non-empty table (then 'current' = that table). Otherwise 'current' is left
    // out of the description entirely, since it confuses models into using it where it can't work.
    const onSheet = typeof location !== "undefined" && !!googleSheetCsvUrl(location.href);
    const singleTable = !onSheet && typeof document !== "undefined" && nonEmptyTables(document).length === 1;
    const currentHint = onSheet
        ? " YOU ARE CURRENTLY ON A GOOGLE SHEET — pass `tables:'current'` to load it as `df`."
        : singleTable ? " THIS PAGE HAS ONE TABLE — pass `tables:'current'` to load it as `df`." : "";
    const currentClause = onSheet ? " Or `'current'` for THIS Google Sheet."
        : singleTable ? " Or `'current'` for the one table on this page." : "";
    const tablesDesc = "Spreadsheet/table data → pandas DataFrame(s). " + PYTHON.tables + currentClause;
    // Only a worker-hosted run keeps a namespace across its cells (root C), and only the worker's `ml` has `_mintToken`;
    // a page-hosted agent's cells have no run, so they stay stateless.
    const stateClause = mintVia
        ? "Names you define persist across your python_exec calls in this run (`df`/`tables`/`img` are re-bound when a " +
          "call passes them); after a sandbox restart the output opens with `namespace reset at <time>: <reason>` and they are gone."
        : "Each call is STATELESS — a fresh namespace, nothing persists.";
    return ml.defineTool({
        name: "python_exec",
        summary: "Runs sandboxed Python (numpy/pandas/Pillow) for data & math.",
        requiresApproval: true,
        description: "Run SANDBOXED Python (numpy/Pillow/pandas, WASM) for array/pixel/spatial/table work better " +
            "done in Python than JS — pixel-mask & centroid a target, count regions, BFS a maze, or SUM/AVG/GROUP a " +
            "table. Your inputs are ALREADY loaded as variables — `image`→`img`/`img_np` " +
            "(PIL + H×W×3 uint8), `tables`→DataFrame(s) — so reference them directly, never re-open/parse/read_csv " +
            "them. `return` a value → comes back as TEXT (or set `cast` to mint a clickable @pt/@box). RETURN TYPE " +
            "auto-renders: a sympy expression → typeset LaTeX, a PIL Image (or to_base64()) or a matplotlib figure " +
            "(returned, or just left open) → an image, a DataFrame " +
            "→ a table — so just `return sympy.diff(...)` / `return img` and cite `![…](@tool:…:out)` (no cast; add " +
            "`| raw` to force the literal text). " + stateClause + " In scope: " +
            PY_PACKAGE_LABELS + " + stdlib (io, math, collections, itertools…)." +
            " A cell the read-only dialect covers runs without asking; any other asks the user first. No network or filesystem here: use fetch_url for that." +
            currentHint,
        parameters: {
            type: "object",
            properties: {
                code: { type: "string", description: "Python. Reference img/img_np/your DataFrame(s); end with a `return` OR a bare trailing expression (Jupyter-style: a last line `df` is the result). print() is captured as stdout." },
                image: { type: "string", description: "Optional CSS selector or @pt:/@box: token to load as img/img_np. An @box loads the exact container content; an @pt loads a square neighbourhood around the point." },
                cast: { type: "string", enum: ["pt", "box"], description: PYTHON.cast },
                verify: { type: "boolean", description: PYTHON.verify },
                margin: { type: "number", description: "For an @pt image only: the crop RADIUS in px around the point (a bigger margin = more context). Omit for the default. Ignored for @box / CSS selectors." },
                tables: {
                    oneOf: [
                        { type: "string" },   // a single source → loaded as `df`
                        { type: "object", additionalProperties: { type: "string" }, propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } },   // { python_identifier: source }
                    ],
                    description: tablesDesc,
                },
                tableRaw: { type: "boolean", description: "Load table cells as raw STRINGS (skip the default numeric/currency auto-cast). Use only for ZIP/SKU/leading-zero IDs that casting would corrupt." },
                // Only where names persist (a worker-hosted run): the sandbox is shut after 30 min idle (py-reap.ts).
                ...(mintVia ? { keep: { type: "boolean", description: "Keep your names through idle gaps over 30 min (a run that waits hours between calls) until this run ends or its sandbox is killed (a timeout, a crash, a cancel), which the next cell is told as loss. Otherwise an idle sandbox is shut and its names lost." } } : {}),
                ...outputCapParams("python_exec", "Prefer returning a compact result."),
                ...retryParams("python_exec"),
            },
            required: ["code"],
        },
        // A maxChars raise with no justification is DOOMED (it will just ask for one) — skip the gate and
        // steer the model to supply `maxCharsReason` first (then the human sees it on the approval card).
        precheck: (args) => outputCapPrecheck("python_exec", args as Record<string, unknown>),
        // Pre-run In render — shown during the approval WAIT, when run() hasn't produced its full
        // python-in yet (the input image + DataFrame previews need the tables loaded). Show the
        // highlighted code as a notebook cell now; post-run, run()'s renderIn wins in descriptorFor.
        render: (_input, args) => {
            const code = typeof args.code === "string" ? args.code : "";
            if (!code) return null;
            const mode = args.cast === "pt" ? "pt" as const : args.cast === "box" ? "box" as const : "script" as const;
            return { type: "python-in", mode, code };
        },
        run: async ({ code, image, cast, verify = false, margin, tableRaw, tables, keep, maxChars, maxCharsReason }: { code: string; image?: string; cast?: "pt" | "box"; verify?: boolean; margin?: number; tableRaw?: boolean; tables?: string | Record<string, string>; keep?: boolean; maxChars?: number; maxCharsReason?: string }, ctx?: import("../contract").ToolContext): Promise<string | ToolResult> => {
            // Effective per-slot output cap (default: OUTPUT_CAP.python_exec). A raise past it is only reachable AFTER the human
            // gate (autoApprovePython refuses to sandbox-approve an escalated call), clamped to the ceiling.
            const { cap: PY_OUT_MAX, clamped: capClamped } = resolveOutputCap("python_exec", maxChars, maxCharsReason);
            // A DOM-table selector loads the FIRST match — warn if it's ambiguous (loading the wrong
            // table and computing on it would silently give wrong numbers). Covers a single-source
            // `tables` string AND every DOM-selector value in a `tables` map (skipping 'current' /
            // Sheets-URL entries, which aren't selectors).
            const domSelectors: [string, string][] = [];
            const addIfSelector = (name: string, src: unknown) => {
                if (typeof src === "string" && src !== "current" && !googleSheetCsvUrl(src)) domSelectors.push([name, src]);
            };
            const tablesArg = tablesMapFromJson(tables) ?? tables;
            if (typeof tablesArg === "string") addIfSelector("df", tablesArg);
            else if (tablesArg) for (const [name, src] of Object.entries(tablesArg)) addIfSelector(name, src);
            let tableNote = "";
            for (const [name, sel] of domSelectors) {
                try { const n = ml._queryAll(sel).length; if (n > 1) tableNote += `⚠ selector "${sel}" matched ${n} elements — loaded the FIRST as \`${name}\`. If the numbers look off, narrow it (an id, or :nth-of-type(N)).\n`; } catch { /* invalid selector → pythonExec/_resolveTable errors below */ }
            }
            if (tableNote) tableNote += "\n";
            const r = await ml.pythonExec(code, { image: image || null, margin: typeof margin === "number" ? margin : 0, tableRaw: !!tableRaw, tables: tables || null, ...(keep === true ? { keep: true } : {}), onStdout: ctx?.stream });
            // Cap stdout/value/error fed back to the model so a runaway result (e.g. a
            // string-concat blowup) can't flood the context — with a "[+N truncated]" note.
            // Past the ceiling the model is told AFTER its clip, and the panel's last line says the same (output-clip.ts).
            const overNote = r.stdoutDropped ? ceilingNote(r.stdoutDropped) : "";
            const stdoutClipped = clipOut(r.stdout || "", PY_OUT_MAX) + (overNote ? `\n${overNote}` : "");
            // Synthetic "already loaded" log — models get confused about HOW their tables/image arrive
            // (do they read_csv? what variable?). State it plainly at the top so they infer the setup:
            // `img`/`df`/named DataFrames are PRE-loaded, reference them directly.
            const loaded: string[] = [];
            // `rowCount` is the WHOLE table's when the render holds only its preview (a stored table): the model is told the size it has.
            for (const t of r.inputTables || []) loaded.push(t.rows ? `a ${t.rowCount ?? t.rows.length}×${(t.columns?.length || t.rows[0]?.length || 0)} DataFrame → \`${t.name}\`` : `a DataFrame → \`${t.name}\``);
            if (r.inputImage) loaded.push("the screenshot → `img` (PIL) / `img_np` (numpy)");
            const loadedNote = loaded.length ? `[loaded, reference directly] ${loaded.join(", ")}.\n\n` : "";
            const capNote = capClamped ? `(output limit clamped to ${PY_OUT_MAX} chars — the hard ceiling.)\n\n` : "";
            const pre = capNote + tableNote + loadedNote + (stdoutClipped ? `stdout:\n${stdoutClipped}\n\n` : "");
            const stringify = (x: unknown) => clipOut(typeof x === "string" ? x : JSON.stringify(x), PY_OUT_MAX);
            // The value for the PANEL: more of it than the model's cap, with where the model's copy ended.
            const valueOut = (x: unknown): { value: string; valueSeen?: number } => {
                const v = clipValue(typeof x === "string" ? x : JSON.stringify(x), PY_OUT_MAX, UI_OUT_CAP);
                return { value: v.ui, ...(v.seen != null ? { valueSeen: v.seen } : {}) };
            };
            // The In slot: a notebook-cell header (cell mode + input image/table + source). Shared
            // by every return path. The Out slot varies (stdout + one of image/token/value/error).
            const cellMode = cast === "pt" ? "pt" as const : cast === "box" ? "box" as const : "script" as const;
            // If the input image was captured from an @pt/@box, carry the token so hovering the image in
            // the sidebar highlights that point/region back on the page.
            const imageToken = typeof image === "string" && (POINT_RE.test(image.trim()) || BOX_RE.test(image.trim())) ? image.trim() : undefined;
            const renderIn: RenderDescriptor = { type: "python-in", mode: cellMode, code,
                ...(r.inputImage ? { image: r.inputImage } : {}), ...(imageToken ? { imageToken } : {}), ...(r.inputTables && r.inputTables.length ? { tables: r.inputTables } : {}) };
            // UI keeps far more than the model's cap (PY_OUT_MAX) so a watched stream doesn't SHRINK when the
            // step lands; `seen` marks where the model-facing view ended (the surplus renders marked).
            const stdoutFull = (r.stdout || "") + (overNote ? `\n${overNote}` : "");
            const stdout = stdoutFull ? clipHeadTail(stdoutFull, UI_OUT_CAP, panelHead(PY_OUT_MAX)) : undefined;   // the start the model read, and the LATEST
            const capture = stdoutFull.length > UI_OUT_CAP ? clipOut(stdoutFull, UI_OUT_CAP) : undefined;   // what a pointer reads, in one piece
            const seen = stdoutFull ? Math.min((r.stdout || "").length, PY_OUT_MAX) : undefined;
            // The SANDBOX'S OWN CLOCK, kept apart from our wall time around the dispatch: `durationMs` is the
            // script, `bootMs` the cold start it had to pay for first (absent on every warm call). Without
            // the split a first run reports four seconds and blames the script for time it never spent.
            const remoteMs = r.runMs != null
                ? { durationMs: r.runMs, ...(r.bootMs != null ? { bootMs: r.bootMs } : {}) }
                : undefined;
            const done = (content: string, out: Omit<Extract<RenderDescriptor, { type: "python-out" }>, "type" | "stdout">): ToolResult =>
                ({ content, renderIn, render: { type: "python-out", stdout, ...(capture ? { capture } : {}), seen, ...out }, ...(remoteMs ? { remoteMs } : {}) });

            if (!r.ok) {
                const err = clipOut(r.error || "", PY_OUT_MAX);
                // Don't fight a hallucinated load pattern with docs alone — when data was PRELOADED
                // and the code errored trying to (re)load it (read_csv/read_html/open/requests/…),
                // redirect to the preloaded var. Fires on the failure, so it covers every variant
                // instead of enumerating them. (Observed: `pd.read_csv('current')` → FileNotFound.)
                const dfNames = (r.inputTables || []).map(t => `\`${t.name}\``).join("/");
                const loaded = [dfNames, r.inputImage ? "`img`/`img_np`" : ""].filter(Boolean).join(" and ");
                const looksLikeReload = /read_csv|read_html|read_excel|read_json|open\(|FileNotFoundError|No such file|ModuleNotFound|requests|urllib|urlopen|http|fetch|ConnectionError|storage_options/i.test(err);
                const hint = loaded && looksLikeReload
                    ? `\n\nHint: the tool ALREADY loaded your data as ${loaded} (the table/sheet/image PARAMETER did it) — reference it directly; do not read_csv/read_html/open/fetch anything (the sandbox has no filesystem or network).`
                    : "";
                return done(`${tableNote}Python error: ${err}${hint}${stdoutClipped ? `\n\nstdout:\n${stdoutClipped}` : ""}`, { error: err });
            }
            const v = r.value;
            // HOW it is drawn is shared with the bench (py-render.ts); what the model is TOLD stays here.
            const parts = pyValueParts(v, { render: r.render, table: r.resultTable }, stringify);
            // An image return is unambiguous → always shown (no cast needed).
            if (parts.image) {
                const said = r.render === "figure" ? "Your open matplotlib figure(s) came back as an image (closed now; the next call starts with none)." : "Returned an image.";
                const base = done(`${pre}${said}`, parts);
                if (!verify) return base;
                const seen = await verifyPyImage(ml, ctx, parts.image);
                return { ...base, ...seen, content: base.content + (seen.content ?? "") };
            }
            // Coordinates are opt-in via `cast` (auto-detecting [x,y] would mangle a general
            // script that returns two numbers). A mismatch is an honest error, not a guess.
            // A cast over an image projects through the rect that was cropped; with none, nothing is minted (checked once
            // the return is a well-formed point or box, so a malformed one still gets its own message).
            const noTransform = typeof image === "string" && image.trim().length > 0 && !r.imageBox;
            if (cast === "pt") {
                const raw = asPoint(v);
                if (!raw) {
                    // A common miss: the script returned a LIST of candidate points — say so specifically.
                    const list = asPointList(v);
                    const why = list ? `it's a LIST of ${list.length} points — return the SINGLE best one as [x, y]` : `the return isn't a point ([x,y] or {x,y})`;
                    return done(`${pre}cast:'pt' but ${why}: ${stringify(v)}`, valueOut(v));
                }
                // The script computed the point in the input IMAGE's pixels; project it back to viewport
                // coords (crop offset + dpr) so the @pt clicks the right spot. No image → already viewport.
                if (noTransform) return done(`${pre}${CAST_NO_TRANSFORM}`, valueOut(v));
                const pt = r.imageBox ? projectShotPoint(raw, r.imageBox) : raw;
                let t: string;
                try { t = mintVia ? await mintVia({ pt: { x: pt.x, y: pt.y } }, (r as { imageDocument?: string }).imageDocument ?? null) : mintPoint(pt.x, pt.y); }
                catch (e) { return done(`${pre}cast:'pt' → (${Math.round(pt.x)}, ${Math.round(pt.y)}), but no @pt token was minted: ${(e as Error)?.message || e}`, valueOut(v)); }
                // Models keep thinking the @pt is "displaced" — they compare it to their IMAGE-space
                // coords and see a mismatch. Spell out that we already projected image px → viewport.
                const proj = r.imageBox ? ` (You passed an image and cast to @pt, so your IMAGE-pixel coordinates were AUTOMATICALLY projected to VIEWPORT space — ${t} at (${Math.round(pt.x)}, ${Math.round(pt.y)}) IS the correct on-screen click point, not a displaced one; don't re-adjust for scale/offset.)` : "";
                return done(`${pre}→ ${t} at (${Math.round(pt.x)}, ${Math.round(pt.y)}).${proj} Verify then click: look({ selector: "${t}" }) → click({ selector: "${t}" }).`, { token: t });
            }
            if (cast === "box") {
                const raw = asBoxVal(v);
                if (!raw) {
                    const list = asBoxList(v);
                    const why = list ? `it's a LIST of ${list.length} boxes — return the SINGLE best one` : `the return isn't a box ([x1,y1,x2,y2] or {left,top,right,bottom})`;
                    return done(`${pre}cast:'box' but ${why}: ${stringify(v)}`, valueOut(v));
                }
                if (noTransform) return done(`${pre}${CAST_NO_TRANSFORM}`, valueOut(v));
                const bx = r.imageBox ? projectShotBox(raw, r.imageBox) : raw;   // image px → viewport
                let t: string;
                try { t = mintVia ? await mintVia({ box: { left: bx.left, top: bx.top, right: bx.right, bottom: bx.bottom } }, (r as { imageDocument?: string }).imageDocument ?? null) : mintBox(bx); }
                catch (e) { return done(`${pre}cast:'box' → (${Math.round(bx.left)}, ${Math.round(bx.top)}, ${Math.round(bx.right)}, ${Math.round(bx.bottom)}), but no @box token was minted: ${(e as Error)?.message || e}`, valueOut(v)); }
                const proj = r.imageBox ? ` (You passed an image and cast to @box, so your IMAGE-pixel coordinates were AUTOMATICALLY projected to VIEWPORT space — this region is already in on-screen coordinates; don't re-adjust for scale/offset.)` : "";
                return done(`${pre}→ ${t} (a ${Math.round(bx.right - bx.left)}×${Math.round(bx.bottom - bx.top)}px region).${proj} Scope into it: locate({ selector: "${t}", description: "…" }).`, { token: t });
            }
            const text = stringify(v);
            // The return LOOKS like a coordinate but no `cast` was set, so it came back as dead TEXT the
            // model can't click. Nudge it to re-run with the matching cast → a clickable @pt/@box. Covers a
            // single point/box AND a LIST of candidates (pt for {x,y}/[x,y], box for the 4-forms).
            // GATED on an image being passed: a coordinate is only a meaningful click target when it was
            // derived from a screenshot the tool loaded (cast then projects image-px → viewport). Without an
            // image the two numbers are almost certainly just data, and nudging to cast would be wrong.
            const hadImage = typeof image === "string" && image.trim().length > 0;
            const castHint = !hadImage ? ""
                : asPoint(v)
                    ? ` — this looks like a POINT but you didn't set \`cast\`, so it's just text you can't click. Re-run this exact script with cast:"pt" to mint a clickable coordinate (returns @pt:… → look()/click() it).`
                    : asBoxVal(v)
                        ? ` — this looks like a BOX but you didn't set \`cast\`, so it's just text. Re-run this exact script with cast:"box" to mint a clickable region (returns @box:… → scope into it with locate()).`
                        : asPointList(v)
                            ? ` — this looks like a LIST of ${asPointList(v)!.length} candidate POINTS but you didn't set \`cast\`, so it's dead text. Pick the SINGLE best one and return just that ([x, y]) with cast:"pt" to get a clickable @pt:… .`
                            : asBoxList(v)
                                ? ` — this looks like a LIST of ${asBoxList(v)!.length} candidate BOXES but you didn't set \`cast\`, so it's dead text. Return the SINGLE best one with cast:"box" to get a clickable @box:… .`
                                : "";
            // A returned DataFrame/Series → render a real table (the sidebar draws PyDfTable); the model
            // still gets the text repr in `content` for reasoning. Applies to both the agent run and the bench.
            if (parts.df) return done(`${pre}${text}`, parts);
            // Returned None but PRINTED — a common miss: the model logs to stdout but returns nothing, so the
            // result is `null` and there's nothing meaningful to CITE. Nudge it to RETURN the value (a DataFrame
            // renders as a table). Gated on stdout so a script that legitimately returns nothing isn't nagged.
            const nullWarn = (v === null || v === undefined) && stdoutClipped
                ? "\n\n⚠ Your code RETURNED null (None) — you printed to stdout but didn't RETURN a value, so there's nothing to cite. Whatever the user should SEE, RETURN it (a pandas DataFrame renders as a readable table; a dict/number is fine); stdout is just a debug log."
                : "";
            // Auto-typeset a LaTeX return, no `| latex` cast needed (`| raw` overrides): a sympy TYPE, or a
            // string that is LaTeX itself (`LOOKS_LATEX`, for a model that returns `sympy.latex(expr)`).
            if (parts.latex) return done(`${pre}${text}`, parts);
            return done(`${pre}${text}${castHint}${nullWarn}`, valueOut(v));
        },
    });
};

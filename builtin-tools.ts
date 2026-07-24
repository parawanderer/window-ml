// The built-in side-effecting interaction tools for ml.agent: `look` (vision),
// `click`, and `type`. Factored out of the window.ml object literal — each takes
// the live `ml` (for defineTool/screenshot/chat) plus imported dom helpers, and
// window.ml keeps thin delegating method wrappers. Not in the default read-only
// domTools; opt in via extraTools, gated by the approval flow.

import type { MlApi, MlTool, LocateSubstep } from "./contract";
import { DEFAULT_GROUNDING_RANGE } from "./contract";
import { truncate, errText, elLine, queryAll, selectorError } from "./dom";
import { settle, VISION_NUM_CTX, cropDataUrl, MIN_SHOT_PX, POINT_RE, PT_LOOK_RADIUS, mintPoint, resolvePoint, nearbyPoint } from "./util";
import { collectCandidates, buildMarks, annotate, formatBox, letterboxToSquare, projectFromSquare, drawGrid, gridDims, validateCells, cellsBox, collectInBox, elementAtPoint, viewportBox, colorWordHues, pickOverlayColor, pickAccentColor, withHiddenSidebar, regionBox, REGION_NAMES, adjacentCells, type RegionName, type MarkFilter, type Box, type Mark } from "./som";

// --- Coordinate targets (canvas / WebGL) -----------------------------------
// A <canvas> has NO sub-node to snap to, so `locate` mints an OPAQUE `@pt:` token (see
// util.ts) that `click` resolves and `look`/`screenshot` can crop+mark. These helpers add
// the DOM-side detection + the synthetic click.
/** The <canvas> at a viewport point, if the topmost element there is one (or inside one). */
const canvasAt = (x: number, y: number): Element | null => {
    let el: Element | null = null;
    try { el = document.elementFromPoint(x, y); } catch { return null; }
    return el ? el.closest("canvas") : null;
};
/**
 * If a pick box OVERLAPS a <canvas>, the canvas-hit point nearest the box centre. Samples
 * a grid across the box (not just the centre) so a box/cell straddling page chrome and the
 * canvas — e.g. a target near the canvas's top edge — still yields a clickable coordinate
 * instead of a spurious "no element". Returns null when no sampled point hits a canvas.
 */
const canvasPointIn = (box: Box): { x: number; y: number } | null => withHiddenSidebar(() => {
    const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
    const w = box.right - box.left, h = box.bottom - box.top;
    const F = [0.15, 0.35, 0.5, 0.65, 0.85];
    let best: { x: number; y: number; d: number } | null = null;
    for (const gy of F) for (const gx of F) {
        const x = box.left + gx * w, y = box.top + gy * h;
        if (canvasAt(x, y)) { const d = Math.hypot(x - cx, y - cy); if (!best || d < best.d) best = { x, y, d }; }
    }
    return best ? { x: best.x, y: best.y } : null;
});
/** Synthesize a real click at a viewport coordinate (for canvas surfaces): the full
 *  pointer/mouse sequence at (x,y) on the topmost element there. */
const clickAt = (x: number, y: number): Element | null => {
    // Ignore the debug sidebar overlay so a click under the panel reaches the canvas/page.
    const el = withHiddenSidebar(() => canvasAt(x, y) || (() => { try { return document.elementFromPoint(x, y); } catch { return null; } })());
    if (!el) return null;
    const base: MouseEventInit = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    const hasPointer = typeof PointerEvent === "function";
    if (hasPointer) el.dispatchEvent(new PointerEvent("pointerdown", { ...base, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", base));
    if (hasPointer) el.dispatchEvent(new PointerEvent("pointerup", { ...base, pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", base));
    el.dispatchEvent(new MouseEvent("click", base));
    return el;
};

export const buildLookTool = (ml: MlApi, { model = null, maxTokens = 512 }: { model?: string | null; maxTokens?: number } = {}): MlTool => {
    return ml.defineTool({
        name: "look",
        capabilities: ["vision"],
        description: "See the page (or one element) visually. No selector → screenshot the viewport " +
            "to orient. A selector → inspect that element; iterate `index` (0,1,2,…) to judge items in " +
            "a grid/list one sharp crop at a time. scope:'page' stitches the whole page (downscaled — " +
            "layout only, not small text). An `@pt:…` token from locate → a marked crop of that canvas " +
            "click point, to VERIFY before clicking.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of an element, or an `@pt:…` point token from locate; omit to see the page." },
                question: { type: "string", description: "What to determine (optional)." },
                scope: { type: "string", enum: ["viewport", "page"], description: "'viewport' (default), or 'page' to scroll+stitch the full page (only when no selector)." },
                index: { type: "integer", description: "Which match of the selector to look at (0-based); iterate a grid with 0,1,2,…" }
            }
        },
        run: async ({ selector, question, scope, index }: { selector?: string; question?: string; scope?: "viewport" | "page"; index?: number } = {}) => {
            const fullPage = scope === "page" && !selector;
            // An @pt point token → screenshot returns a cropped, MARKED view of the click spot
            // (canvas verification): tailor the prompt to "what's at the mark", not page text.
            const isPoint = !!selector && POINT_RE.test(selector.trim());
            let shot;
            try { shot = await ml.screenshot(selector || null, { fullPage, index: index || 0 }); }
            catch (e) { return `Error: ${errText(e)}`; }
            const subject = isPoint ? `the point marked on the canvas (${selector})`
                : selector ? `the element "${selector}"${index ? ` (match #${index})` : ""}`
                : (fullPage ? "the whole page" : "the current page");
            const base = question || (isPoint
                ? `A crosshair box marks exactly where a click would land. Describe what is AT the mark — its colour and shape — and whether it matches what I'm after, so I don't click the wrong thing.`
                : `Describe ${subject} concisely — what is shown and what stands out.`);
            // A full-page stitch is downscaled — the vision model's patches get
            // too coarse to read small text, so frame it as layout/orientation
            // and DON'T ask for verbatim anchors (those are confidently wrong at
            // that zoom). Viewport/element shots are sharp enough to quote text.
            const guidance = isPoint
                ? ""   // a canvas point has no page text to quote
                : fullPage
                ? "\n\nThis is a DOWNSCALED full-page overview: report the overall layout and " +
                  "roughly where sections/items are. Do NOT try to read small text verbatim — " +
                  "say so if it's illegible, and use sampleText/findByText (or look at a specific " +
                  "element) to read exact details."
                : "\n\nThen list a few EXACT on-screen text strings (quoted, verbatim — labels, " +
                  "badges, prices, delivery text) I could search for with findByText to locate " +
                  "the key items.";
            const description = await ml.chat(base + guidance, { images: [shot], model, maxTokens, numCtx: VISION_NUM_CTX }) as string;
            // Progressive-disclosure tip, @pt targets ONLY (irrelevant for a DOM look):
            // the verify step is exactly where the model can see the point grazing the
            // target — steer it to snap with grid-grounding rather than click a near-miss.
            const pointTip = isPoint
                ? `\n\n(Verify before clicking. If the target IS visible in this preview but the mark isn't on it, re-locate just this area to snap onto it: locate({ description: "…", selector: "${selector}", strategy: "grounding" }) — searches only this box (add margin: 40–120 if the target is partly cut off at the edge). If the target ISN'T in this preview at all, it's the wrong spot: change \`region\`/description, don't re-verify here.)`
                : "";
            // Attach the inspected element on the side-channel (debug-only,
            // never to the model). Guarded so a stub-DOM/bad selector no-ops
            // and the return stays a plain string for viewport/no-selector.
            let elements;
            if (selector) { try { const el = queryAll(selector)[index || 0]; if (el) elements = [el]; } catch {} }
            return elements ? { content: description + pointTip, elements } : description + pointTip;
        }
    });
};

// Delegated Set-of-Marks locator (see docs/spec + som.ts). Screenshots the
// viewport, hit-test-sweeps for candidate elements (works on non-semantic UIs),
// draws numbered badges in memory, and asks a VISION model which badge matches the
// caller's description. Delegated like buildLookTool: the badged image is seen only
// by this sub-call + shown in the sidebar (via the `render` envelope) — it never
// enters the driver's history, so a text-only driver can still use it. Returns the
// chosen element's selector (stateless currency) for click/type/answer.
export const buildLocateTool = (ml: MlApi, { model = null, groundingModel = null, groundingRange = DEFAULT_GROUNDING_RANGE, maxTokens = 64 }: { model?: string | null; groundingModel?: string | null; groundingRange?: number; maxTokens?: number } = {}): MlTool => {
    const listOf = (marks: { id: number; role: string; name: string; selector: string }[]) =>
        marks.map(m => `#${m.id} [${m.role}] ${m.name ? `"${truncate(m.name, 50)}"` : "(no accessible name)"}  →  ${m.selector}`).join("\n");
    // Per-run cache of the grounding call (undefined = not asked; null = it errored).
    // The tool lives for one ml.agent run, so a `margin` retry reuses the cached
    // coords + prompt/image and re-runs only the cheap DOM sweep — no 2nd VLM call.
    type GroundCache = { nums: number[] | null; square: string; prompt: string; answer: string };
    const groundCache = new Map<string, GroundCache | null>();
    return ml.defineTool({
        name: "locate",
        capabilities: ["vision"],
        description: "Find an on-screen control by DESCRIBING how it looks — for unlabelled icons, " +
            "custom widgets, canvas, or any UI you can't reach by text or a guessed selector. Returns a " +
            "CSS selector (or an `@pt:…` coordinate, for canvas) to pass to click/type/answer. Sees only " +
            "the current viewport (scroll the target into view first).",
        parameters: {
            type: "object",
            properties: {
                description: {
                    type: "string",
                    description: "What to find, described by its APPEARANCE — colour, shape, icon, and any " +
                        "visible text — NOT by a name, brand, or role the vision model can't see (it reads " +
                        "pixels, not names). Good: \"a red heart icon\", \"a round blue button with a " +
                        "magnifying glass\", \"the star/favourite icon next to the chat title\". Bad: \"Big Pete\", " +
                        "\"the delete handler\", \"the submit button\" (say what it LOOKS like instead)."
                },
                filter: {
                    type: "string",
                    enum: ["clickables", "inputs", "images", "all"],
                    description: "Which elements to consider (default 'clickables')."
                },
                selector: {
                    type: "string",
                    description: "Optional CONTAINER selector to crop scanning to (a modal, a list row) — better for a small target in a busy area. For a target on a <canvas>, pass the canvas's selector here. NOT the target's own selector. An `@pt:…` token also works: re-searches the box around that point with ANY strategy (e.g. grid inside a point)."
                },
                index: {
                    type: "integer",
                    description: "Which match of `selector` to scope to (0-based); default 0."
                },
                margin: {
                    type: "integer",
                    description: "For 'grounding': grow the predicted box by N px (try 40–120) and re-match — when a box snapped to the WRONG element. Reuses the cached box (no 2nd vision call)."
                },
                strategy: {
                    type: "string",
                    enum: ["auto", "grounding", "marks", "grid", "grid-grounding"],
                    description: "Default 'auto'. 'grounding' = a coordinate model points at it (needs one configured; best for a clear spot). 'marks' = numbered badges, model picks by number (robust when cluttered). 'grid' = a numbered grid, model picks the CELL (any vision model; zoom with `cells` or raise `gridSize`). 'grid-grounding' = grid narrows to a cell, THEN grounding points precisely inside it (needs a grounding model; best for a small target on a busy page or canvas, where a plain grid centre only grazes). 'auto' = grounding then marks."
                },
                region: {
                    type: "string",
                    enum: ["left", "right", "top", "bottom", "center", "top-left", "top-right", "bottom-left", "bottom-right"],
                    description: "Coarse pre-crop by rough position BEFORE the grid — for a dense scene where the grid has too many near-identical cells to pick from (you can vaguely tell 'left'/'bottom' even when you can't read a cell number). Bands are full-length ('left' = left side, full height); corners are quadrants. Halves overlap, so if unsure which side, guess one and try the opposite on a miss. Composes with any strategy."
                },
                gridSize: {
                    type: "integer",
                    description: "For 'grid': base cell count (default 4, 2–8; the grid maxes out ~60 cells). To go FINER, don't raise this — zoom with `cells` (a fresh grid inside a cell) or pre-crop with `region`."
                },
                cells: {
                    type: "array",
                    items: { type: "integer" },
                    description: "A previously-returned cell selection (1, 2 adjacent, or a 2×2 block of 4). 'grid' draws a fresh grid inside it (recursive zoom); 'grid-grounding' grounds directly inside it (reuses the pick — no re-roll)."
                },
            },
            required: ["description"],
        },
        run: async ({ description, filter = "clickables", margin = 0, strategy = "auto", selector, index = 0, gridSize, cells, region: regionName }: { description: string; filter?: MarkFilter; margin?: number; strategy?: "auto" | "grounding" | "marks" | "grid" | "grid-grounding"; selector?: string; index?: number; gridSize?: number; cells?: number[]; region?: RegionName }) => {
            if (!description) return "Provide a `description` of the element to find.";
            const dpr = window.devicePixelRatio || 1;
            const RED = "#ff2d55", YELLOW = "#eab308";
            const rectOf = (b: Box) => ({ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top });
            const pickedStr = (m: { role: string; name: string; selector: string }) => `[${m.role}]${m.name ? ` "${m.name}"` : ""} → ${m.selector}`;
            // One phrasing for the Set-of-Marks substep, whether it's the primary mechanism
            // or the grid hand-off's second stage.
            const somLabel = (n: number, chosen?: Mark) => `Set-of-Marks · ${n} candidate${n === 1 ? "" : "s"}${chosen ? ` · model chose #${chosen.id}` : ""}`;
            let shot: string | undefined;   // captured once, shared between mechanisms
            const avoidHues = colorWordHues(description);   // don't overlay the target's own colour

            // Draw numbered badges over `marks` — full-frame, or translated onto a crop of
            // `crop` (a scoped/grid-cell view, for a tighter, more legible image). The badge
            // colour contrasts with the page (and avoids the target's colour). Shared by
            // strategy 'marks' and grid's in-cell disambiguation.
            const badgeMarks = async (marks: Mark[], crop?: { left: number; top: number; width: number; height: number }): Promise<string> => {
                if (!shot) shot = await ml.screenshot(null, {});
                const src = crop ? await cropDataUrl(shot, crop, dpr) : shot;
                const color = await pickOverlayColor(src, avoidHues);
                const box = (m: Mark) => crop ? { left: m.rect.left - crop.left, top: m.rect.top - crop.top, width: m.rect.width, height: m.rect.height } : m.rect;
                return annotate(src, marks.map(m => ({ rect: box(m), color, badge: m.id })), dpr);
            };
            // Ask the vision reader which badge matches; returns the chosen mark (or none),
            // the raw answer, and the prompt sent (for the substep's In/Out debug view).
            const askMarks = async (marks: Mark[], badged: string, reader: string | null, note = ""): Promise<{ chosen?: Mark; answer: string; prompt: string }> => {
                const prompt = `The screenshot has numbered badges (#1–#${marks.length}) drawn over candidate ` +
                    `elements. Which single badge number best matches this element: "${description}"${note}? ` +
                    `Reply with ONLY the number, or "NONE" if none match.`;
                const answer = String(await ml.chat(prompt, { images: [badged], model: reader, numCtx: VISION_NUM_CTX, maxTokens })).trim();
                const pick = (answer.match(/\d+/) || [])[0];
                return { chosen: pick ? marks.find(m => m.id === Number(pick)) : undefined, answer, prompt };
            };
            // Draw a green ring on the chosen badge — the human "visualise" view of a
            // Set-of-Marks pick (the model saw the plain badged `raw` image).
            const highlightPick = async (badged: string, mark: Mark, crop?: { left: number; top: number; width: number; height: number }): Promise<string> => {
                const rect = crop ? { left: mark.rect.left - crop.left, top: mark.rect.top - crop.top, width: mark.rect.width, height: mark.rect.height } : mark.rect;
                // Sample the BADGED image (not the shot) so the highlight avoids the badge
                // colour too — otherwise both can land in the page's emptiest hue and clash.
                return annotate(badged, [{ rect, color: await pickAccentColor(badged, avoidHues), label: `#${mark.id}` }], dpr);
            };
            // Substeps accumulated by an EARLIER mechanism (an 'auto' grounding attempt that
            // missed) so the Set-of-Marks fallback still shows what grounding saw.
            const priorSubsteps: LocateSubstep[] = [];
            // Set when a plain `strategy:"grid"` cell landed on a canvas and a grounding model
            // is available — we auto-upgrade to grid-grounding (grounding pinpoints inside the
            // cell) instead of returning the imprecise cell centre. Noted in the result.
            let autoUpgraded = false;
            // The cell-CENTRE @pt to fall back to if the auto-upgraded grounding whiffs (no box
            // / error): the upgrade must never be WORSE than the plain-grid cell centre it
            // replaced. Stashed in the grid block (holds its cell-scoped advice strings).
            let autoUpFallback: { x: number; y: number; cellBox: Box; cellNote: string; offAdvice: string } | null = null;

            if (strategy === "grounding" && !groundingModel) {
                return "No grounding model is configured — use strategy 'marks' (or leave it 'auto').";
            }

            // Optional `selector` scoping: crop and search a container's region on its own.
            // Scrolls it into view first (like look/click), then clips to the viewport so the
            // cropped pixels and the coordinate projection stay in lockstep.
            let region = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
            let scopeSel = "";
            // True once the search region is narrowed (a `selector` container, or a
            // grid-grounding cell) — so the marks fallback scans that region, not the viewport.
            let scoped = false;
            if (selector && POINT_RE.test(selector.trim())) {
                // `@pt:` scope ("snap around point") — search the SAME neighborhood box
                // that look() showed around a canvas point. The model re-locates an area it
                // just VISUALLY CONFIRMED holds the target, so grounding inside that ~200px
                // box snaps precisely — the finest zoom tier, seeded by a verified view. No
                // DOM node / scroll; just crop around the coordinate (clipped to viewport).
                const pt = resolvePoint(selector);
                if (!pt) return `Unknown point token "${selector}" — re-run locate for a fresh one.`;
                // `margin` grows the crop so a target cut off at the box edge comes into frame.
                const R = PT_LOOK_RADIUS + (margin > 0 ? margin : 0);
                const left = Math.max(0, pt.x - R), top = Math.max(0, pt.y - R);
                region = { left, top, width: Math.min(window.innerWidth, pt.x + R) - left, height: Math.min(window.innerHeight, pt.y + R) - top };
                if (region.width < MIN_SHOT_PX || region.height < MIN_SHOT_PX) return `The area around ${selector} is too small to search (the point is at the viewport edge). Scroll it toward centre, or locate on the canvas selector instead.`;
                scopeSel = selector;
                scoped = true;
            } else if (selector) {
                let matches: Element[];
                try { matches = queryAll(selector); } catch (e) { return selectorError(selector, e as Error); }
                const el = matches[index];
                if (!(el instanceof Element)) return `No element matches "${selector}"${index ? ` at index ${index}` : ""}${matches.length ? ` (only ${matches.length} match${matches.length === 1 ? "" : "es"})` : ""}. Scroll it into view or refine the selector, then call locate again.`;
                try { el.scrollIntoView({ block: "center", inline: "center" }); } catch { /* detached/older engine */ }
                // Let the scroll paint before we measure/capture (guarded for non-visual envs).
                await new Promise<void>(res => typeof requestAnimationFrame === "function"
                    ? requestAnimationFrame(() => requestAnimationFrame(() => res()))
                    : res());
                const r = el.getBoundingClientRect();
                if (r.width < MIN_SHOT_PX || r.height < MIN_SHOT_PX) {
                    return `The container "${selector}"${index ? ` (match #${index})` : ""} is ${Math.round(r.width)}×${Math.round(r.height)}px — too small to search within (hidden, collapsed, or a sliver?). Target a larger container, or drop \`selector\` to search the whole viewport.`;
                }
                const left = Math.max(0, r.left), top = Math.max(0, r.top);
                region = { left, top, width: Math.min(window.innerWidth, r.right) - left, height: Math.min(window.innerHeight, r.bottom) - top };
                scopeSel = selector;
                scoped = true;
            }
            // Optional `region` pre-crop: the level-0 coarse split. Narrows the search
            // to a named directional area (of the container, or the viewport) BEFORE any
            // mechanism runs — so every strategy inherits it, like `selector` does. The
            // model names it from rough position ("left") when a dense grid has too many
            // near-identical cells to pick a number from.
            let regionCrop = "";
            if (regionName) {
                // Tolerate natural/British variants; reject anything else with the valid
                // list (else regionBox would destructure undefined and throw cryptically —
                // and the model does guess plausible-but-unlisted names like "center-left").
                const REGION_ALIASES: Record<string, RegionName> = { centre: "center", middle: "center", mid: "center" };
                const rn = (REGION_ALIASES[String(regionName).toLowerCase()] || regionName) as RegionName;
                if (!REGION_NAMES.includes(rn)) {
                    return `Invalid region "${regionName}". Use exactly one of: ${REGION_NAMES.join(", ")}. Bands are full-length ("left" = the whole left side); for a finer area, pick the nearest of these and then zoom with grid \`cells\`.`;
                }
                const rb = regionBox(rn, region);
                region = { left: rb.left, top: rb.top, width: rb.right - rb.left, height: rb.bottom - rb.top };
                if (region.width < MIN_SHOT_PX || region.height < MIN_SHOT_PX) {
                    return `The "${regionName}" region${scopeSel ? ` of "${scopeSel}"` : ""} is only ${Math.round(region.width)}×${Math.round(region.height)}px — too small to search. Drop \`region\`, or scope to a larger container first.`;
                }
                scoped = true;
                regionCrop = ` (${rn})`;
            }
            let regionAsBox: Box = { left: region.left, top: region.top, right: region.left + region.width, bottom: region.top + region.height };
            const scopeNote = (scopeSel ? ` within "${scopeSel}"${index ? ` (#${index})` : ""}` : "") + regionCrop;
            // Tips disclosed IN the results (kept out of the tool description, which the model
            // half-reads) so each fires exactly when it applies.
            const actHint = "(verify it with look() first, then click/type/answer with this selector)";
            const canvasScopeTip = scopeSel ? "" : " For tighter coordinates, first scope to the canvas by passing its selector to locate.";
            // Mint an @pt AND detect a re-locate loop: if this spot ~matches one already
            // located this run, warn (each mint is a fresh token, so the model otherwise
            // can't tell it keeps landing on the same wrong coordinate — a real failure
            // mode on a hard canvas). Check before minting so it can't match itself.
            const mintPointWarned = (x: number, y: number): { token: string; dupWarn: string } => {
                const dup = nearbyPoint(x, y);
                const token = mintPoint(x, y);
                const dupWarn = dup ? ` ⚠ This is essentially the SAME spot as ${dup.token} (${dup.x}, ${dup.y}) you already located and it didn't work — do NOT re-verify it. Change approach: a different \`region\`, a re-worded description, or another strategy.` : "";
                return { token, dupWarn };
            };

            // grid-grounding needs a grounding model on BOTH its paths (fresh pick and the
            // cells-reuse shortcut below) — check once here so the reuse path can't silently
            // fall through to marks when no grounder is configured.
            if (strategy === "grid-grounding" && !groundingModel) return "strategy 'grid-grounding' needs a grounding model configured — use 'grid' instead, or configure one in the popup.";

            // grid-grounding + `cells` → REUSE a prior grid pick. Skip the (nondeterministic)
            // grid vision re-pick entirely: narrow the region to the given cell(s) here and
            // let the grounding mechanism pinpoint inside it. This makes "reuse cell 15"
            // deterministic — re-rolling the pick could return NONE on the same target.
            let ggReuse = false;
            if (strategy === "grid-grounding" && cells && cells.length) {
                const base = Math.max(2, Math.min(8, Math.round(gridSize || 4)));
                const prev = gridDims(region, base);
                const v = validateCells(cells, prev.cols, prev.rows);
                if (!v.ok) return `Invalid \`cells\` ${JSON.stringify(cells)} — ${v.reason}. (Cells map to the grid at gridSize ${base}; pass the same gridSize the pick used.)`;
                const cb = cellsBox(cells, prev.cols, prev.rows, region);
                const w = cb.right - cb.left, h = cb.bottom - cb.top;
                if (w < MIN_SHOT_PX || h < MIN_SHOT_PX) return `Cell ${cells.join(",")} is too small to ground within. Drop \`cells\`, or re-pick a coarser one.`;
                region = { left: cb.left, top: cb.top, width: w, height: h };
                regionAsBox = cb;
                scoped = true;
                ggReuse = true;
            }

            // Mechanism #3 — grid: draw an aspect-matched numbered grid, ask which CELL(S)
            // hold the target (multiple-choice → no coordinate hallucination). The model may
            // pick 1, 2 (adjacent), or 4 (a 2×2 block) cells so a target straddling a grid
            // line is fully covered; we union them, sweep the DOM, and — when the region
            // still holds several candidates — hand off to marks WITHIN it rather than
            // guessing the first. `cells` zooms into a prior selection (hierarchical refine).
            //
            // 'grid-grounding' shares this cell-pick, then narrows `region` to the chosen
            // cell and falls through to the grounding mechanism below — the grid coarsely
            // localizes, then grounding places a PRECISE point inside the small cell (where
            // a plain grid's cell centre only grazes an off-centre target, esp. on canvas).
            // (Skipped when ggReuse already narrowed to a caller-supplied cell.)
            if (!ggReuse && (strategy === "grid" || strategy === "grid-grounding")) {
                const reader = model || groundingModel;
                if (!reader) return "No vision model is available to read the grid.";   // grid-grounding's grounding-model guard already fired above
                const base = Math.max(2, Math.min(8, Math.round(gridSize || 4)));
                // A driver zoom: narrow to a previously-returned, validated cell selection.
                let gRegion = region;
                if (cells && cells.length) {
                    const prev = gridDims(region, base);
                    const v = validateCells(cells, prev.cols, prev.rows);
                    if (!v.ok) return `Invalid \`cells\` ${JSON.stringify(cells)} — ${v.reason}.`;
                    gRegion = rectOf(cellsBox(cells, prev.cols, prev.rows, region));
                }
                if (gRegion.width < MIN_SHOT_PX || gRegion.height < MIN_SHOT_PX) {
                    return `That region is too small to subdivide further. Use the returned selectors, or switch strategy.`;
                }
                const { cols, rows } = gridDims(gRegion, base);   // aspect-matched — no wasted rows
                if (!shot) shot = await ml.screenshot(null, {});
                let gridded: string;
                try { gridded = await drawGrid(await cropDataUrl(shot, gRegion, dpr), cols, rows, dpr, avoidHues); }
                catch (e) { return `Error drawing the grid: ${errText(e)}`; }
                const gprompt = `This image is divided into a ${cols}×${rows} numbered grid (cells 1–${cols * rows}, numbered left-to-right, top-to-bottom). ` +
                    `Which cell contains ${description}${scopeNote}? If the target sits ON a grid line or spans more than one cell, reply with the 2 adjacent cells (or a 2×2 block of 4) that cover it; otherwise the single cell. ` +
                    `Reply with ONLY the cell number(s), comma-separated, or "NONE".`;
                const ans = String(await ml.chat(gprompt, { images: [gridded], model: reader, numCtx: VISION_NUM_CTX, maxTokens })).trim();
                const sel = [...new Set((ans.match(/\d+/g) || []).map(Number).filter(n => n >= 1 && n <= cols * rows))].slice(0, 4);
                const gmodel = String(reader);
                const cellLabel = (chose: string) => `Cell pick · grid ${cols}×${rows} · ${chose}`;
                const gridResult = (substeps: LocateSubstep[], extra: { picked?: string; pickedBy?: "model" | "snap" } = {}) =>
                    ({ type: "locate" as const, mode: "grid" as const, model: gmodel, substeps, ...extra });
                if (!sel.length) {
                    // Dense scene → a 60-cell grid of near-identical items is impossible to
                    // pick from. Steer to the level-0 coarse split (`region`) first; only offer
                    // "raise gridSize" while it's still below the ~60-cell cap.
                    const steer = regionName
                        ? ` You already cropped to "${regionName}" — the target may be elsewhere; try the opposite side or another region.`
                        : ` If the scene is too dense to pick one cell, narrow by rough position FIRST: region: "left"/"right"/"top"/"bottom"/a corner/"center" (unsure? guess a side, try the opposite on a miss) — the grid then runs inside just that area.`;
                    const alt = `${groundingModel ? " Or strategy 'grid-grounding'." : ""}${base < 8 ? " Or raise gridSize for finer cells." : ""}`;
                    return { content: `The model matched no grid cell for "${description}"${scopeNote} (replied "${truncate(ans, 40)}").${steer} Or refine the description / switch to 'marks'.${alt}`, render: gridResult([{ label: cellLabel("no cell matched"), prompt: gprompt, output: ans, image: gridded }]) };
                }
                const valid = validateCells(sel, cols, rows);
                if (!valid.ok) {
                    return { content: `The model selected cells ${JSON.stringify(sel)}, not a valid pick (${valid.reason}). Ask it again, or switch strategy.`, render: gridResult([{ label: cellLabel(`chose cells ${sel.join(",")} (invalid)`), prompt: gprompt, output: ans, image: gridded }]) };
                }
                const cellNote = `cell${sel.length > 1 ? "s" : ""} ${sel.join(",")}`;
                // Concrete reuse calls (so the model knows `cells` is a locate arg, not a bare
                // fragment). `cells` only map back under the SAME gridSize, so carry it whenever
                // it's non-default — the compact form of that caveat.
                const dsc = truncate(description, 50);
                const cellsArg = sel.join(",");
                const gsArg = base !== 4 ? `, gridSize: ${base}` : "";
                const gridZoomCall = `locate({ description: "${dsc}", strategy: "grid", cells: [${cellsArg}]${gsArg} })`;
                // Name the real neighbour cells by direction (+ an example) — the driver never
                // sees the grid, so "try an adjacent cell" is a dangling reference otherwise.
                const adj = adjacentCells(sel, cols, rows);
                const adjEntries = Object.entries(adj) as [string, number][];
                const neighbourHint = adjEntries.length
                    ? ` If it's actually in a neighbouring cell, try — ${adjEntries.map(([d, n]) => `${d} ${n}`).join(", ")} — e.g. locate({ description: "${dsc}", strategy: "grid", cells: [${adjEntries[0][1]}]${gsArg} }).`
                    : "";
                // The "zoom in" line for DOM results (a fresh grid recurses inside the cell).
                const refineHint = `zoom in — ${gridZoomCall} draws a fresh grid inside that cell.${neighbourHint}`;
                // Highlight the selection on the grid the model saw (crop-local coords) — the
                // human "visualise" view; the model saw the plain `gridded` (rawImage).
                const localBox = cellsBox(sel, cols, rows, { left: 0, top: 0, width: gRegion.width, height: gRegion.height });
                const griddedImage = await annotate(gridded, [{ rect: rectOf(localBox), color: await pickAccentColor(gridded, avoidHues), label: cellNote }], dpr);
                const cellStep: LocateSubstep = { label: cellLabel(`model chose ${cellNote}`), prompt: gprompt, output: ans, rawImage: gridded, image: griddedImage };
                // Snap the unioned selection to the DOM. A <canvas> is NOT a real target (no
                // sub-node) — drop it (esp. under filter:"all", which returns the canvas itself)
                // so a canvas cell falls to a coordinate point, never a SoM hand-off over pixels.
                const cellBox = cellsBox(sel, cols, rows, gRegion);
                // Snap the unioned selection to the DOM. A <canvas> is NOT a real target (no
                // sub-node) — drop it so a canvas cell falls to a coordinate, never a SoM pick.
                const found = collectInBox(cellBox, filter, { max: 20 }).filter(el => el.tagName !== "CANVAS");
                const cpt = found.length ? null : canvasPointIn(cellBox);
                // AUTO-UPGRADE: a plain-grid canvas cell with a grounder available → treat it
                // like grid-grounding (grounding pinpoints inside the cell) rather than returning
                // the imprecise cell centre. On a canvas the snap can't hurt (no element to
                // mis-snap), so it's a free precision win.
                autoUpgraded = strategy === "grid" && !!cpt && !!groundingModel;
                if (strategy === "grid-grounding" || autoUpgraded) {
                    // Narrow the region to the chosen cell and fall through to the grounding
                    // mechanism (it handles the DOM snap / canvas @pt / marks fallback). `cellStep`
                    // rides along as the first debug substep.
                    region = rectOf(cellBox);
                    regionAsBox = cellBox;
                    scoped = true;
                    priorSubsteps.push(cellStep);
                    // If the cell is on a canvas (`cpt` set), stash the cell centre so a
                    // grounding whiff returns THAT, not the marks-on-canvas dead end ("no
                    // clickables in the cell"). Applies to BOTH the auto-upgrade and an
                    // EXPLICIT grid-grounding — marks can never work inside a canvas cell.
                    if (cpt) autoUpFallback = { x: cpt.x, y: cpt.y, cellBox, cellNote, offAdvice: ` If it lands OFF the target, ${refineHint}` };
                } else {
                if (!found.length) {
                    // No real DOM element → a canvas coordinate at the cell CENTRE (no grounder
                    // here, else we'd have auto-upgraded above), else empty. The centre can graze
                    // an off-centre target, so steer off-target to zoom + the real neighbour cells.
                    if (cpt) {
                        const { token, dupWarn } = mintPointWarned(cpt.x, cpt.y);
                        const ptImg = await annotate(shot, [{ rect: rectOf(cellBox), color: YELLOW, label: cellNote }, { rect: { left: cpt.x - 11, top: cpt.y - 11, width: 22, height: 22 }, color: RED, label: "point" }], dpr);
                        return {
                            content: `Grid ${cellNote}${scopeNote} is on a <canvas> — no DOM element, so this is a COORDINATE: ${token} at (${Math.round(cpt.x)}, ${Math.round(cpt.y)}). First verify, then click: look({ selector: "${token}" }) → click({ selector: "${token}" }).${dupWarn} If it lands OFF the target, ${refineHint}${canvasScopeTip}`,
                            render: gridResult([cellStep, { label: "Canvas point · in the cell", image: ptImg }], { picked: `${token} @ (${Math.round(cpt.x)}, ${Math.round(cpt.y)})`, pickedBy: "snap" }),
                        };
                    }
                    const snapImg = await annotate(shot, [{ rect: rectOf(cellBox), color: YELLOW, label: cellNote }], dpr);
                    return { content: `Grid ${cellNote} for "${description}"${scopeNote} has no ${filter} element under it. Re-pick, raise gridSize, or switch strategy.`, render: gridResult([cellStep, { label: "DOM snap · no element under the cell", image: snapImg }]) };
                }
                const marks = buildMarks(found);
                if (found.length === 1) {
                    // Exactly one element under the cell → snap to it directly (no 2nd call).
                    const picked = marks[0], pk = pickedStr(picked);
                    const snapImg = await annotate(shot, [{ rect: rectOf(cellBox), color: YELLOW, label: cellNote }, { rect: picked.rect, color: RED, badge: 1 }], dpr);
                    return {
                        content: `Grid ${cellNote}${scopeNote} → ${pk}\n${actHint}\n\n${refineHint}\n\nCandidates in that region:\n${listOf(marks)}`,
                        elements: [picked.el, ...found.filter(e => e !== picked.el)].slice(0, 50),
                        render: gridResult([cellStep, { label: "DOM snap · single element in the cell", image: snapImg }], { picked: pk, pickedBy: "snap" }),
                    };
                }
                // Several candidates → a SECOND vision sub-call picks by badge (Set-of-Marks on
                // just the selected cells), instead of snapping to the first.
                const raw = await badgeMarks(marks, rectOf(cellBox));
                const { chosen, answer, prompt: somPrompt } = await askMarks(marks, raw, reader, scopeNote);
                const handoffNote = `The cell held ${found.length} elements, so they were re-badged and a second vision call picked one (Set-of-Marks).`;
                if (!chosen) {
                    // NONE from the hand-off means the target isn't among this cell's elements
                    // → the CELL was likely wrong. Do NOT zoom into it (futile); re-pick or switch.
                    return { content: `None of ${cellNote}'s ${found.length} candidates matched "${description}" (model replied "${truncate(answer, 40)}") — the target is probably NOT in that cell, so do NOT zoom into it. Re-run grid for a fresh cell pick (optionally a larger gridSize), or switch to strategy 'marks'. You can also look() at these to double-check:\n${listOf(marks)}`, elements: found.slice(0, 50), render: gridResult([cellStep, { label: somLabel(found.length), note: handoffNote, prompt: somPrompt, output: answer, rawImage: raw, image: raw }]) };
                }
                const pk = `#${chosen.id} ${pickedStr(chosen)}`;   // the badge the model chose
                const viz = await highlightPick(raw, chosen, rectOf(cellBox));
                return {
                    content: `Grid ${cellNote}${scopeNote} → badged ${found.length} candidates → model picked ${pk}\n${actHint}\n\n${refineHint}\n\nCandidates in that region:\n${listOf(marks)}`,
                    elements: [chosen.el, ...found.filter(e => e !== chosen.el)].slice(0, 50),
                    render: gridResult([cellStep, { label: somLabel(found.length, chosen), note: handoffNote, prompt: somPrompt, output: answer, rawImage: raw, image: viz }], { picked: pk, pickedBy: "model" }),
                };
                }
            }

            // A note carried onto the Set-of-Marks substep when 'auto' tried grounding and
            // it missed (the grounding attempt's own substeps are in priorSubsteps).
            let fallbackNote: string | undefined;

            // Mechanism #1 — grounding VLM: ask for a box, snap it to the DOM by
            // hit-testing. Sent as a 1000×1000 square so `coord/groundingRange` is a
            // per-axis fraction for ANY convention.
            if (groundingModel && strategy !== "marks") {
                // Key the cache on the region too, so a grid-grounding pass (region = a picked
                // cell) doesn't collide with the full-viewport prediction — while a `margin`
                // retry (same region) still hits.
                const rk = `${Math.round(region.left)},${Math.round(region.top)},${Math.round(region.width)},${Math.round(region.height)}`;
                const key = `${filter}\x00${scopeSel}\x00${index}\x00${rk}\x00${description}`;
                let cached = groundCache.get(key);   // reuse this run's prediction (for a margin retry)
                if (cached === undefined) {
                    try {
                        shot = await ml.screenshot(null, {});
                        // Crop to the scoped region (the whole viewport when unscoped), then
                        // LETTERBOX to a square — aspect-preserving, so an arbitrary-shaped crop
                        // isn't distorted the way a stretch mangles it.
                        const cropped = await cropDataUrl(shot, region, dpr);
                        const square = await letterboxToSquare(cropped, DEFAULT_GROUNDING_RANGE);
                        const gp = `Locate "${description}"${scopeNote} in this image. Reply with ONLY its bounding box as four numbers ` +
                            `x1,y1,x2,y2 — top-left then bottom-right corner, each from 0 to ${groundingRange} ` +
                            `(x: 0=left→${groundingRange}=right; y: 0=top→${groundingRange}=bottom). If it isn't visible, reply "NONE".`;
                        const ans = String(await ml.chat(gp, { images: [square], model: groundingModel, numCtx: VISION_NUM_CTX, maxTokens })).trim();
                        const parsed = (ans.match(/\d+(?:\.\d+)?/g) || []).map(Number);
                        cached = { nums: parsed.length >= 4 ? parsed.slice(0, 4) : null, square, prompt: gp, answer: ans };
                        groundCache.set(key, cached);
                    } catch { cached = null; }   // transient failure → leave uncached, fall through
                }
                // 'grid-grounding' entered here via the grid cell-pick — label the render so
                // the sidebar shows it as the two-stage mechanism, and prepend the grid's
                // cellStep (carried in priorSubsteps) as the first substep. For plain grounding
                // priorSubsteps is empty, so this is a no-op there.
                const groundMode = (strategy === "grid-grounding" || autoUpgraded) ? "grid-grounding" as const : "grounding" as const;
                const groundResult = (substeps: LocateSubstep[], extra: { picked?: string; pickedBy?: "model" | "snap" } = {}) =>
                    ({ type: "locate" as const, mode: groundMode, model: String(groundingModel), substeps: [...priorSubsteps, ...substeps], ...extra });
                // When an AUTO-UPGRADED grounding whiffs, don't degrade to marks-on-canvas —
                // return the plain-grid cell CENTRE we stashed (the upgrade must never regress).
                const returnAutoUpFallback = async (extra: LocateSubstep[] = []) => {
                    const f = autoUpFallback!;
                    if (!shot) shot = await ml.screenshot(null, {});
                    const { token, dupWarn } = mintPointWarned(f.x, f.y);
                    const ptImg = await annotate(shot, [{ rect: rectOf(f.cellBox), color: YELLOW, label: f.cellNote }, { rect: { left: f.x - 11, top: f.y - 11, width: 22, height: 22 }, color: RED, label: "point" }], dpr);
                    return {
                        content: `Grid ${f.cellNote}${scopeNote}: grounding couldn't refine inside the cell, so this is the cell-CENTRE COORDINATE (may graze an off-centre target): ${token} at (${Math.round(f.x)}, ${Math.round(f.y)}). First verify, then click: look({ selector: "${token}" }) → click({ selector: "${token}" }).${dupWarn}${f.offAdvice}${canvasScopeTip}`,
                        render: groundResult([...extra, { label: "Canvas point · cell centre (grounding fallback)", image: ptImg }], { picked: `${token} @ (${Math.round(f.x)}, ${Math.round(f.y)})`, pickedBy: "snap" }),
                    };
                };
                if (cached) {
                    const { nums, square, prompt, answer } = cached;
                    const R = groundingRange || DEFAULT_GROUNDING_RANGE;
                    // Two (x,y) pairs — "(x1, y1) → (x2, y2)" text + per-corner overlay labels.
                    const fb = nums ? formatBox(nums) : null;
                    // The square the model saw, annotated with ITS box (visualise view; the
                    // model saw the plain `square` = rawImage).
                    const groundingImage = nums && fb
                        ? await annotate(square, [{ rect: rectOf(viewportBox(nums, R, DEFAULT_GROUNDING_RANGE, DEFAULT_GROUNDING_RANGE)), color: RED, corners: fb.corners }], 1)
                        : square;
                    const boxStep: LocateSubstep = { label: `Grounding${nums && fb ? ` · box ${fb.text}` : " · no box returned"}`, prompt, output: answer, rawImage: nums ? square : undefined, image: groundingImage };
                    // Invert the letterbox back to the scoped region (uniform scale + offset).
                    const box = nums ? projectFromSquare(nums, R, region) : null;
                    if (box) {
                        const b: Box = margin > 0 ? { left: box.left - margin, top: box.top - margin, right: box.right + margin, bottom: box.bottom + margin } : box;
                        const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
                        // Canvas/WebGL surface → no DOM node to snap to. Return a point token at
                        // the canvas-hit nearest the box centre (robust to a box straddling the
                        // page chrome above the canvas). Grounding gives a PRECISE box, its strength.
                        const cpt = canvasPointIn(b);
                        if (cpt) {
                            if (!shot) shot = await ml.screenshot(null, {});
                            const { token, dupWarn } = mintPointWarned(cpt.x, cpt.y);
                            const dot = { left: cpt.x - 11, top: cpt.y - 11, width: 22, height: 22 };
                            const ptImg = await annotate(shot, [{ rect: rectOf(b), color: YELLOW, label: "grounded region" }, { rect: dot, color: RED, label: "click point" }], dpr);
                            const upNote = autoUpgraded ? ` (on a <canvas>, so 'grid' was auto-upgraded to 'grid-grounding' in this call — grounding pinpointed inside the cell)` : "";
                            // Off-target: snap around THIS point (re-ground its neighborhood); a
                            // `margin` grows that search box if the target is cut off at its edge.
                            const snapHint = ` If it lands OFF the target but you can see it nearby, snap onto it: locate({ selector: "${token}", strategy: "grounding", description: "${truncate(description, 50)}" }) — re-searches just around this point (add margin: 40–120 if it's partly cut off at the edge).`;
                            return {
                                content: `Grounded "${description}"${scopeNote} on a <canvas> — no DOM element, so this is a COORDINATE: ${token} at (${Math.round(cpt.x)}, ${Math.round(cpt.y)}).${upNote} First verify, then click: look({ selector: "${token}" }) → click({ selector: "${token}" }).${dupWarn}${snapHint}${canvasScopeTip}`,
                                render: groundResult([boxStep, { label: "Canvas point (no DOM element)", image: ptImg }], { picked: `${token} @ (${Math.round(cpt.x)}, ${Math.round(cpt.y)})`, pickedBy: "snap" }),
                            };
                        }
                        const primary = elementAtPoint(cx, cy, filter);
                        const nearby = collectInBox(b, filter);
                        const chosen = primary || nearby[0];
                        const ordered = chosen ? [chosen, ...nearby.filter(e => e !== chosen)].slice(0, 12) : nearby.slice(0, 12);
                        const marks = buildMarks(ordered);
                        if (!shot) shot = await ml.screenshot(null, {});   // a cache-hit skipped the capture
                        // Element-location pass: the search area in YELLOW, candidates in RED.
                        const snapImg = await annotate(shot, [{ rect: rectOf(b), color: YELLOW, label: margin ? `search +${margin}px` : "search area" }, ...marks.map(m => ({ rect: m.rect, color: RED, badge: m.id }))], dpr);
                        const snapStep: LocateSubstep = { label: `DOM snap${margin ? ` · +${margin}px search margin` : " · nearest element in the box"}`, image: snapImg };
                        if (chosen) {
                            const picked = pickedStr(marks[0]);
                            return {
                                content: `Grounded "${description}"${scopeNote}${margin ? ` (margin ${margin}px)` : ""} → ${picked}\n${actHint}\n\nOther elements in that region:\n${listOf(marks)}`,
                                elements: ordered.slice(0, 50),
                                render: groundResult([boxStep, snapStep], { picked, pickedBy: "snap" }),
                            };
                        }
                        // A box was returned but nothing interactive sits under it — here a
                        // larger `margin` genuinely helps (it expands a real box).
                        if (autoUpFallback) return returnAutoUpFallback([boxStep, { ...snapStep, label: "DOM snap · no element in the box" }]);
                        if (strategy === "grounding") {
                            return { content: `Grounding located a region for "${description}" but no ${filter} element is under it. Retry with a larger \`margin\` (e.g. 40–120) — cheap, it reuses this box with no 2nd vision call — or use strategy 'marks'.`, render: groundResult([boxStep, { ...snapStep, label: "DOM snap · no element in the box" }]) };
                        }
                        priorSubsteps.push(boxStep, { ...snapStep, label: "DOM snap · no element in the box" });
                        fallbackNote = `Grounding found a region but no ${filter} element under it — fell back to Set-of-Marks.`;
                    } else {
                        // No box at all — a `margin` can't expand what doesn't exist, so say so
                        // explicitly rather than let the model waste a step retrying with one.
                        if (autoUpFallback) return returnAutoUpFallback([boxStep]);
                        if (strategy === "grounding") {
                            const m = margin ? " A `margin` can't help without a box — " : " ";
                            return { content: `The grounding model returned no box for "${description}".${m}It may not be visible: scroll it into view, re-describe it, or use strategy 'marks'.`, render: groundResult([boxStep]) };
                        }
                        priorSubsteps.push(boxStep);
                        fallbackNote = "Grounding returned no box — fell back to Set-of-Marks.";
                    }
                } else {
                    if (autoUpFallback) return returnAutoUpFallback();
                    if (strategy === "grounding") {
                        return `Grounding failed for "${description}" (the vision call errored). Try again, or use strategy 'marks'.`;
                    }
                    fallbackNote = "The grounding vision call errored — fell back to Set-of-Marks.";
                }
                // strategy 'auto' → fall through to Set-of-Marks (carrying priorSubsteps).
            }

            // Mechanism #2 — Set-of-Marks (default, and the 'auto' grounding fallback).
            const somReader = model || groundingModel;   // a grounding model can read badges too
            // Scan wider than we'll badge, so we can report the TRUE candidate count and cap
            // the badges at a legible number (badging 100 elements overlaps into mush).
            const SOM_BADGE_CAP = 40, SOM_DENSE = 30;
            const allCands = scoped ? collectInBox(regionAsBox, filter, { max: 150 }) : collectCandidates(filter, { max: 150 });
            const cands = allCands.slice(0, SOM_BADGE_CAP);
            const prefix = fallbackNote ? "(Grounding missed — used Set-of-Marks.) " : "";
            if (!cands.length) return `${prefix}No ${filter} candidates visible${scopeNote || " in the viewport"}. Scroll the target into view, widen the filter (try 'all'), then call again.`;
            // A <canvas>/WebGL surface has no sub-elements to badge — Set-of-Marks can't pick
            // inside it. Steer to the coordinate mechanisms instead of a useless single badge.
            if (cands.every(c => c.tagName === "CANVAS")) {
                const canvasAlts = groundingModel
                    ? "Use strategy 'grid-grounding' (grid narrows the region, then a grounding model pinpoints an exact spot inside it — best for a small target), or 'grounding', or 'grid' and zoom in"
                    : "Use strategy 'grid' and zoom in";
                return `${prefix}"${description}" is on a <canvas> — Set-of-Marks can't pick inside it (it has no sub-elements). ${canvasAlts} — it returns an @pt coordinate token to click.`;
            }
            // Dense pages break Set-of-Marks (badges overlap, the model misreads) AND we
            // only badge the first SOM_BADGE_CAP — say both, and steer to a better tool.
            const densityWarn = allCands.length > SOM_DENSE
                ? `\n\n⚠ ${allCands.length}${allCands.length >= 150 ? "+" : ""} ${filter} candidates${allCands.length > SOM_BADGE_CAP ? ` (only the first ${SOM_BADGE_CAP} are badged/pickable here)` : ""} — Set-of-Marks is unreliable at this density: badges overlap and the wrong one is easily picked. Prefer strategy 'grid' (it narrows the region first), or scope with a \`selector\`. Before acting on any pick from here, verify it with look({ selector: "…" }).`
                : "";
            const marks = buildMarks(cands);
            let badged: string;
            try {
                // Badge full-frame, or on a crop of the scoped region (badgeMarks picks a
                // page-contrasting colour that avoids the target's own colour).
                badged = await badgeMarks(marks, scopeSel ? region : undefined);
            } catch (e) { return `Error capturing/marking the screenshot: ${errText(e)}`; }
            const { chosen, answer, prompt: somPrompt } = await askMarks(marks, badged, somReader, scopeNote);
            const marksStep: LocateSubstep = {
                label: somLabel(marks.length, chosen),
                note: fallbackNote, prompt: somPrompt, output: answer, rawImage: badged,
                image: chosen ? await highlightPick(badged, chosen, scopeSel ? region : undefined) : badged,
            };
            const marksResult = (extra: { picked?: string; pickedBy?: "model" | "snap" } = {}) =>
                ({ type: "locate" as const, mode: "marks" as const, model: String(somReader || "default"), substeps: [...priorSubsteps, marksStep], ...extra });
            if (!chosen) {
                return { content: `${prefix}No badge matched "${description}" (model replied "${truncate(answer, 40)}"). Candidates:\n${listOf(marks)}${densityWarn}`, elements: cands.slice(0, 50), render: marksResult() };
            }
            return {
                content: `${prefix}Matched "${description}" → #${chosen.id} ${pickedStr(chosen)}\n${actHint}\n\nAll candidates:\n${listOf(marks)}${densityWarn}`,
                elements: [chosen.el],
                render: marksResult({ picked: `#${chosen.id} ${pickedStr(chosen)}`, pickedBy: "model" }),
            };
        },
    });
};

export const buildClickTool = (ml: MlApi): MlTool => {
    return ml.defineTool({
        name: "click",
        requiresApproval: true,
        description: "Click an element (link, button, tab, search result). REAL SIDE EFFECTS — " +
            "may navigate, submit a form, or expand/collapse. Pass a CSS selector (supports " +
            ":contains()/:has-text()/:eq()); `index` picks the Nth match (0-based). It also accepts " +
            "an `@pt:…` point token returned by locate for a CANVAS/WebGL target (no DOM node) — " +
            "pass it VERBATIM to click that coordinate. Orient with scroll/look/findByText FIRST so " +
            "you click the right thing. Returns the resulting URL/title so you can confirm what happened.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of the element to click, or an `@pt:…` point token from locate (canvas targets)." },
                index: { type: "integer", description: "Which match to click (0-based); default 0." }
            },
            required: ["selector"]
        },
        run: async ({ selector, index = 0 }: { selector: string; index?: number }): Promise<string> => {
            // A canvas point token from locate → synthesize a click at that coordinate.
            if (POINT_RE.test((selector || "").trim())) {
                const pt = resolvePoint(selector);
                if (!pt) return `Unknown point token "${selector}" — it may be stale (from an earlier page/run). Re-run locate to get a fresh one.`;
                const before = (typeof location !== "undefined" && location.href) || "";
                const hit = clickAt(pt.x, pt.y);
                if (!hit) return `Nothing is at point (${pt.x}, ${pt.y}) — it may have scrolled off-screen. Re-run locate.`;
                await settle(80);
                const after = (typeof location !== "undefined" && location.href) || "";
                const nav = after && after !== before ? ` Navigated to ${after}.` : "";
                return `Clicked at (${pt.x}, ${pt.y}) on ${elLine(hit)}.${nav} Page title: ${truncate(document.title || "", 80)}. Re-run look to see the result.`;
            }
            let el: Element | undefined;
            try { el = queryAll(selector)[index]; }
            catch (e) { return selectorError(selector, e as Error); }
            if (!el) return `No element matches "${selector}"${index ? ` at index ${index}` : ""}.`;
            const before = (typeof location !== "undefined" && location.href) || "";
            try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
            (el as HTMLElement).click();
            await settle(80);   // let navigation / DOM updates begin
            const after = (typeof location !== "undefined" && location.href) || "";
            const nav = after && after !== before ? ` Navigated to ${after}.` : "";
            return `Clicked ${elLine(el)}.${nav} Page title: ${truncate(document.title || "", 80)}. ` +
                "Re-run look/findByText to see the result.";
        }
    });
};

export const buildTypeTool = (ml: MlApi): MlTool => {
    return ml.defineTool({
        name: "type",
        requiresApproval: true,
        description: "Type text into a field (text input, textarea, or contenteditable) — e.g. a " +
            "search box. Pass `selector` and the `text`; `index` picks the Nth match. By default " +
            "it REPLACES the field's value; set append:true to add to it. Set submit:true to press " +
            "Enter after (submit a search/form). Fires input/change events so the page reacts. " +
            "Returns the field's resulting value.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of the field." },
                text: { type: "string", description: "Text to type in." },
                index: { type: "integer", description: "Which match (0-based); default 0." },
                append: { type: "boolean", description: "Append instead of replacing the value." },
                submit: { type: "boolean", description: "Press Enter afterwards (submit)." }
            },
            required: ["selector", "text"]
        },
        run: async ({ selector, text = "", index = 0, append = false, submit = false }: { selector: string; text?: string; index?: number; append?: boolean; submit?: boolean }): Promise<string> => {
            let el: Element | undefined;
            try { el = queryAll(selector)[index]; }
            catch (e) { return selectorError(selector, e as Error); }
            if (!el) return `No element matches "${selector}"${index ? ` at index ${index}` : ""}.`;
            const input = el as HTMLInputElement;
            const editable = "value" in el;
            const cur = editable ? input.value : (el.textContent || "");
            const next = append ? cur + text : text;
            if (editable) input.value = next; else el.textContent = next;
            // Fire the events frameworks listen for so the field isn't "empty" to them.
            try { (el as HTMLElement).focus(); } catch {}
            for (const type of ["input", "change"]) {
                try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch {}
            }
            let note = "";
            if (submit) {
                for (const type of ["keydown", "keyup"]) {
                    try { el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, bubbles: true })); } catch {}
                }
                if (input.form && typeof input.form.requestSubmit === "function") { try { input.form.requestSubmit(); } catch {} }
                await settle(80);
                note = " Submitted (Enter).";
            }
            const shown = editable ? input.value : (el.textContent || "");
            return `Typed into ${elLine(el)}. Value now: "${truncate(shown, 100)}".${note} ` +
                "Re-run look/findByText to see the result.";
        }
    });
};

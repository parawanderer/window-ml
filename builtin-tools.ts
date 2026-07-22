// The built-in side-effecting interaction tools for ml.agent: `look` (vision),
// `click`, and `type`. Factored out of the window.ml object literal — each takes
// the live `ml` (for defineTool/screenshot/chat) plus imported dom helpers, and
// window.ml keeps thin delegating method wrappers. Not in the default read-only
// domTools; opt in via extraTools, gated by the approval flow.

import type { MlApi, MlTool, LocateSubstep } from "./contract";
import { DEFAULT_GROUNDING_RANGE } from "./contract";
import { truncate, errText, elLine, queryAll, selectorError } from "./dom";
import { settle, VISION_NUM_CTX, cropDataUrl, MIN_SHOT_PX } from "./util";
import { collectCandidates, buildMarks, annotate, formatBox, letterboxToSquare, projectFromSquare, drawGrid, gridDims, validateCells, cellsBox, collectInBox, elementAtPoint, viewportBox, colorWordHues, pickOverlayColor, pickAccentColor, type MarkFilter, type Box, type Mark } from "./som";

// --- Coordinate targets (canvas / WebGL) -----------------------------------
// A <canvas> has NO sub-node to snap to, so `locate` mints an OPAQUE point token that
// the `click` tool resolves — the driver copies the token verbatim, never authoring
// coordinates (the whole point). The registry lives for the page's lifetime (tokens
// are a few bytes; a run mints only a handful). Shared here because both tools are in
// this module.
const pointRegistry = new Map<string, { x: number; y: number }>();
const POINT_RE = /^@pt:([0-9a-f]{1,12})$/;
const mintPoint = (x: number, y: number): string => {
    const id = Math.random().toString(16).slice(2, 10);
    pointRegistry.set(id, { x: Math.round(x), y: Math.round(y) });
    return `@pt:${id}`;
};
const resolvePoint = (token: string): { x: number; y: number } | null => {
    const m = POINT_RE.exec((token || "").trim());
    return m ? pointRegistry.get(m[1]) || null : null;
};
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
const canvasPointIn = (box: Box): { x: number; y: number } | null => {
    const cx = (box.left + box.right) / 2, cy = (box.top + box.bottom) / 2;
    const w = box.right - box.left, h = box.bottom - box.top;
    const F = [0.15, 0.35, 0.5, 0.65, 0.85];
    let best: { x: number; y: number; d: number } | null = null;
    for (const gy of F) for (const gx of F) {
        const x = box.left + gx * w, y = box.top + gy * h;
        if (canvasAt(x, y)) { const d = Math.hypot(x - cx, y - cy); if (!best || d < best.d) best = { x, y, d }; }
    }
    return best ? { x: best.x, y: best.y } : null;
};
/** Synthesize a real click at a viewport coordinate (for canvas surfaces): the full
 *  pointer/mouse sequence at (x,y) on the topmost element there. */
const clickAt = (x: number, y: number): Element | null => {
    const el = canvasAt(x, y) || (() => { try { return document.elementFromPoint(x, y); } catch { return null; } })();
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
        description: "See the page visually and get a vision-model description. Call it with " +
            "NO selector to screenshot the viewport and ORIENT yourself when the task is " +
            "vague — seeing the page often makes the intended edit obvious. Pass a selector " +
            "to inspect one element (icons, badges, images, or whether something looks " +
            "sponsored / greyed-out / out of stock). By default you see only the current " +
            "viewport; pass scope:'page' (with no selector) to scroll the whole page and " +
            "stitch it into one tall image when what you need is below the fold — but that " +
            "image is DOWNSCALED, so use it for layout/orientation, not for reading small text. " +
            "To CLASSIFY items in a grid/list (which posts show a cat?), give the item selector " +
            "and iterate `index` (0,1,2,…) — one tight, high-res crop per item, decisive and " +
            "bound to that exact element.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of an element; omit to see the page." },
                question: { type: "string", description: "What to determine (optional)." },
                scope: { type: "string", enum: ["viewport", "page"], description: "'viewport' (default), or 'page' to scroll+stitch the full page (only when no selector)." },
                index: { type: "integer", description: "Which match of the selector to look at (0-based); iterate a grid with 0,1,2,…" }
            }
        },
        run: async ({ selector, question, scope, index }: { selector?: string; question?: string; scope?: "viewport" | "page"; index?: number } = {}) => {
            const fullPage = scope === "page" && !selector;
            let shot;
            try { shot = await ml.screenshot(selector || null, { fullPage, index: index || 0 }); }
            catch (e) { return `Error: ${errText(e)}`; }
            const subject = selector
                ? `the element "${selector}"${index ? ` (match #${index})` : ""}`
                : (fullPage ? "the whole page" : "the current page");
            const base = question || `Describe ${subject} concisely — what is shown and what stands out.`;
            // A full-page stitch is downscaled — the vision model's patches get
            // too coarse to read small text, so frame it as layout/orientation
            // and DON'T ask for verbatim anchors (those are confidently wrong at
            // that zoom). Viewport/element shots are sharp enough to quote text.
            const guidance = fullPage
                ? "\n\nThis is a DOWNSCALED full-page overview: report the overall layout and " +
                  "roughly where sections/items are. Do NOT try to read small text verbatim — " +
                  "say so if it's illegible, and use sampleText/findByText (or look at a specific " +
                  "element) to read exact details."
                : "\n\nThen list a few EXACT on-screen text strings (quoted, verbatim — labels, " +
                  "badges, prices, delivery text) I could search for with findByText to locate " +
                  "the key items.";
            const description = await ml.chat(base + guidance, { images: [shot], model, maxTokens, numCtx: VISION_NUM_CTX }) as string;
            // Attach the inspected element on the side-channel (debug-only,
            // never to the model). Guarded so a stub-DOM/bad selector no-ops
            // and the return stays a plain string for viewport/no-selector.
            let elements;
            if (selector) { try { const el = queryAll(selector)[index || 0]; if (el) elements = [el]; } catch {} }
            return elements ? { content: description, elements } : description;
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
        description: "Find an on-screen control by DESCRIBING it — for unlabelled icon buttons, " +
            "custom widgets, or pages with no accessibility markup, where you can't anchor by text or " +
            "guess a selector. A vision model finds it in a screenshot (via a grounding model's " +
            "coordinates when configured, else numbered Set-of-Marks badges), and the box is snapped to " +
            "the real DOM node by hit-testing (so it works even on non-semantic <div> UIs). Returns that " +
            "element's CSS selector to pass to click/type/answer, plus nearby candidates. Narrow with " +
            "`filter` (clickables/inputs/images), or SCOPE the search to a container with `selector` " +
            "(+`index`) — the region is cropped and searched on its own, which is far more reliable for a " +
            "small target in a busy page (one row of a list, a toolbar, a card). Only sees the current " +
            "viewport — if the target isn't found, scroll it into view, widen the filter, or refine the " +
            "description and call again. A visual pick CAN be wrong, so ALWAYS VERIFY the returned " +
            "selector with look({ selector }) before you click/type/act on it — confirm it's the thing " +
            "you meant; if not, refine and locate again.",
        parameters: {
            type: "object",
            properties: {
                description: {
                    type: "string",
                    description: "What to find, e.g. \"the star/favourite icon next to the chat title\"."
                },
                filter: {
                    type: "string",
                    enum: ["clickables", "inputs", "images", "all"],
                    description: "Which elements to consider (default 'clickables')."
                },
                selector: {
                    type: "string",
                    description: "Optional: CSS selector of a PARENT CONTAINER element (e.g. '.modal', 'tr:nth-child(2)') to restrict visual scanning to that box. Its region is cropped and searched alone. Do NOT pass the target element's selector here — this is only for the outer box."
                },
                index: {
                    type: "integer",
                    description: "Which match of `selector` to scope to (0-based); default 0."
                },
                margin: {
                    type: "integer",
                    description: "Optional: grow the predicted box by this many pixels before matching. Use it when GROUNDING returned a box but snapped to the WRONG element (the box narrowly missed) — call again with the SAME description and a margin like 40–120; it reuses the cached box and re-scans a wider area. It does NOT help when grounding returned no box at all — then re-describe the element, scroll it into view, or use strategy 'marks'."
                },
                strategy: {
                    type: "string",
                    enum: ["auto", "grounding", "marks", "grid"],
                    description: "How to find it (default 'auto'). 'grounding' = a coordinate model points at it directly (needs a grounding model configured; fast, best for a described spot). 'marks' = numbered badges over every candidate and the model picks by number (robust; use when grounding missed or you want to choose among cluttered candidates). 'grid' = an N×N numbered grid is drawn and the model picks the CELL holding the target — no coordinate training needed, so it works with any vision model and stays robust on cluttered pages; zoom in by re-running with the returned `cell`, or raise `gridSize` for finer cells. 'auto' tries grounding first, then falls back to marks."
                },
                gridSize: {
                    type: "integer",
                    description: "For strategy 'grid': the base cell count (default 4, 2–8). The grid is aspect-matched (a wide toolbar gets more columns than rows), so this sets the ballpark, not a literal N×N. Larger = finer cells."
                },
                cells: {
                    type: "array",
                    items: { type: "integer" },
                    description: "For strategy 'grid': zoom into a previously-returned cell selection (1, 2 adjacent, or a 2×2 block of 4) and draw a fresh grid inside it (hierarchical refine)."
                },
            },
            required: ["description"],
        },
        run: async ({ description, filter = "clickables", margin = 0, strategy = "auto", selector, index = 0, gridSize, cells }: { description: string; filter?: MarkFilter; margin?: number; strategy?: "auto" | "grounding" | "marks" | "grid"; selector?: string; index?: number; gridSize?: number; cells?: number[] }) => {
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

            if (strategy === "grounding" && !groundingModel) {
                return "No grounding model is configured — use strategy 'marks' (or leave it 'auto').";
            }

            // Optional `selector` scoping: crop and search a container's region on its own.
            // Scrolls it into view first (like look/click), then clips to the viewport so the
            // cropped pixels and the coordinate projection stay in lockstep.
            let region = { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
            let scopeSel = "";
            if (selector) {
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
            }
            const regionBox: Box = { left: region.left, top: region.top, right: region.left + region.width, bottom: region.top + region.height };
            const scopeNote = scopeSel ? ` within "${scopeSel}"${index ? ` (#${index})` : ""}` : "";

            // Mechanism #3 — grid: draw an aspect-matched numbered grid, ask which CELL(S)
            // hold the target (multiple-choice → no coordinate hallucination). The model may
            // pick 1, 2 (adjacent), or 4 (a 2×2 block) cells so a target straddling a grid
            // line is fully covered; we union them, sweep the DOM, and — when the region
            // still holds several candidates — hand off to marks WITHIN it rather than
            // guessing the first. `cells` zooms into a prior selection (hierarchical refine).
            if (strategy === "grid") {
                const reader = model || groundingModel;
                if (!reader) return "No vision model is available to read the grid.";
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
                    return { content: `The model matched no grid cell for "${description}"${scopeNote} (replied "${truncate(ans, 40)}"). Raise gridSize, refine the description, or switch strategy.`, render: gridResult([{ label: cellLabel("no cell matched"), prompt: gprompt, output: ans, image: gridded }]) };
                }
                const valid = validateCells(sel, cols, rows);
                if (!valid.ok) {
                    return { content: `The model selected cells ${JSON.stringify(sel)}, not a valid pick (${valid.reason}). Ask it again, or switch strategy.`, render: gridResult([{ label: cellLabel(`chose cells ${sel.join(",")} (invalid)`), prompt: gprompt, output: ans, image: gridded }]) };
                }
                const cellNote = `cell${sel.length > 1 ? "s" : ""} ${sel.join(",")}`;
                // A concrete call so the model knows `cells` is a locate arg (reuse the same
                // description + strategy), not a bare fragment.
                const refineHint = `To zoom in, call locate again with those cells: locate({ description: "${truncate(description, 50)}", strategy: "grid", cells: [${sel.join(",")}] }) — it draws a fresh grid inside them.`;
                // Highlight the selection on the grid the model saw (crop-local coords) — the
                // human "visualise" view; the model saw the plain `gridded` (rawImage).
                const localBox = cellsBox(sel, cols, rows, { left: 0, top: 0, width: gRegion.width, height: gRegion.height });
                const griddedImage = await annotate(gridded, [{ rect: rectOf(localBox), color: await pickAccentColor(gridded, avoidHues), label: cellNote }], dpr);
                const cellStep: LocateSubstep = { label: cellLabel(`model chose ${cellNote}`), prompt: gprompt, output: ans, rawImage: gridded, image: griddedImage };
                // Snap the unioned selection to the DOM. A <canvas> is NOT a real target (no
                // sub-node) — drop it (esp. under filter:"all", which returns the canvas itself)
                // so a canvas cell falls to a coordinate point, never a SoM hand-off over pixels.
                const cellBox = cellsBox(sel, cols, rows, gRegion);
                const found = collectInBox(cellBox, filter, { max: 20 }).filter(el => el.tagName !== "CANVAS");
                if (!found.length) {
                    // No real DOM element → a canvas coordinate (the canvas-hit nearest the cell
                    // centre; robust to a cell straddling the chrome above the canvas), else empty.
                    const cpt = canvasPointIn(cellBox);
                    if (cpt) {
                        const token = mintPoint(cpt.x, cpt.y);
                        const ptImg = await annotate(shot, [{ rect: rectOf(cellBox), color: YELLOW, label: cellNote }, { rect: { left: cpt.x - 11, top: cpt.y - 11, width: 22, height: 22 }, color: RED, label: "point" }], dpr);
                        return {
                            content: `Grid ${cellNote}${scopeNote} is on a <canvas> — no DOM element, so this is a COORDINATE: ${token} at (${Math.round(cpt.x)}, ${Math.round(cpt.y)}). Click it verbatim: click({ selector: "${token}" }). For a PRECISE point, first zoom so the target fills a cell: ${refineHint} (re-centres the point) — or use strategy 'grounding' for an exact point.`,
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
                        content: `Grid ${cellNote}${scopeNote} → ${pk}\n(click/type/answer with this selector)\n\n${refineHint}\n\nCandidates in that region:\n${listOf(marks)}`,
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
                    content: `Grid ${cellNote}${scopeNote} → badged ${found.length} candidates → model picked ${pk}\n(click/type/answer with this selector)\n\n${refineHint}\n\nCandidates in that region:\n${listOf(marks)}`,
                    elements: [chosen.el, ...found.filter(e => e !== chosen.el)].slice(0, 50),
                    render: gridResult([cellStep, { label: somLabel(found.length, chosen), note: handoffNote, prompt: somPrompt, output: answer, rawImage: raw, image: viz }], { picked: pk, pickedBy: "model" }),
                };
            }

            // A note carried onto the Set-of-Marks substep when 'auto' tried grounding and
            // it missed (the grounding attempt's own substeps are in priorSubsteps).
            let fallbackNote: string | undefined;

            // Mechanism #1 — grounding VLM: ask for a box, snap it to the DOM by
            // hit-testing. Sent as a 1000×1000 square so `coord/groundingRange` is a
            // per-axis fraction for ANY convention.
            if (groundingModel && strategy !== "marks") {
                const key = `${filter}\x00${scopeSel}\x00${index}\x00${description}`;
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
                const groundResult = (substeps: LocateSubstep[], extra: { picked?: string; pickedBy?: "model" | "snap" } = {}) =>
                    ({ type: "locate" as const, mode: "grounding" as const, model: String(groundingModel), substeps, ...extra });
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
                            const token = mintPoint(cpt.x, cpt.y);
                            const dot = { left: cpt.x - 11, top: cpt.y - 11, width: 22, height: 22 };
                            const ptImg = await annotate(shot, [{ rect: rectOf(b), color: YELLOW, label: "grounded region" }, { rect: dot, color: RED, label: "click point" }], dpr);
                            return {
                                content: `Grounded "${description}"${scopeNote} on a <canvas> — no DOM element, so this is a COORDINATE: ${token} at (${Math.round(cpt.x)}, ${Math.round(cpt.y)}). Click it verbatim: click({ selector: "${token}" }).`,
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
                                content: `Grounded "${description}"${scopeNote}${margin ? ` (margin ${margin}px)` : ""} → ${picked}\n(click/type/answer with this selector)\n\nOther elements in that region:\n${listOf(marks)}`,
                                elements: ordered.slice(0, 50),
                                render: groundResult([boxStep, snapStep], { picked, pickedBy: "snap" }),
                            };
                        }
                        // A box was returned but nothing interactive sits under it — here a
                        // larger `margin` genuinely helps (it expands a real box).
                        if (strategy === "grounding") {
                            return { content: `Grounding located a region for "${description}" but no ${filter} element is under it. Retry with a larger \`margin\`, or use strategy 'marks'.`, render: groundResult([boxStep, { ...snapStep, label: "DOM snap · no element in the box" }]) };
                        }
                        priorSubsteps.push(boxStep, { ...snapStep, label: "DOM snap · no element in the box" });
                        fallbackNote = `Grounding found a region but no ${filter} element under it — fell back to Set-of-Marks.`;
                    } else {
                        // No box at all — a `margin` can't expand what doesn't exist, so say so
                        // explicitly rather than let the model waste a step retrying with one.
                        if (strategy === "grounding") {
                            const m = margin ? " A `margin` can't help without a box — " : " ";
                            return { content: `The grounding model returned no box for "${description}".${m}It may not be visible: scroll it into view, re-describe it, or use strategy 'marks'.`, render: groundResult([boxStep]) };
                        }
                        priorSubsteps.push(boxStep);
                        fallbackNote = "Grounding returned no box — fell back to Set-of-Marks.";
                    }
                } else {
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
            const allCands = scopeSel ? collectInBox(regionBox, filter, { max: 150 }) : collectCandidates(filter, { max: 150 });
            const cands = allCands.slice(0, SOM_BADGE_CAP);
            const prefix = fallbackNote ? "(Grounding missed — used Set-of-Marks.) " : "";
            if (!cands.length) return `${prefix}No ${filter} candidates visible${scopeNote || " in the viewport"}. Scroll the target into view, widen the filter (try 'all'), then call again.`;
            // A <canvas>/WebGL surface has no sub-elements to badge — Set-of-Marks can't pick
            // inside it. Steer to the coordinate mechanisms instead of a useless single badge.
            if (cands.every(c => c.tagName === "CANVAS")) return `${prefix}"${description}" is on a <canvas> — Set-of-Marks can't pick inside it (it has no sub-elements). Use strategy 'grounding' for an exact point, or 'grid' and zoom in — either returns an @pt coordinate token to click.`;
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
                content: `${prefix}Matched "${description}" → #${chosen.id} ${pickedStr(chosen)}\n(click/type/answer with this selector)\n\nAll candidates:\n${listOf(marks)}${densityWarn}`,
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

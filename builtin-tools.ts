// The built-in side-effecting interaction tools for ml.agent: `look` (vision),
// `click`, and `type`. Factored out of the window.ml object literal — each takes
// the live `ml` (for defineTool/screenshot/chat) plus imported dom helpers, and
// window.ml keeps thin delegating method wrappers. Not in the default read-only
// domTools; opt in via extraTools, gated by the approval flow.

import type { MlApi, MlTool } from "./contract";
import { DEFAULT_GROUNDING_RANGE } from "./contract";
import { truncate, errText, elLine, queryAll, selectorError } from "./dom";
import { settle, VISION_NUM_CTX } from "./util";
import { collectCandidates, buildMarks, drawMarks, annotate, formatBox, resizeToSquare, collectInBox, elementAtPoint, viewportBox, type MarkFilter, type Box } from "./som";

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
    type GroundCache = { nums: number[] | null; square: string; prompt: string };
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
            "`filter` (clickables/inputs/images). Only sees the current viewport — if the target isn't " +
            "found, scroll it into view, widen the filter, or refine the description and call again.",
        parameters: {
            type: "object",
            properties: {
                description: { type: "string", description: "What to find, e.g. \"the star/favourite icon next to the chat title\"." },
                filter: { type: "string", enum: ["clickables", "inputs", "images", "all"], description: "Which elements to consider (default 'clickables')." },
                margin: { type: "integer", description: "Optional: grow the predicted box by this many pixels before matching. Use it when GROUNDING returned a box but snapped to the WRONG element (the box narrowly missed) — call again with the SAME description and a margin like 40–120; it reuses the cached box (no second vision call) and re-scans a wider area. It does NOT help when grounding returned no box at all — then re-describe the element, scroll it into view, or use strategy 'marks'." },
                strategy: { type: "string", enum: ["auto", "grounding", "marks"], description: "How to find it (default 'auto'). 'grounding' = a coordinate model points at it directly (needs a grounding model configured; fast, best for a described spot). 'marks' = numbered badges over every candidate and the model picks by number (robust; use when grounding missed or you want to choose among cluttered candidates). 'auto' tries grounding first, then falls back to marks." },
            },
            required: ["description"],
        },
        run: async ({ description, filter = "clickables", margin = 0, strategy = "auto" }: { description: string; filter?: MarkFilter; margin?: number; strategy?: "auto" | "grounding" | "marks" }) => {
            if (!description) return "Provide a `description` of the element to find.";
            const dpr = window.devicePixelRatio || 1;
            const RED = "#ff2d55", YELLOW = "#eab308";
            const rectOf = (b: Box) => ({ left: b.left, top: b.top, width: b.right - b.left, height: b.bottom - b.top });
            const pickedStr = (m: { role: string; name: string; selector: string }) => `[${m.role}]${m.name ? ` "${m.name}"` : ""} → ${m.selector}`;
            let shot: string | undefined;   // captured once, shared between mechanisms

            if (strategy === "grounding" && !groundingModel) {
                return "No grounding model is configured — use strategy 'marks' (or leave it 'auto').";
            }

            // If 'auto' tries grounding and it misses, we still surface that attempt on
            // the Set-of-Marks fallback (why it missed + what the model saw) instead of
            // silently discarding it.
            let fbNote: string | undefined, fbImage: string | undefined;

            // Mechanism #1 — grounding VLM: ask for a box, snap it to the DOM by
            // hit-testing. Sent as a 1000×1000 square so `coord/groundingRange` is a
            // per-axis fraction for ANY convention.
            if (groundingModel && strategy !== "marks") {
                const key = `${filter}\x00${description}`;
                let cached = groundCache.get(key);   // reuse this run's prediction (for a margin retry)
                if (cached === undefined) {
                    try {
                        shot = await ml.screenshot(null, {});
                        const square = await resizeToSquare(shot, DEFAULT_GROUNDING_RANGE);
                        const gp = `Locate "${description}" in this image. Reply with ONLY its bounding box as four numbers ` +
                            `x1,y1,x2,y2 — top-left then bottom-right corner, each from 0 to ${groundingRange} ` +
                            `(x: 0=left→${groundingRange}=right; y: 0=top→${groundingRange}=bottom). If it isn't visible, reply "NONE".`;
                        const ans = String(await ml.chat(gp, { images: [square], model: groundingModel, numCtx: VISION_NUM_CTX, maxTokens })).trim();
                        const parsed = (ans.match(/\d+(?:\.\d+)?/g) || []).map(Number);
                        cached = { nums: parsed.length >= 4 ? parsed.slice(0, 4) : null, square, prompt: gp };
                        groundCache.set(key, cached);
                    } catch { cached = null; }   // transient failure → leave uncached, fall through
                }
                if (cached) {
                    const { nums, square, prompt } = cached;
                    const R = groundingRange || DEFAULT_GROUNDING_RANGE;
                    // Two (x,y) pairs — "(x1, y1) → (x2, y2)" text + per-corner overlay labels.
                    const fb = nums ? formatBox(nums) : null;
                    const coords = fb ? fb.text : "";
                    // The square the model saw, annotated with ITS box (in square px),
                    // labelling the two corners with their coordinates.
                    const groundingImage = nums && fb
                        ? await annotate(square, [{ rect: rectOf(viewportBox(nums, R, DEFAULT_GROUNDING_RANGE, DEFAULT_GROUNDING_RANGE)), color: RED, corners: fb.corners }], 1)
                        : square;
                    const base = { type: "locate" as const, mode: "grounding" as const, model: groundingModel, prompt, groundingImage, gaveBox: !!nums, boxCoords: coords, margin: margin || undefined };
                    const box = nums ? viewportBox(nums, R, window.innerWidth, window.innerHeight) : null;
                    if (box) {
                        const b: Box = margin > 0 ? { left: box.left - margin, top: box.top - margin, right: box.right + margin, bottom: box.bottom + margin } : box;
                        const primary = elementAtPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2, filter);
                        const nearby = collectInBox(b, filter);
                        const chosen = primary || nearby[0];
                        const ordered = chosen ? [chosen, ...nearby.filter(e => e !== chosen)].slice(0, 12) : nearby.slice(0, 12);
                        const marks = buildMarks(ordered);
                        if (!shot) shot = await ml.screenshot(null, {});   // a cache-hit skipped the capture
                        // Element-location pass: the search area in YELLOW, candidates in RED.
                        const resultImage = await annotate(shot, [{ rect: rectOf(b), color: YELLOW, label: margin ? `search +${margin}px` : "search area" }, ...marks.map(m => ({ rect: m.rect, color: RED, badge: m.id }))], dpr);
                        if (chosen) {
                            const picked = pickedStr(marks[0]);
                            return {
                                content: `Grounded "${description}"${margin ? ` (margin ${margin}px)` : ""} → ${picked}\n(click/type/answer with this selector)\n\nOther elements in that region:\n${listOf(marks)}`,
                                elements: ordered.slice(0, 50),
                                render: { ...base, resultImage, picked },
                            };
                        }
                        // A box was returned but nothing interactive sits under it — here a
                        // larger `margin` genuinely helps (it expands a real box).
                        if (strategy === "grounding") {
                            return { content: `Grounding located a region for "${description}" but no ${filter} element is under it. Retry with a larger \`margin\`, or use strategy 'marks'.`, render: { ...base, resultImage } };
                        }
                        fbNote = `found a region but no ${filter} element under it`; fbImage = resultImage;
                    } else {
                        // No box at all — a `margin` can't expand what doesn't exist, so say so
                        // explicitly rather than let the model waste a step retrying with one.
                        if (strategy === "grounding") {
                            const m = margin ? " A `margin` can't help without a box — " : " ";
                            return { content: `The grounding model returned no box for "${description}".${m}It may not be visible: scroll it into view, re-describe it, or use strategy 'marks'.`, render: { ...base } };
                        }
                        fbNote = "returned no box"; fbImage = groundingImage;
                    }
                } else {
                    if (strategy === "grounding") {
                        return `Grounding failed for "${description}" (the vision call errored). Try again, or use strategy 'marks'.`;
                    }
                    fbNote = "the vision call errored";
                }
                // strategy 'auto' → fall through to Set-of-Marks (carrying fbNote/fbImage).
            }

            // Mechanism #2 — Set-of-Marks (default, and the 'auto' grounding fallback).
            const somReader = model || groundingModel;   // a grounding model can read badges too
            const cands = collectCandidates(filter);
            const gp = fbNote ? `(Grounding ${fbNote}.) ` : "";   // let the model know grounding was tried
            if (!cands.length) return `${gp}No ${filter} candidates visible in the viewport. Scroll the target into view, widen the filter (try 'all'), then call again.`;
            const marks = buildMarks(cands);
            let badged: string;
            try {
                if (!shot) shot = await ml.screenshot(null, {});   // viewport PNG (hides our sidebar)
                badged = await drawMarks(shot, marks, dpr);
            } catch (e) { return `Error capturing/marking the screenshot: ${errText(e)}`; }
            const somPrompt = `The screenshot has numbered red badges (#1–#${marks.length}) drawn over candidate ` +
                `elements. Which single badge number best matches this element: "${description}"? ` +
                `Reply with ONLY the number, or "NONE" if none match.`;
            const answer = String(await ml.chat(somPrompt, { images: [badged], model: somReader, numCtx: VISION_NUM_CTX, maxTokens })).trim();
            const pick = (answer.match(/\d+/) || [])[0];
            const chosen = pick ? marks.find(m => m.id === Number(pick)) : undefined;
            const render = { type: "locate" as const, mode: "marks" as const, model: String(somReader || "default"), resultImage: badged, picked: chosen ? `#${chosen.id} ${pickedStr(chosen)}` : undefined, fallbackNote: fbNote, fallbackImage: fbImage };
            if (!chosen) {
                return { content: `${gp}No badge matched "${description}" (model replied "${truncate(answer, 40)}"). Candidates:\n${listOf(marks)}`, elements: cands.slice(0, 50), render };
            }
            return {
                content: `${gp}Matched "${description}" → #${chosen.id} ${pickedStr(chosen)}\n(click/type/answer with this selector)\n\nAll candidates:\n${listOf(marks)}`,
                elements: [chosen.el],
                render,
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
            ":contains()/:has-text()/:eq()); `index` picks the Nth match (0-based). Orient with " +
            "scroll/look/findByText FIRST so you click the right thing. Returns the resulting " +
            "URL/title so you can confirm what happened.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of the element to click." },
                index: { type: "integer", description: "Which match to click (0-based); default 0." }
            },
            required: ["selector"]
        },
        run: async ({ selector, index = 0 }: { selector: string; index?: number }): Promise<string> => {
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

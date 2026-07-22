// The built-in side-effecting interaction tools for ml.agent: `look` (vision),
// `click`, and `type`. Factored out of the window.ml object literal — each takes
// the live `ml` (for defineTool/screenshot/chat) plus imported dom helpers, and
// window.ml keeps thin delegating method wrappers. Not in the default read-only
// domTools; opt in via extraTools, gated by the approval flow.

import type { MlApi, MlTool } from "./contract";
import { DEFAULT_GROUNDING_RANGE } from "./contract";
import { truncate, errText, elLine, queryAll, selectorError } from "./dom";
import { settle, VISION_NUM_CTX } from "./util";
import { collectCandidates, buildMarks, drawMarks, resizeToSquare, collectInBox, elementAtPoint, viewportBox, type MarkFilter, type Box } from "./som";

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
    // Per-run cache of the grounding box (undefined = not asked; null = model said
    // none). The tool instance lives for one ml.agent run, so a `margin` retry reuses
    // the cached prediction and re-runs only the cheap DOM sweep — no 2nd VLM call.
    const boxCache = new Map<string, Box | null>();
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
                margin: { type: "integer", description: "Optional: grow the predicted region by this many pixels before matching. If a GROUNDING locate found nothing or the WRONG element (its box narrowly missed), call again with the SAME description and a margin like 40–120 — it reuses the cached prediction (no second vision call) and re-scans a wider area." },
                strategy: { type: "string", enum: ["auto", "grounding", "marks"], description: "How to find it (default 'auto'). 'grounding' = a coordinate model points at it directly (needs a grounding model configured; fast, best for a described spot). 'marks' = numbered badges over every candidate and the model picks by number (robust; use when grounding missed or you want to choose among cluttered candidates). 'auto' tries grounding first, then falls back to marks." },
            },
            required: ["description"],
        },
        run: async ({ description, filter = "clickables", margin = 0, strategy = "auto" }: { description: string; filter?: MarkFilter; margin?: number; strategy?: "auto" | "grounding" | "marks" }) => {
            if (!description) return "Provide a `description` of the element to find.";
            const dpr = window.devicePixelRatio || 1;
            let shot: string | undefined;   // captured once, shared between mechanisms

            if (strategy === "grounding" && !groundingModel) {
                return "No grounding model is configured — use strategy 'marks' (or leave it 'auto').";
            }

            // Mechanism #1 — grounding VLM: ask for a box, snap it to the DOM by
            // hit-testing. Sent as a 1000×1000 square so `coord/groundingRange` is a
            // per-axis fraction for ANY convention.
            if (groundingModel && strategy !== "marks") {
                const key = `${filter}\x00${description}`;
                let box = boxCache.get(key);   // reuse a prior prediction this run (for a margin retry)
                if (box === undefined) {
                    try {
                        shot = await ml.screenshot(null, {});
                        const square = await resizeToSquare(shot, DEFAULT_GROUNDING_RANGE);
                        const gp = `Locate "${description}" in this image. Reply with ONLY its bounding box as four numbers ` +
                            `x1,y1,x2,y2 — top-left then bottom-right corner, each from 0 to ${groundingRange} ` +
                            `(x: 0=left→${groundingRange}=right; y: 0=top→${groundingRange}=bottom). If it isn't visible, reply "NONE".`;
                        const ans = String(await ml.chat(gp, { images: [square], model: groundingModel, numCtx: VISION_NUM_CTX, maxTokens })).trim();
                        const nums = (ans.match(/\d+(?:\.\d+)?/g) || []).map(Number);
                        const computed: Box | null = nums.length >= 4 ? viewportBox(nums, groundingRange, window.innerWidth, window.innerHeight) : null;
                        boxCache.set(key, computed);   // cache the definitive result (box or null); a transient throw is left uncached
                        box = computed;
                    } catch { box = null; }
                }
                if (box) {
                    const b: Box = margin > 0
                        ? { left: box.left - margin, top: box.top - margin, right: box.right + margin, bottom: box.bottom + margin }
                        : box;
                    const primary = elementAtPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2, filter);
                    const nearby = collectInBox(b, filter);
                    const chosen = primary || nearby[0];
                    if (chosen) {
                        const ordered = [chosen, ...nearby.filter(e => e !== chosen)].slice(0, 12);
                        const marks = buildMarks(ordered);
                        if (!shot) shot = await ml.screenshot(null, {});   // cache-hit skipped the capture; need it for the render
                        const badged = await drawMarks(shot, marks, dpr);
                        return {
                            content: `Grounded "${description}"${margin ? ` (margin ${margin}px)` : ""} → [${marks[0].role}]${marks[0].name ? ` "${marks[0].name}"` : ""}\n` +
                                `selector: ${marks[0].selector}\n(click/type/answer with this selector)\n\nOther elements in that region:\n${listOf(marks)}`,
                            elements: ordered.slice(0, 50),
                            render: { type: "image" as const, src: badged, label: `grounded: "${truncate(description, 40)}"` },
                        };
                    }
                }
                // NONE / unparseable / nothing under the box.
                if (strategy === "grounding") {
                    return `Grounding didn't locate "${description}" (no box returned, or nothing interactive under it). ` +
                        `Retry with a \`margin\` (e.g. 80), scroll it into view, or use strategy 'marks' to pick from labelled candidates.`;
                }
                // strategy 'auto' → fall through to Set-of-Marks.
            }

            // Mechanism #2 — Set-of-Marks (default, and the 'auto' grounding fallback).
            const somReader = model || groundingModel;   // a grounding model can read badges too
            const cands = collectCandidates(filter);
            if (!cands.length) return `No ${filter} candidates visible in the viewport. Scroll the target into view, widen the filter (try 'all'), then call again.`;
            const marks = buildMarks(cands);
            let badged: string;
            try {
                if (!shot) shot = await ml.screenshot(null, {});   // viewport PNG (hides our sidebar)
                badged = await drawMarks(shot, marks, dpr);
            } catch (e) { return `Error capturing/marking the screenshot: ${errText(e)}`; }
            const prompt = `The screenshot has numbered red badges (#1–#${marks.length}) drawn over candidate ` +
                `elements. Which single badge number best matches this element: "${description}"? ` +
                `Reply with ONLY the number, or "NONE" if none match.`;
            const answer = String(await ml.chat(prompt, { images: [badged], model: somReader, numCtx: VISION_NUM_CTX, maxTokens })).trim();
            const pick = (answer.match(/\d+/) || [])[0];
            const chosen = pick ? marks.find(m => m.id === Number(pick)) : undefined;
            const render = { type: "image" as const, src: badged, label: chosen ? `Set-of-Marks · #${chosen.id}` : "Set-of-Marks" };
            if (!chosen) {
                return { content: `No badge matched "${description}" (model replied "${truncate(answer, 40)}"). Candidates:\n${listOf(marks)}`, elements: cands.slice(0, 50), render };
            }
            return {
                content: `Matched "${description}" → #${chosen.id} [${chosen.role}]` +
                    `${chosen.name ? ` "${chosen.name}"` : ""}\nselector: ${chosen.selector}\n(click/type/answer with this selector)\n\nAll candidates:\n${listOf(marks)}`,
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

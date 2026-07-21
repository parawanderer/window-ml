// The built-in side-effecting interaction tools for ml.agent: `look` (vision),
// `click`, and `type`. Factored out of the window.ml object literal — each takes
// the live `ml` (for defineTool/screenshot/chat) plus imported dom helpers, and
// window.ml keeps thin delegating method wrappers. Not in the default read-only
// domTools; opt in via extraTools, gated by the approval flow.

import type { MlApi, MlTool } from "./contract";
import { truncate, errText, elLine, queryAll, selectorError } from "./dom";
import { settle } from "./util";

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
            const description = await ml.chat(base + guidance, { images: [shot], model, maxTokens }) as string;
            // Attach the inspected element on the side-channel (debug-only,
            // never to the model). Guarded so a stub-DOM/bad selector no-ops
            // and the return stays a plain string for viewport/no-selector.
            let elements;
            if (selector) { try { const el = queryAll(selector)[index || 0]; if (el) elements = [el]; } catch {} }
            return elements ? { content: description, elements } : description;
        }
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

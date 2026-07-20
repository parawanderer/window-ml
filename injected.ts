// This runs in the "Main World" (same as the page JS)

import type {
    MlPublicConfig,
    NeutralMessage,
    ToolResult,
    MlTool,
    ApprovalRequest,
    ApprovalDecision,
    AgentResult,
    AgentTranscriptEntry,
    SessionRef,
    MlDebugEvent,
    DebugChatStart,
    DebugChatResult,
    DebugChatError,
    DebugSessionConfig,
    FetchLlmPayload,
    ChatOptions,
    ExtendProfile,
    JsonSchema,
    ToolCall,
    RenderDescriptor,
    ToolRenderInput,
    StoredSession,
    LoadedModel,
    MlHistory
} from "./contract";
import { evalReadonly } from "./readonly-exec";

(function() {

    // ---- Debug sidebar event stream (see sidebar.js) ----
    // The opt-in sidebar lives in the isolated content-script world; it can't read
    // this main-world `ml` state directly, so we push a one-way event stream to it
    // via window.postMessage. Emission is gated on a handshake: the sidebar posts
    // `{ __mlSidebar: "ready" }` when it mounts, so there's zero cost when it's off.
    let debugEnabled = false;   // live emission (after the iframe app handshakes)
    let sidebarPresent = false;  // a sidebar shell exists at all — gates ALL buffering, so a
    // disabled sidebar stays truly zero-cost. The shell posts `"present"` the moment it mounts
    // (only when config.sidebar is on), then `"ready"` once the iframe app is listening.
    // Ring buffer: the app handshakes only after it finishes loading, so ml calls in that window
    // were emitted into the void. We buffer from "present" and REPLAY on "ready" — the app is
    // freshly listening and got no live events before its own ready, so each lands exactly once.
    const DEBUG_RING_MAX = 200;
    const debugRing: MlDebugEvent[] = [];
    window.addEventListener("message", (event) => {
        const d = event.source === window && event.data && event.data.__mlSidebar;
        if (d === "present") { sidebarPresent = true; }
        else if (d === "ready") {
            sidebarPresent = debugEnabled = true;
            for (const ev of debugRing) { try { window.postMessage({ __mlDebug: ev }, "*"); } catch { /* non-cloneable — ignore */ } }
        }
    });
    /**
     * Emit a debug event to the sidebar via postMessage.
     * No-op when debugging is disabled; catches non-cloneable errors silently.
     *
     * @param {MlDebugEvent} event The event data to send.
     */
    // >0 while inside an ml.agent run, so chat calls the agent makes internally
    // (e.g. the auto-wired `look` vision tool) don't spawn their own orphan
    // sessions — their result already shows as the agent's tool step.
    let inAgentRun = 0;
    const emitDebug = (event: MlDebugEvent) => {
        if (!sidebarPresent) return;   // no sidebar → do nothing (disabled = zero cost)
        if (inAgentRun && event.kind.startsWith("chat")) return;   // never buffer/emit orphan internal chats
        debugRing.push(event);
        if (debugRing.length > DEBUG_RING_MAX) debugRing.shift();
        if (!debugEnabled) return;
        try { window.postMessage({ __mlDebug: event }, "*"); } catch (e) { /* non-cloneable — ignore */ }
    };
    /**
     * Generate a short unique id from timestamp and random bits.
     * Used for labeling individual chat requests in the debug stream.
     *
     * @returns {string} A short unique identifier.
     */
    const debugId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    /**
     * Generate a stable short hex id per session.
     * Uses crypto.getRandomValues when available, falls back to Math.random.
     * Shown in the debug sidebar and used to resume a conversation.
     *
     * @returns {string} A short hex identifier.
     */
    const shortHash = (): string => {
        try {
            const b = new Uint8Array(4); crypto.getRandomValues(b);
            return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
        } catch { return Math.random().toString(16).slice(2, 10); }
    };

    // Live registry of this tab's chat sessions (by hash) so ml.resumeChat can
    // continue one without a reload. Cross-reload/tab resume goes through storage
    // ({ save:true } only). In-memory → cleared on reload.
    const sessionRegistry = new Map<string, MlHistory>();

    // Ask the debug sidebar shell to hide its overlay for a screenshot (so it
    // isn't captured into the agent's `look`), resolving once it has painted the
    // hidden state (the shell acks after two frames). No-op with no wait when the
    // sidebar isn't mounted. The caller restores it with `{ __mlSidebarShot: "show" }`.
    const hideSidebarForShot = (): Promise<void> => new Promise(resolve => {
        const mounted = typeof document.getElementById === "function" && document.getElementById("ml-sb-root");
        if (!mounted) return resolve();   // sidebar off → nothing to hide, no wait
        let done = false;
        const finish = () => { if (done) return; done = true; window.removeEventListener("message", onAck); clearTimeout(timer); resolve(); };
        const onAck = (e: MessageEvent) => { if (e.data && e.data.__mlSidebarShot === "hidden") finish(); };
        window.addEventListener("message", onAck);
        const timer = setTimeout(finish, 200);   // safety net if the shell never acks
        window.postMessage({ __mlSidebarShot: "hide" }, "*");
    });

    // Minimal JSON-Schema check of a tool call's args vs the tool's `parameters`
    // (required / type / enum / unknown-property) — catches the model sending a
    // real tool the wrong shape. Not a full validator; enough to flag mistakes in
    // the debug view. Returns human-readable issue strings ([] = clean).
    const validateArgs = (schema: JsonSchema | undefined, args: Record<string, unknown>): string[] => {
        if (!schema || schema.type !== "object" || !schema.properties) return [];
        const props = schema.properties as Record<string, { type?: string; enum?: unknown[] }>;
        const issues: string[] = [];
        for (const req of (schema.required || [])) if (!(req in args)) issues.push(`missing required "${req}"`);
        const jsType = (v: unknown): string => Array.isArray(v) ? "array" : v === null ? "null" : typeof v;
        const okType = (v: unknown, t: string): boolean => {
            switch (t) {
                case "string": return typeof v === "string";
                case "integer": return typeof v === "number" && Number.isInteger(v);
                case "number": return typeof v === "number";
                case "boolean": return typeof v === "boolean";
                case "array": return Array.isArray(v);
                case "object": return v != null && typeof v === "object" && !Array.isArray(v);
                default: return true;
            }
        };
        for (const [k, v] of Object.entries(args)) {
            const spec = props[k];
            if (!spec) { issues.push(`unknown property "${k}"`); continue; }
            if (spec.type && !okType(v, spec.type)) issues.push(`"${k}" should be ${spec.type} (got ${jsType(v)})`);
            if (Array.isArray(spec.enum) && !spec.enum.includes(v)) issues.push(`"${k}" not in [${spec.enum.join(", ")}]`);
        }
        return issues;
    };

    // Validate the `extend` profile option — throw on anything but a known value.
    const validateExtend = (extend: ExtendProfile | null | undefined): void => {
        if (extend != null && extend !== "default" && extend !== "utility")
            throw new Error(`ml: invalid extend "${extend}" — use "default" or "utility".`);
    };

    /**
     * Make a background task promise that communicates with the content script via postMessage.
     * Posts a request and waits for the matching response, resolving with the result or rejecting with an error.
     *
     * @param {string} requestType The type of request to send.
     * @param {string} responseType The type of response to listen for.
     * @param {Object} payload The request payload.
     * @param {(result: any) => any} [callbackOnResponseSuccess] Optional callback to transform the result before resolving.
     * @returns {Promise<any>} The task result.
     */
    const makeBackgroundTaskPromise = <T = unknown>(
        requestType: string,
        responseType: string,
        payload: unknown,
        callbackOnResponseSuccess?: (result: unknown) => T
    ): Promise<T> => {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(7);

            function handleResponse(event: MessageEvent) {
                if (event.data.type === responseType && event.data.requestId === requestId) {
                    window.removeEventListener("message", handleResponse);
                    if (event.data.error) {
                        reject(event.data.error);
                    } else {
                        let result = event.data.result;
                        if (callbackOnResponseSuccess) result = callbackOnResponseSuccess(result);
                        resolve(result);
                    }
                }
            }

            window.addEventListener("message", handleResponse);

            window.postMessage({
                type: requestType,
                requestId: requestId,
                payload: payload
            }, "*");
        });
    };

    /**
     * Make a chat request that resolves { content, sources }.
     * The content string plus any server-side tool / RAG provenance the backend attached (empty otherwise).
     *
     * @param {FetchLlmPayload} payload The chat request payload.
     * @returns {Promise<{content: string, sources: Array}>} The chat response.
     */
    const makeChatRequest = (payload: FetchLlmPayload): Promise<{ content: string; sources: unknown[]; model: string | null; reasoning: string | null }> => {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(7);
            function handle(event: MessageEvent) {
                const d = event.data;
                if (!d || d.type !== "LLM_RESPONSE" || d.requestId !== requestId) return;
                window.removeEventListener("message", handle);
                if (d.error) reject(d.error);
                else resolve({ content: d.result, sources: d.sources || [], model: d.model ?? null, reasoning: d.reasoning ?? null });
            }
            window.addEventListener("message", handle);
            window.postMessage({ type: "LLM_REQUEST", requestId, payload }, "*");
        });
    };

    /**
     * Make a streaming chat request that fires onToken(delta, full) for each streamed chunk
     * and resolves { content, sources } once done. Rides a Port on the
     * content-script side (many messages), vs the one-shot request/response above.
     *
     * @param {FetchLlmPayload} payload The chat request payload.
     * @param {(delta: string, full: string) => void} onToken Callback fired for each streamed token.
     * @returns {Promise<{content: string, sources: Array}>} The chat response.
     */
    const makeStreamingTaskPromise = (
        payload: FetchLlmPayload,
        onToken: (delta: string, full: string) => void
    ): Promise<{ content: string; sources: unknown[]; model: string | null; reasoning: string | null }> => {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(7);
            let full = "";

            function handle(event: MessageEvent) {
                const d = event.data;
                if (!d || d.requestId !== requestId) return;
                if (d.type === "LLM_STREAM_CHUNK") {
                    const delta = d.delta || "";
                    full += delta;
                    // A throwing caller callback shouldn't break the stream.
                    try { onToken(delta, full); } catch (e) { console.error("ml onToken threw:", e); }
                } else if (d.type === "LLM_STREAM_DONE") {
                    window.removeEventListener("message", handle);
                    resolve({ content: d.content != null ? d.content : full, sources: d.sources || [], model: d.model ?? null, reasoning: d.reasoning ?? null });
                } else if (d.type === "LLM_STREAM_ERROR") {
                    window.removeEventListener("message", handle);
                    reject(d.error);
                }
            }

            window.addEventListener("message", handle);
            window.postMessage({ type: "LLM_STREAM_REQUEST", requestId, payload }, "*");
        });
    };

    // ---- Agent tool helpers (page-context DOM introspection) ----
    // These keep observations SMALL on purpose: the point of the agent is to
    // iterate with cheap probes instead of dumping HTML into the model's
    // context. Every helper truncates hard and never returns outerHTML.

    /**
     * Truncate a string to n characters, replacing with ellipsis if needed.
     * Normalizes whitespace first (collapses to single spaces, trims).
     *
     * @param {*} str The value to truncate (coerced to string).
     * @param {number} n Max characters before truncation.
     * @returns {string} The truncated string.
     */
    const truncate = (str: string, n: number): string => {
        str = String(str == null ? "" : str).replace(/\s+/g, " ").trim();
        return str.length > n ? str.slice(0, n) + "…" : str;
    };

    /**
     * Extract error text from a caught throw.
     * Background tasks reject with a plain STRING (not an Error), so `e.message` would be undefined — fall back to the value.
     *
     * @param {*} e The caught error value.
     * @returns {string} The error message text.
     */
    const errText = (e: unknown): string => (e && (e as Error).message) ? (e as Error).message : String(e);

    /**
     * Build a compact structural path for an element.
     * Format: body > div#main > div.card > h2.title
     * Tag + id + up to 4 classes per ancestor, capped at 8 hops — enough for the
     * model to recognise the repeating container, small enough to stay cheap.
     *
     * @param {Element} el The element to build a path for.
     * @returns {string} The structural path string.
     */
    const elPath = (el: Element): string => {
        const parts: string[] = [];
        let node: Node | null = el, hops = 0;
        while (node && node.nodeType === 1 && node !== document.documentElement && hops < 8) {
            const elem = node as Element;
            let seg = elem.tagName.toLowerCase();
            if (elem.id) seg += "#" + elem.id;
            if (elem.classList && elem.classList.length) {
                seg += "." + [...elem.classList].slice(0, 4).join(".");
            }
            parts.unshift(seg);
            node = node.parentElement;
            hops++;
        }
        return parts.join(" > ");
    };

    // Fold typographic punctuation + whitespace to ASCII so a search for
    // "web-browser" matches a page that rendered "web‑browser" (non-breaking
    // hyphen) — plus curly quotes, non-breaking spaces, ellipsis, full-width
    // forms (NFKC). A model's own fancy hyphen in its output otherwise defeats its
    // own later findByText/:contains search. Also lowercases for case-insensitivity.
    const normalizeText = (s: string | null | undefined): string => (s || "")
        .normalize("NFKC")
        .replace(/[‐-―−⁃﹘﹣－]/g, "-")   // hyphens/dashes/minus → -
        .replace(/[‘’‚‛′]/g, "'")               // curly / prime single quotes → '
        .replace(/[“”„‟″]/g, '"')               // curly / prime double quotes → "
        .replace(/\s+/g, " ").trim().toLowerCase();

    // --- Accessibility surface (the "screen reader" view) --------------------
    // The agent is in a blind user's position — it needs a controls list by ROLE +
    // ACCESSIBLE NAME, exactly what NVDA's Elements List / VoiceOver's Rotor read.
    // These are pragmatic subsets of the WAI-ARIA accname/role algorithms — enough
    // for real controls, not spec-complete.
    const INTERACTIVE_SEL = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, ' +
        '[role="button"], [role="link"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
        '[role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="option"], [role="combobox"], ' +
        '[role="slider"], [role="textbox"], [role="searchbox"], [contenteditable="true"], [onclick], ' +
        '[tabindex]:not([tabindex="-1"])';

    const roleOf = (el: Element): string => {
        const explicit = el.getAttribute("role");
        if (explicit) return explicit.trim().split(/\s+/)[0];
        const tag = el.tagName.toLowerCase();
        if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
        if (tag === "select") return "combobox";
        if (tag === "textarea") return "textbox";
        if (tag === "summary") return "button";
        if (tag === "input") {
            const t = (el.getAttribute("type") || "text").toLowerCase();
            return ({ checkbox: "checkbox", radio: "radio", button: "button", submit: "button", reset: "button", image: "button", range: "slider", search: "searchbox" } as Record<string, string>)[t] || "textbox";
        }
        if ((el as HTMLElement).isContentEditable) return "textbox";
        return tag;
    };

    // Accessible name: aria-labelledby → aria-label → alt/label/placeholder/value →
    // visible text → title → a nested img alt / svg <title> (icon buttons).
    const accessibleName = (el: Element): string => {
        const norm = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
        const lb = el.getAttribute("aria-labelledby");
        if (lb) {
            const txt = lb.split(/\s+/).map(id => norm(document.getElementById(id)?.textContent)).filter(Boolean).join(" ");
            if (txt) return txt;
        }
        const al = norm(el.getAttribute("aria-label"));
        if (al) return al;
        const tag = el.tagName.toLowerCase();
        if (tag === "img" || tag === "area") { const alt = norm(el.getAttribute("alt")); if (alt) return alt; }
        if (tag === "input" || tag === "textarea" || tag === "select") {
            if (el.id && typeof CSS !== "undefined") { const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (lab && norm(lab.textContent)) return norm(lab.textContent); }
            const wrap = el.closest("label"); if (wrap && norm(wrap.textContent)) return norm(wrap.textContent);
            const ph = norm(el.getAttribute("placeholder")); if (ph) return ph;
            const val = norm((el as HTMLInputElement).value); if (val) return val;
        }
        const own = norm(el.textContent);
        if (own) return own;
        const title = norm(el.getAttribute("title")); if (title) return title;
        const img = el.querySelector("img[alt]"); if (img && norm(img.getAttribute("alt"))) return norm(img.getAttribute("alt"));
        const svgT = el.querySelector("svg title"); if (svgT && norm(svgT.textContent)) return norm(svgT.textContent);
        return "";
    };

    // ARIA state suffix a screen reader would announce (disabled/checked/…).
    const ariaState = (el: Element): string => {
        const s: string[] = [];
        if ((el as HTMLInputElement).disabled || el.getAttribute("aria-disabled") === "true") s.push("disabled");
        const checked = el.getAttribute("aria-checked") ?? ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio" ? String((el as HTMLInputElement).checked) : null);
        if (checked === "true") s.push("checked"); else if (checked === "false") s.push("unchecked");
        if (el.getAttribute("aria-pressed") === "true") s.push("pressed");
        if (el.getAttribute("aria-expanded")) s.push(el.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed");
        if (el.getAttribute("aria-selected") === "true") s.push("selected");
        return s.join(", ");
    };

    // Visible enough to announce. Rect checks only when layout exists (jsdom has
    // none), so the tool still enumerates under test.
    const hasLayout = (): boolean => { try { return document.documentElement.getBoundingClientRect().height > 0; } catch { return false; } };
    // "Not there" = display:none / hidden / aria-hidden. Deliberately NOT
    // visibility:hidden or opacity:0 — those are how row actions (edit/delete) are
    // revealed on hover, and they're still programmatically clickable, so they're
    // exactly the controls the agent can't otherwise find. `faded` flags them.
    const styleHidden = (el: Element): boolean => {
        if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
        try { if (getComputedStyle(el).display === "none") return true; } catch { /* jsdom */ }
        return false;
    };
    const isFaded = (el: Element): boolean => {
        try { const cs = getComputedStyle(el); return cs.visibility === "hidden" || +cs.opacity === 0; } catch { return false; }
    };

    /**
     * Build a skeleton line for an element and its descendants to `depth`: tags, ids,
     * classes, data-* attributes, and each element's OWN text only — never the
     * text of descendants (that's what the tree shows) and never innerHTML.
     * One compact line for an element: tag#id.classes [data-*] "own text". No
     * children — shared by describeSkeleton (per node) and the ancestors tool.
     *
     * @param {Element} el The element to build a line for.
     * @returns {string} The skeleton line string.
     */
    const elLine = (el: Element): string => {
        let seg = el.tagName.toLowerCase();
        if (el.id) seg += "#" + el.id;
        if (el.classList && el.classList.length) seg += "." + [...el.classList].slice(0, 6).join(".");
        const dataAttrs = [...el.attributes]
            .filter(a => a.name.startsWith("data-"))
            .slice(0, 6)
            .map(a => `${a.name}="${truncate(a.value, 20)}"`);
        if (dataAttrs.length) seg += " [" + dataAttrs.join(" ") + "]";
        const ownText = [...el.childNodes]
            .filter(n => n.nodeType === 3)
            .map(n => n.textContent)
            .join(" ")
            .trim();
        if (ownText) seg += ` "${truncate(ownText, 60)}"`;
        return seg;
    };

    /**
     * Build a skeleton tree of an element and its descendants to a given depth.
     * Format: tag#id.classes [data-*] "own text" per line, indented by hierarchy.
     *
     * @param {Element} el The element to describe.
     * @param {number} depth How many levels of children to include.
     * @param {string} [indent=""] Current indentation level.
     * @returns {string} The skeleton tree as a newline-separated string.
     */
    const describeSkeleton = (el: Element, depth: number, indent = ""): string => {
        let out = indent + elLine(el);
        if (el.children.length && depth > 0) {
            for (const k of [...el.children].slice(0, 12)) {
                out += "\n" + describeSkeleton(k, depth - 1, indent + "  ");
            }
            if (el.children.length > 12) out += "\n" + indent + `  …(${el.children.length - 12} more)`;
        } else if (el.children.length) {
            // Depth exhausted here — flag that children exist so the model knows to
            // describeElement deeper instead of mistaking this for a leaf.
            out += ` › ${el.children.length} child${el.children.length === 1 ? "" : "ren"}`;
        }
        return out;
    };

    // Resolve a selector that MAY carry a jQuery/Sizzle/Playwright predicate the
    // model reaches for but native `querySelectorAll` lacks:
    //   • text — `:contains("x")` / `:has-text("x")`: peel OFF THE END, run the
    //     (native) base, filter by textContent (case-insensitive, all required).
    //   • positional — `:eq(n)` (jQuery, 0-based): peel and pick the nth match.
    //   • `:nth-of-type(n)` / `:nth-child(n)` FALLBACK: these ARE native, but the
    //     model habitually writes `.foo:nth-of-type(2)` meaning "the 2nd .foo",
    //     whereas native nth-of-type is per-TAG and usually matches nothing. So we
    //     run the literal selector first and, ONLY when it finds nothing, reinterpret
    //     a trailing nth-of-type/child(n) as the 1-based nth match of the base set.
    //     Correct native uses (non-empty) are never touched.
    // Native `:has()` is left alone. A mid-selector text predicate stays in the base
    // and throws, so selectorError still catches genuine mistakes. Returns an array.
    // Greedy prefixes so the LAST predicate peels first (handles chains like
    // `.card:contains("a"):eq(0)`).
    const TRAILING_TEXT_PSEUDO = /^([\s\S]*):(?:contains|has-text)\(\s*(['"]?)([\s\S]*?)\2\s*\)\s*$/i;
    const TRAILING_EQ_PSEUDO = /^([\s\S]*):eq\(\s*(\d+)\s*\)\s*$/i;
    const TRAILING_NTH_NATIVE = /^([\s\S]*):nth-(?:of-type|child)\(\s*(\d+)\s*\)\s*$/i;

    /**
     * Query all elements matching a selector, with jQuery-style pseudo-selector support.
     * Resolves trailing :contains(), :has-text(), :eq(n), and :nth-of-type(n)/:nth-child(n) fallbacks.
     * Returns an array of matching elements.
     *
     * @param {string} selector The CSS selector (possibly with pseudo-selectors).
     * @returns {Element[]} Array of matching elements (may be empty).
     */
    const queryAll = (selector: string): Element[] => {
        let base = String(selector).trim();
        const texts: string[] = [];
        let eqIndex: number | null = null;   // trailing :eq(n) → jQuery-style 0-based positional pick
        // Peel trailing :eq and text predicates (loop for chained/mixed ones). :eq
        // comes off FIRST each pass: the text regex's optional-quote branch would
        // otherwise greedily swallow a following `:eq(1)` into its match text.
        for (let changed = true; changed; ) {
            changed = false;
            let m = base.match(TRAILING_EQ_PSEUDO);
            if (m && eqIndex === null) { eqIndex = parseInt(m[2], 10); base = m[1].trim(); changed = true; continue; }
            m = base.match(TRAILING_TEXT_PSEUDO);
            if (m) { texts.unshift(m[3]); base = m[1].trim(); changed = true; }
        }
        // Run a (native) selector and apply any collected text filter.
        const run = (sel: string): Element[] => {
            let els = [...document.querySelectorAll(sel || "*")];
            if (texts.length) {
                const wanted = texts.map(normalizeText);
                els = els.filter(el => {
                    const tc = normalizeText(el.textContent);
                    return wanted.every(w => tc.includes(w));
                });
            }
            return els;
        };
        const els = run(base);
        if (eqIndex !== null) return els[eqIndex] ? [els[eqIndex]] : [];
        if (!els.length) {
            const m = base.match(TRAILING_NTH_NATIVE);
            if (m) {
                const pool = run(m[1].trim());
                const i = parseInt(m[2], 10) - 1;   // CSS nth-* is 1-based
                return pool[i] ? [pool[i]] : [];
            }
        }
        return els;
    };

    /**
     * Turn a querySelector failure into a useful message.
     * If the model used a text pseudo-selector mid-selector (queryAll only supports it at the END), say so;
     * otherwise surface the raw error.
     *
     * @param {string} selector The selector that failed.
     * @param {Error} err The caught error.
     * @returns {string} A helpful error message.
     */
    const selectorError = (selector: string, err: Error): string => {
        if (/:has-text\s*\(|:contains\s*\(/i.test(selector)) {
            return "Invalid selector: :contains()/:has-text() text predicates are only supported at " +
                'the END of a selector (e.g. `div.card:contains("text")`). Move it to the final part, ' +
                "or use exec for a text filter.";
        }
        return `Invalid selector: ${err.message}`;
    };

    /**
     * Build a compact "where and when am I" snapshot: URL, title, page language, and the
     * current date/time + locale/timezone. ml.agent injects this by default (so the
     * model is oriented — and knows what "today" is, and that a site like amazon.nl
     * implies Dutch), and the pageInfo tool exposes it on demand. Guarded so it
     * degrades gracefully when a global is missing (e.g. in tests).
     *
     * @returns {string} A formatted string with page context info.
     */
    const pageContext = (): string => {
        const parts = [];
        try { if (typeof location !== "undefined" && location.href) parts.push(`URL: ${location.href}`); } catch {}
        try { if (typeof document !== "undefined" && document.title) parts.push(`Title: ${truncate(document.title, 80)}`); } catch {}
        try {
            const lang = (typeof document !== "undefined" && document.documentElement && document.documentElement.getAttribute)
                ? document.documentElement.getAttribute("lang") : null;
            if (lang) parts.push(`Page language: ${lang}`);
        } catch {}
        let locale, tz;
        try { const o = Intl.DateTimeFormat().resolvedOptions(); locale = o.locale; tz = o.timeZone; } catch {}
        const now = new Date();
        parts.push(`Now: ${now.toLocaleString(locale)}${tz ? ` (${tz})` : ""} — ISO ${now.toISOString()}`);
        if (locale) parts.push(`Locale: ${locale}`);
        return parts.join("\n");
    };

    /**
     * Await a short beat so a click/submit's navigation or DOM update can begin
     * before we read the result. Guarded: where setTimeout is absent (the jsdom
     * test sandbox) it resolves immediately rather than throwing.
     *
     * @param {number} ms Milliseconds to wait (passed to setTimeout).
     * @returns {Promise<void>} Resolves after the delay (or immediately in test sandbox).
     */
    const settle = (ms: number): Promise<void> => new Promise(r => (typeof setTimeout === "function" ? setTimeout(r, ms) : r()));

    // Smallest CSS-px width/height an element may have and still be worth
    // screenshotting. Below this (a 1px spacer, a collapsed box) the crop is a
    // useless sliver; ml.screenshot rejects instead of sending it (roadmap #10).
    // Kept tiny so genuinely small-but-real targets (icons, badges) still pass.
    const MIN_SHOT_PX = 4;

    /**
     * Crop a full-viewport PNG data URL down to an element's rect. Runs page-side
     * because a data: image doesn't taint the canvas (the cross-origin-taint
     * gotcha only bites remote images), so pixel readback works. rect is in CSS
     * px; the captured PNG is at devicePixelRatio, so scale by dpr and clamp to
     * the image bounds (an element taller than the viewport gets clipped).
     *
     * @param {string} dataUrl The full-viewport PNG data URL.
     * @param {DOMRect} rect The element's bounding rectangle.
     * @param {number} dpr The device pixel ratio.
     * @returns {Promise<string>} The cropped image as a data URL.
     */
    const cropDataUrl = (dataUrl: string, rect: DOMRect, dpr: number): Promise<string> => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const sx = Math.max(0, Math.round(rect.left * dpr));
            const sy = Math.max(0, Math.round(rect.top * dpr));
            const sw = Math.max(1, Math.min(Math.round(rect.width * dpr), img.naturalWidth - sx));
            const sh = Math.max(1, Math.min(Math.round(rect.height * dpr), img.naturalHeight - sy));
            const canvas = document.createElement("canvas");
            canvas.width = sw;
            canvas.height = sh;
            canvas.getContext("2d")!.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
            resolve(canvas.toDataURL("image/png"));
        };
        img.onerror = () => reject(new Error("failed to load the captured screenshot"));
        img.src = dataUrl;
    });

    // Default system prompt for ml.agent. Deliberately generic — it describes the
    // agent's situation and the discipline (iterate in small steps, verify before
    // acting, one general rule over many actions), NOT any specific task or site.
    // Pass your own `system` for task-specific strategy (see examples/).
    const AGENT_SYSTEM = [
        "You are an automation agent operating on the CURRENT web page through a set",
        "of tools. You cannot see the page directly — discover its structure by",
        "calling tools, in small steps, like working in the devtools console. Your",
        "available tools are in the function schema; use the ones that fit.",
        "",
        "General method:",
        "1. ORIENT — get your bearings (what page is this, what's on it).",
        "2. LOCATE — anchor on a known bit of visible text (findByText). For a control",
        "   with NO visible text (icon buttons, toolbar/row actions like edit/like/menu),",
        "   use `interactives` — it lists the controls by accessible name, like a screen",
        "   reader, so you pick from the list instead of guessing selectors in exec.",
        "3. NAVIGATE the DOM — inspect an element's structure DOWN into its children",
        "   and UP through its ancestors to reach the repeating container, or the",
        "   specific element, you need.",
        "4. VERIFY before acting — check a selector (count its matches, sample their",
        "   text); reject implausible counts; prefer data-* attributes and stable",
        "   structural anchors over obfuscated, build-versioned class names.",
        "5. ACT with ONE general rule that handles all matching items at once, not",
        "   item-by-item.",
        "6. CONFIRM the outcome, and iterate if needed.",
        "",
        "Be DECISIVE — you have a limited number of tool-steps. Once a selector is",
        "verified, ACT; don't keep exploring for its own sake (you can always observe",
        "again afterward). If the task has several independent parts, apply each the",
        "moment it's verified rather than investigating them all before acting.",
        "",
        "Before declaring done, sanity-check the OUTCOME: confirm the change took and",
        "that nothing slipped past the rule you used — a concept can have more than",
        "one form on the page, so a selector scoped to one form will miss the others.",
        "",
        "KNOW YOUR LIMITS: if the task needs a capability you have no tool for — e.g.",
        "judging what a photo/image depicts when you have no vision tool — STOP and",
        "say plainly which tool you'd need, rather than guessing.",
        "",
        "When the task is complete, stop calling tools and reply with a one-line",
        "summary of what you did (or why you couldn't)."
    ].join("\n");

    // Tool-aware clauses appended to AGENT_SYSTEM (only when the caller didn't
    // supply its own `system`) based on what the toolset can actually do.
    const VISION_CLAUSE =
        "\n\nYou have a VISION tool: use it to ORIENT (see the page) when the task or " +
        "layout is unclear, and to VERIFY your work by looking at the result before " +
        "declaring done — a screenshot catches what a DOM selector scoped to one form missed. " +
        "But to JUDGE INDIVIDUAL ITEMS (e.g. which posts in a grid show a cat), look at each " +
        "one with the item selector and an incrementing index (0,1,2,…) — a tight per-element " +
        "crop is sharp, decisive, and bound to that exact element (answer the same selector+index " +
        "for the ones that match). Do NOT classify items from a whole-page/grid screenshot: it is " +
        "downscaled to mush and its verdicts are unreliable and won't map to specific elements.";
    const ANSWER_CLAUSE =
        "\n\nIf the task asks you to FIND / LOCATE / return an element (rather than change " +
        "the page), designate it with the answer tool (by selector) so the actual element " +
        "is handed back to the caller.";
    const WAIT_CLAUSE =
        "\n\nThe page updates ASYNCHRONOUSLY — clicks, typing, navigation and lazy-loading take " +
        "effect after a delay, NOT instantly. So after any action that triggers an update, use the " +
        "`wait` tool BEFORE you look/read again, and use it GENEROUSLY: prefer `wait({ selector })` " +
        "to wait until a specific element appears (the page has settled), or `wait({ ms })` for a " +
        "fixed pause. Reading a mid-update page gives stale results and wastes steps — waiting is cheap.";

    // Invisible / bidi / format-control characters that never legitimately appear
    // in code but are the vector for Trojan-Source and homoglyph prompt-injection
    // attacks. Model-written scripts get scanned before you approve them.
    const SUSPICIOUS_CHARS: { [key: number]: string } = {
        0x202A: "LEFT-TO-RIGHT EMBEDDING", 0x202B: "RIGHT-TO-LEFT EMBEDDING",
        0x202C: "POP DIRECTIONAL FORMATTING", 0x202D: "LEFT-TO-RIGHT OVERRIDE",
        0x202E: "RIGHT-TO-LEFT OVERRIDE", 0x2066: "LEFT-TO-RIGHT ISOLATE",
        0x2067: "RIGHT-TO-LEFT ISOLATE", 0x2068: "FIRST STRONG ISOLATE",
        0x2069: "POP DIRECTIONAL ISOLATE", 0x200E: "LEFT-TO-RIGHT MARK",
        0x200F: "RIGHT-TO-LEFT MARK", 0x061C: "ARABIC LETTER MARK",
        0x200B: "ZERO WIDTH SPACE", 0x200C: "ZERO WIDTH NON-JOINER",
        0x200D: "ZERO WIDTH JOINER", 0x2060: "WORD JOINER",
        0xFEFF: "ZERO WIDTH NO-BREAK SPACE (BOM)", 0x00AD: "SOFT HYPHEN",
        0x180E: "MONGOLIAN VOWEL SEPARATOR"
    };
    /**
     * Scan a string for suspicious/bidi/format-control characters.
     * Returns [{ index, code, name }]. Also flags other C0/C1 control chars
     * (except tab/newline/CR, which are normal).
     *
     * @param {string} str The string to scan.
     * @returns {Array<{index: number, code: string, name: string}>} Array of findings.
     */
    const suspiciousChars = (str: string): { index: number; code: string; name: string }[] => {
        const out: { index: number; code: string; name: string }[] = [];
        const s = String(str == null ? "" : str);
        for (let i = 0; i < s.length; i++) {
            const code = s.charCodeAt(i);
            let name = SUSPICIOUS_CHARS[code];
            if (!name && (code <= 0x08 || code === 0x0B || code === 0x0C ||
                (code >= 0x0E && code <= 0x1F) || (code >= 0x7F && code <= 0x9F))) {
                name = "CONTROL CHARACTER";
            }
            if (name) out.push({ index: i, code: "U+" + code.toString(16).toUpperCase().padStart(4, "0"), name });
        }
        return out;
    };
    /**
     * Generate a warning banner for the approval prompt when any string arg hides suspicious chars.
     *
     * @param {Object} args The arguments object to check.
     * @returns {string} Warning banner if suspicious chars found, empty string otherwise.
     */
    const suspiciousArgsWarning = (args: unknown): string => {
        const findings: { index: number; code: string; name: string }[] = [];
        for (const v of Object.values(args || {})) {
            if (typeof v === "string") findings.push(...suspiciousChars(v));
        }
        if (!findings.length) return "";
        const names = [...new Set(findings.map(f => f.name))].slice(0, 4).join(", ");
        return `⚠ WARNING: ${findings.length} hidden/suspicious character(s) — ${names} ` +
            `— possible prompt-injection. Inspect carefully before allowing.\n\n`;
    };

    /**
     * Render a tool's arguments for an approval prompt.
     * String values shown raw (real newlines — so an exec `js` blob is readable, not escaped JSON),
     * others as compact JSON.
     *
     * @param {Object} args The arguments to render.
     * @returns {string} The rendered arguments string.
     */
    const renderArgs = (args: unknown): string => Object.entries(args || {})
        .map(([k, v]) => `${k}:\n${typeof v === "string" ? v : JSON.stringify(v)}`)
        .join("\n\n");

    /**
     * Built-in onStep tracer for ml.agent({ logDebug: true }).
     * One console line per event — the model's reasoning, or a tool call with its args, result,
     * and any live DOM nodes (logged as real objects so they're hoverable in devtools).
     * Exposed as ml._logStep so you can also pass it as onStep yourself.
     *
     * @param {{step: number, thought?: string, tool?: string, arguments?: Object, result?: string, elements?: Node[]}} ev The event data.
     */
    const logStep = (ev: { step: number; thought?: string; tool?: string; arguments?: unknown; result?: string; elements?: Node[] }) => ev.thought
        ? console.log(`#${ev.step} 💭`, ev.thought)
        : console.log(`#${ev.step} ${ev.tool}`, ev.arguments, "→", String(ev.result), ...(ev.elements || []));

    /**
     * Default approval gate for tools flagged requiresApproval (e.g. exec).
     * A blocking page confirm() showing the tool and its arguments. Console-first,
     * so a native prompt is the right "pause and force approval". If confirm
     * isn't available (non-interactive context) it fails safe to DENY — pass a
     * custom `approve` to ml.agent for headless/automated use.
     *
     * @param {{tool: string, arguments: Object}} req The approval request.
     * @returns {boolean} True if approved, false otherwise.
     */
    const defaultApprove = ({ tool, arguments: args }: ApprovalRequest): boolean => {
        if (typeof window.confirm !== "function") return false;
        return window.confirm(
            `${suspiciousArgsWarning(args)}window.ml agent wants to run "${tool}":\n\n${renderArgs(args)}\n\nAllow this?`
        );
    };

    /**
     * Normalize what an `approve` gate returned into { approved, feedback, arguments }.
     * The contract accepts a plain boolean OR a rich object so an approval UI can:
     *   • feed a rejection COMMENT back to the model (`feedback`) instead of the
     *     fixed "Denied" string, and
     *   • EDIT the arguments before the tool runs (`arguments`, only on approval).
     * `orig` is the model-proposed arguments — the fallback when none were edited.
     *
     * @param {boolean|{approved: boolean, feedback?: string, arguments?: Object}} result The approval result.
     * @param {Object} orig The original arguments.
     * @returns {{approved: boolean, feedback: string|null, arguments: Object}} Normalized approval result.
     */
    const normalizeApproval = (result: ApprovalDecision, orig: Record<string, unknown>): { approved: boolean; feedback: string | null; arguments: Record<string, unknown> } => {
        if (result && typeof result === "object") {
            const edited = result.approved && result.arguments && typeof result.arguments === "object";
            return {
                approved: !!result.approved,
                feedback: typeof result.feedback === "string" && result.feedback.trim() ? result.feedback.trim() : null,
                arguments: edited && result.arguments ? result.arguments : orig
            };
        }
        return { approved: !!result, feedback: null, arguments: orig };
    };

    // Format a read-only interpreter result the same way the `exec` tool does
    // (console-prefix + value / element-count envelope), for the auto-approve
    // fast-path in the agent loop.
    function formatReadonlyExec(result: unknown, logs: string[]): { result: string; elements?: Node[] } {
        const logged = logs.length ? `console:\n${truncate(logs.join("\n"), 500)}` : "";
        const withLogs = (value: string) => logged ? `${logged}\n\nvalue: ${value}` : value;
        if (typeof Element !== "undefined" && result instanceof Element) {
            return { result: withLogs(elPath(result)), elements: [result] };
        }
        const isNodes = !!result && (
            (typeof NodeList !== "undefined" && result instanceof NodeList) ||
            (typeof HTMLCollection !== "undefined" && result instanceof HTMLCollection) ||
            (Array.isArray(result) && result.length > 0 && result.every((n: unknown) => typeof Element !== "undefined" && n instanceof Element))
        );
        if (isNodes) {
            const nodes = Array.from(result as ArrayLike<Node>);
            return { result: withLogs(`${nodes.length} element(s)`), elements: nodes.slice(0, 50) };
        }
        let value: string;
        if (result === undefined) value = "(undefined)";
        else if (typeof result === "object") { try { value = truncate(JSON.stringify(result), 500); } catch { value = truncate(String(result), 500); } }
        else value = truncate(String(result), 500);
        return { result: withLogs(value) };
    }

    window.ml = {
        /**
         * Create a stateful multi-turn chat session.
         *
         * Stateful multi-turn chat:
         *
         * ```js
         *   const history = ml.createChat({ system, model, think });
         *   await history.chat("first question", { images: [...] });
         *   await history.chat("follow-up");
         *   history.messages.at(-1)   // last message
         *   history.fork()            // independent copy of the conversation
         *
         * ```
         *
         * `history.messages` is a plain `[{ role, content, images? }]` array. You can
         * edit it freely (pop to retry, splice to prune, tweak `.content`).
         * A failed request leaves the history untouched.
         *
         * @param {Object} [options] Options object.
         * @param {string} [options.system] Optional system prompt (first message).
         * @param {string} [options.model] Default model for this chat; null uses the saved default.
         * @param {boolean} [options.think=false] True/false maps to Ollama's "think" parameter; null omits it.
         * @param {Object} [options.schema] JSON Schema to constrain reply to matching JSON (returns parsed object).
         * @param {string[]} [options.toolIds] OpenWebUI server-side tool ids (e.g. `["web_search"]`). OpenWebUI only.
         * @param {number} [options.maxTokens] Hard cap on generated tokens; null omits it.
         * @param {boolean} [options.save=false] Persist across reloads when debug sidebar is on.
         * @returns {{messages: Array<{role: string, content: string, images?: Array, sources?: Array}>, hash: string, model: string|null, think: boolean, schema: Object|null, toolIds: string[]|null, maxTokens: number|null, save: boolean, chat: Function, fork: Function}} Chat session object.
         */
        createChat: function({ system = null, model = null, extend = null, numCtx = null, numGpu = null, think = false, schema = null, toolIds = null, maxTokens = null, save = false }: Pick<ChatOptions, "system" | "model" | "extend" | "numCtx" | "numGpu" | "think" | "schema" | "toolIds" | "maxTokens"> & { save?: boolean } = {}): MlHistory {
            validateExtend(extend);
            const ml = this;
            const history: MlHistory = {
                messages: system ? [{ role: "system", content: system }] : [],
                // Stable per-session id (see the debug sidebar). Read it off the
                // history object (history.hash) to identify / later resume a chat.
                hash: shortHash(),
                model,
                extend,
                numCtx,
                numGpu,
                think,
                schema,
                toolIds,
                maxTokens,
                save,
                /**
                 * Send a turn in this chat session.
                 *
                 * @param {string} prompt The user prompt.
                 * @param {Object} [options] Options object.
                 * @param {Array} [options.images=[]] Images to include with the prompt.
                 * @param {string} [options.model=this.model] Model override for this turn.
                 * @param {boolean} [options.think=this.think] Thinking flag for this turn.
                 * @param {Object} [options.schema=this.schema] JSON Schema for structured output.
                 * @param {string[]} [options.toolIds=this.toolIds] OpenWebUI server-side tool ids.
                 * @param {number} [options.maxTokens=this.maxTokens] Token limit for this turn.
                 * @param {boolean} [options.save=this.save] Persist this turn when sidebar is on.
                 * @param {(delta: string, full: string) => void} [options.onToken=null] Streaming callback.
                 * @returns {Promise<string|Object>} The model's reply (parsed if schema set).
                 */
                chat: async function(this: MlHistory, prompt: string, { images = [], model = this.model, extend = this.extend, numCtx = this.numCtx, numGpu = this.numGpu, think = this.think, schema = this.schema, toolIds = this.toolIds, maxTokens = this.maxTokens, save = this.save, onToken }: {
                    images?: (string | HTMLImageElement)[];
                    model?: string | null;
                    extend?: ExtendProfile | null;
                    numCtx?: number | null;
                    numGpu?: number | null;
                    think?: boolean | null;
                    schema?: JsonSchema | null;
                    toolIds?: string[] | null;
                    maxTokens?: number | null;
                    save?: boolean;
                    onToken?: (delta: string, full: string) => void;
                } = {}): Promise<string | Record<string, unknown>> {
                    validateExtend(extend);
                    const userMessage: NeutralMessage = { role: "user", content: prompt };
                    if (images.length) {
                        userMessage.images = await Promise.all(
                            images.map(image => ml._imageToDataUrl(image))
                        );
                    }

                    const requestPayload: FetchLlmPayload = { "messages": [...this.messages, userMessage], "think": think, "model": model, "extend": extend, "numCtx": numCtx, "numGpu": numGpu, "schema": schema, "toolIds": toolIds, "maxTokens": maxTokens };
                    // Debug sidebar: announce the request (no-op unless the sidebar is on).
                    const debug = debugId();
                    // Group turns of THIS conversation by the session hash; `turn` is
                    // this turn's 0-based index (prior user messages). Fixes the
                    // "each follow-up spawns a new block" bug in the sidebar.
                    const session: SessionRef = { hash: this.hash, turn: this.messages.filter(m => m.role === "user").length };
                    // The session's creation config (createChat options) — what
                    // the sidebar's "options" block shows, distinct from the
                    // per-turn request/messages below. Sourced from the history
                    // (this.*) + the closed-over `system`, so it reflects the
                    // createChat instantiation, not any per-turn overrides.
                    const config: DebugSessionConfig = {
                        system,
                        model: this.model,
                        think: (this.think === true || this.think === false) ? this.think : null,
                        schema: !!this.schema,
                        toolIds: this.toolIds || null,
                        maxTokens: this.maxTokens ?? null,
                        save: this.save
                    };
                    emitDebug({ kind: "chat", id: debug, ts: Date.now(), save, session, streaming: typeof onToken === "function" && !schema, config, request: {
                        model: model || null,
                        extend: extend || null,
                        messages: requestPayload.messages,
                        images: userMessage.images || null,
                        toolIds: toolIds || null,
                        schema: !!schema,
                        think: (think === true || think === false) ? think : null,
                        maxTokens: maxTokens ?? null
                    } });
                    let content, sources, resolvedModel, reasoning;
                    try {
                        ({ content, sources, model: resolvedModel, reasoning } = (typeof onToken === "function" && !schema)
                            ? await makeStreamingTaskPromise(requestPayload, onToken)
                            : await makeChatRequest(requestPayload));
                    } catch (err) {
                        emitDebug({ kind: "chat-error", id: debug, ts: Date.now(), save, session, error: String((err as Error).message || err) });
                        throw err;
                    }
                    const reply = content;
                    const assistantMessage: NeutralMessage = { role: "assistant", content: reply };
                    if (sources && sources.length) assistantMessage.sources = sources;
                    this.messages.push(userMessage, assistantMessage);
                    // Persist { save:true } sessions so ml.resumeChat survives reloads/tabs
                    // (fire-and-forget; no secrets in a session — just history + options).
                    if (save) makeBackgroundTaskPromise("SAVE_SESSION_REQUEST", "SAVE_SESSION_RESPONSE", {
                        hash: this.hash,
                        session: {
                            hash: this.hash, messages: this.messages, model: this.model, extend: this.extend,
                            numCtx: this.numCtx, numGpu: this.numGpu, think: this.think, schema: this.schema,
                            toolIds: this.toolIds, maxTokens: this.maxTokens, save: true,
                        },
                    }).catch(() => { /* storage full / unavailable — resume just won't have this turn */ });
                    emitDebug({ kind: "chat-result", id: debug, ts: Date.now(), save, session, content: reply, sources: (sources && sources.length) ? sources : null, structured: !!schema, model: resolvedModel || model || null, extend: extend || null, reasoning: reasoning || null });
                    return (schema ? ml._parseJSON(reply) : reply) as string | Record<string, unknown>;
                },
                /**
                 * Create an independent copy of this chat session.
                 *
                 * @returns {{messages: Array, hash: string, model: string|null, think: boolean, schema: Object|null, toolIds: string[]|null, maxTokens: number|null, save: boolean, chat: Function, fork: Function}} A new chat session with cloned messages.
                 */
                fork: function(this: MlHistory): MlHistory {
                    const copy = ml.createChat({ model: this.model, extend: this.extend, numCtx: this.numCtx, numGpu: this.numGpu, think: this.think, schema: this.schema, toolIds: this.toolIds, maxTokens: this.maxTokens, save: this.save });
                    copy.messages = structuredClone(this.messages);
                    return copy;
                }
            };
            sessionRegistry.set(history.hash, history);   // same-tab resume by hash
            return history;
        },
        /**
         * Resume a chat by its session hash (shown/copied in the debug sidebar).
         * Same-tab sessions resume from an in-memory registry; across reloads or
         * tabs only `{ save: true }` sessions survive (persisted to storage via
         * the background). Returns a history you can `.chat()` on to continue it.
         *
         * @param {string} hash The session hash.
         * @returns {Promise<Object>} A chat history continuing that conversation.
         * @throws {Error} If no resumable session exists for the hash.
         */
        resumeChat: async function(hash: string): Promise<MlHistory> {
            if (!hash || typeof hash !== "string") throw new Error("ml.resumeChat needs a session hash string.");
            const live = sessionRegistry.get(hash);
            if (live) return live;   // this tab → the same object, continue it
            const stored = await makeBackgroundTaskPromise<StoredSession | null>("GET_SESSION_REQUEST", "GET_SESSION_RESPONSE", { hash });
            if (!stored) throw new Error(
                `No resumable session "${hash}". Session-local chats live only in the tab that made them; ` +
                `pass { save: true } to ml.createChat for a chat that survives reloads/tabs.`
            );
            const h = this.createChat({
                model: stored.model, extend: stored.extend, numCtx: stored.numCtx, numGpu: stored.numGpu,
                think: stored.think, schema: stored.schema, toolIds: stored.toolIds, maxTokens: stored.maxTokens, save: stored.save,
            });
            h.messages = stored.messages || [];
            h.hash = hash;                  // keep the original hash (createChat minted a fresh one)
            sessionRegistry.set(hash, h);   // register the rehydrated session under its real hash
            return h;
        },
        /**
         * One-shot chat — a throwaway single-turn history.
         * Options: { system, think, images, model, schema, toolIds, maxTokens, save, onToken } as in createChat.
         *
         * @param {string} prompt The user prompt.
         * @param {Object} [options] Chat options (same as createChat).
         * @returns {Promise<string|Object>} The model's reply.
         */
        chat: async function(prompt: string, options: ChatOptions = {}): Promise<string | unknown> {
            return this.createChat(options).chat(prompt, options);
        },
        /**
         * Low-level single model turn WITH client-side tools.
         * Returns the raw assistant message { content, tool_calls: [{ id, name, arguments }] } and
         * hands control back to you: execute the calls, append the results as
         * { role: "tool", tool_call_id, content }, and call ml.step again to
         * continue. You own the loop (whitelist, limits, overseer — all yours).
         * Works on both OpenWebUI and plain Ollama (wire differences normalized).
         *
         * @param {Array<{role: string, content: string, tool_call_id?: string}>} messages The conversation messages.
         * @param {Object} [options] Options object.
         * @param {Array} [options.tools=[]] Client-side tool definitions.
         * @param {string} [options.model=null] Model override.
         * @param {boolean} [options.think=null] Thinking flag; null omits it.
         * @returns {Promise<{content: string, tool_calls: Array<{id?: string, name: string, arguments: Object}>}>} The assistant message with tool calls.
         */
        step: async function(messages: NeutralMessage[], { tools = [], model = null, think = null }: {
            tools?: unknown[];
            model?: string | null;
            think?: boolean | null;
        } = {}): Promise<{ content: string; tool_calls: ToolCall[] }> {
            return makeBackgroundTaskPromise(
                "LLM_REQUEST",
                "LLM_RESPONSE",
                { "messages": messages, "tools": tools, "model": model, "think": think, "raw": true }
            );
        },
        /**
         * @typedef {Object} MlTool An agent tool the model can call.
         * @property {string} name The name the model calls.
         * @property {string} [description] What it does, shown to the model.
         * @property {Object} [parameters] JSON Schema for the arguments object.
         * @property {(args: Object) => (string|{content: string, elements?: Node[]}|Promise<string|{content: string, elements?: Node[]}>)} run
         *   Executes in the page context. Returns a short string for the model, or
         *   `{ content, elements }` to also route real DOM nodes to the loop's
         *   onStep/transcript (for hovering in devtools) — `elements` never reaches
         *   the model.
         * @property {boolean} [requiresApproval] When true, {@link module:ml.agent}
         *   pauses and calls its approval gate before every model-driven call —
         *   set it on anything with side effects or arbitrary power (e.g. `exec`).
         * @property {string[]} [capabilities] Role tags the agent adapts to, e.g.
         *   `["vision"]` (this tool lets the model see) or `["answer"]` (this tool
         *   designates result element(s), surfaced on `result.elements`).
         */

        /**
         * Build one agent tool: a JSON-schema function signature the model sees,
         * paired with a `run(args)` that executes in the page. Compose an array of
         * these and hand it to {@link module:ml.agent} — `ml.domTools` is just the
         * default array, so adding a tool is pushing another object (the "bash
         * tools" surface).
         *
         * @param {MlTool} tool
         * @returns {MlTool} The tool with defaults filled in.
         * @throws {Error} If `name` or a `run` function is missing.
         */
        defineTool: function({ name, description = "", parameters = { type: "object", properties: {} }, run, requiresApproval = false, capabilities = [], render }: Partial<MlTool> = {}): MlTool {
            if (!name || typeof run !== "function") {
                throw new Error("ml.defineTool needs a name and a run(args) function");
            }
            return { name, description, parameters, run, requiresApproval, capabilities, render };
        },
        /**
         * Run a full agent loop over a tool registry: the model calls tools, we
         * execute them in the page, feed the results back, and repeat until it
         * stops calling tools (returns a summary) or hits `maxSteps`. The loop, the
         * tool whitelist, the step cap and the approval gate all live here on the
         * caller side — window.ml stays a primitive you compose.
         *
         * @param {string} task Natural-language task for the agent.
         * @param {Object} [opts]
         * @param {MlTool[]} [opts.tools] Tool registry (default {@link module:ml.domTools}).
         * @param {MlTool[]} [opts.extraTools=[]] Extra tools appended to `tools`.
         * @param {string} [opts.system] System prompt (default the generic strategy preamble).
         * @param {string} [opts.hints] Task-specific notes APPENDED to the system prompt
         *   (keeps the built-in workflow + tool clauses — unlike `system`, which
         *   REPLACES them). Put site/task facts here for a minimal setup.
         * @param {number} [opts.maxSteps=10] Hard cap on tool-executing turns.
         * @param {string} [opts.model] Model override, forwarded to each {@link module:ml.step}.
         * @param {boolean} [opts.think] Thinking flag, forwarded to each {@link module:ml.step}.
         * @param {(req: {tool: string, arguments: Object}) => (boolean|{approved: boolean, feedback?: string, arguments?: Object}|Promise<boolean|{approved: boolean, feedback?: string, arguments?: Object}>)} [opts.approve]
         *   Gate called before each model-driven call to a `requiresApproval` tool;
         *   defaults to a blocking `confirm()`. Return a boolean, or the richer
         *   contract `{ approved, feedback?, arguments? }`: on a rejection, `feedback`
         *   is fed to the model as the reason (instead of the fixed "Denied" note);
         *   on approval, `arguments` (when given) REPLACES the model's arguments
         *   before the tool runs — so a UI can edit an `exec` script before it fires.
         *   A denial (either form) is always fed back to the model.
         * @param {boolean} [opts.env=true] Prepend a "current page context" note
         *   (URL, title, language, date/time, locale) to the system prompt, so the
         *   model is oriented and knows what "today"/the locale is. Set false to skip.
         * @param {boolean|string} [opts.vision=null] Auto-register a `look` (vision)
         *   tool so the agent can see with no wiring. Default (`null`) probes the
         *   agent's model — and falls back to the configured OCR model — and adds
         *   `look` only when one is vision-capable (a positive Ollama capability;
         *   unknown/cloud models never qualify). Pass `false` to disable, or a model
         *   id to force `look` onto that specific vision model. Skipped when the
         *   toolset already contains a vision-capable tool.
         * @param {(ev: {step: number, thought?: string, tool?: string, arguments?: Object, result?: string, elements?: Node[]}) => void} [opts.onStep]
         *   Live tracer: fires `{ step, thought }` with the model's reasoning
         *   (its prose before the calls) and `{ step, tool, arguments, result,
         *   elements? }` for each tool call —
         *   `elements` holds real DOM nodes when the tool provided them (log them to
         *   hover in devtools).
         * @param {boolean} [opts.logDebug=false] Install a built-in console tracer
         *   ({@link module:ml._logStep}) that logs each thought and tool call —
         *   the quickest way to watch a run. Composes with `onStep` (both fire).
         * @returns {Promise<{summary: string, steps: number, transcript: Array<{thought?: string, tool?: string, arguments?: Object, result?: string, elements?: Node[]}>, elements: Node[], hitCap?: boolean}>}
         *   `elements` is the live DOM node(s) the model designated via an
         *   `answer`-capable tool (empty for tasks that just act on the page).
         */
        agent: async function(task: string, { tools = null, extraTools = [], system = null, hints = null, maxSteps = 10, model = null, think = null, approve = defaultApprove, onStep = null, env = true, vision = null, logDebug = false }: {
            tools?: MlTool[] | null;
            extraTools?: MlTool[];
            system?: string | null;
            hints?: string | null;
            maxSteps?: number;
            model?: string | null;
            think?: boolean | null;
            approve?: (req: ApprovalRequest) => boolean | ApprovalDecision | Promise<boolean | ApprovalDecision>;
            onStep?: ((ev: { step: number; thought?: string; tool?: string; arguments?: Record<string, unknown>; result?: string; elements?: Node[] }) => void) | null;
            env?: boolean;
            vision?: boolean | string | null;
            logDebug?: boolean;
        } = {}): Promise<AgentResult> {
            const toolset = [...(tools || this.domTools || []), ...extraTools];
            // Config, fetched once (used for vision resolution + the read-only exec
            // auto-approve fast-path below).
            const agentCfg = await this.config().catch(() => null);
            const autoRO = !!(agentCfg && (agentCfg as { autoApproveReadonly?: boolean }).autoApproveReadonly);
            // #8 + #3: give the agent eyes with no wiring, preferring NATIVE vision.
            // If the agent's OWN model is vision-capable, register a capture-only
            // `look` whose screenshot ml.agent injects straight into the model's
            // history (#3 inline vision), so it reasons over the real pixels instead
            // of a lossy delegated text summary — the failure mode where a model
            // "stumbles around" on an easy task. If only the OCR model can see, fall
            // back to the delegated `lookTool` (#8). A forced `vision:"<model>"` is
            // always delegated (can't inline a model that isn't the agent's).
            if (vision !== false && !toolset.some(t => t.capabilities && t.capabilities.includes("vision"))) {
                if (typeof vision === "string" && vision) {
                    toolset.push(this.lookTool({ model: vision }));
                } else {
                    const agentModel = model || agentCfg?.model || null;
                    if (await this._modelSees(agentModel)) {
                        toolset.push(this._nativeLookTool());
                    } else {
                        const visionModel = await this._resolveVisionModel(model, vision);
                        if (visionModel) toolset.push(this.lookTool({ model: visionModel }));
                    }
                }
            }
            const byName = Object.fromEntries(toolset.map(t => [t.name, t]));
            const toolDefs = toolset.map(t => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters }
            }));
            const hasCap = (cap: "vision" | "answer") => toolset.some(t => t.capabilities && t.capabilities.includes(cap));
            let systemPrompt = system || AGENT_SYSTEM;
            if (!system) {
                // Adapt the default prompt to what the toolset can actually do.
                if (hasCap("vision")) systemPrompt += VISION_CLAUSE;
                if (hasCap("answer")) systemPrompt += ANSWER_CLAUSE;
                if (toolset.some(t => t.name === "wait")) systemPrompt += WAIT_CLAUSE;
            }
            if (hints) systemPrompt += `\n\nTask-specific notes:\n${hints}`;
            if (env) {
                const ctx = pageContext();
                if (ctx) systemPrompt += `\n\nCurrent page context:\n${ctx}`;
            }
            const messages: NeutralMessage[] = [
                { role: "system", content: systemPrompt },
                { role: "user", content: task }
            ];
            const transcript: AgentTranscriptEntry[] = [];
            const answered: Node[] = [];   // element(s) designated via an `answer`-capable tool
            // Debug sidebar: announce the run + each step. Its own session hash
            // (an agent run isn't a createChat). elements can't cross the window
            // bus — send a count; real nodes still reach onStep/the console.
            const runHash = shortHash();
            emitDebug({ kind: "agent", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: 0 }, task, model: model || null, maxSteps, config: {
                system: systemPrompt, customSystem: !!system,
                tools: toolset.map(t => ({ name: t.name, requiresApproval: !!t.requiresApproval })),
                maxSteps, think: (think === true || think === false) ? think : null, env, vision: vision ?? null, hints: hints || null,
            } });
            const emit = (event: { step: number; thought?: string; tool?: string; arguments?: Record<string, unknown>; result?: string; elements?: Node[]; render?: RenderDescriptor; argIssues?: string[]; approval?: "readonly" | "user" | "denied" }) => {
                if (logDebug) logStep(event);
                emitDebug({
                    kind: "agent-step", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: event.step },
                    step: event.step, thought: event.thought, tool: event.tool, arguments: event.arguments,
                    result: event.result, elements: event.elements ? event.elements.length : undefined, render: event.render,
                    argIssues: event.argIssues && event.argIssues.length ? event.argIssues : undefined,
                    approval: event.approval,
                });
                if (!onStep) return;
                try { onStep(event); } catch (e) { console.error("ml.agent onStep threw:", e); }
            };
            // A serializable render descriptor for a tool step: the tool's own
            // `render` (page-side, defensive) wins; else auto-derive image/elements
            // from the envelope; else undefined → the sidebar's default In:/Out:.
            const descriptorFor = (tool: MlTool | undefined, input: ToolRenderInput, args: Record<string, unknown>): RenderDescriptor | undefined => {
                if (tool?.render) {
                    try { const d = tool.render(input, args); if (d && d.type) return d; }
                    catch (e) { console.error(`ml tool "${tool.name}" render threw:`, e); }
                }
                if (input.image) return { type: "image", src: input.image, label: input.imageLabel };
                if (input.elements?.length) return {
                    type: "elements",
                    items: input.elements.slice(0, 50).map((el: Node, i: number) => ({
                        path: (typeof Element !== "undefined" && el instanceof Element) ? elPath(el) : String(el.nodeName || "node"),
                        text: truncate((el as Element).textContent || "", 60), index: i,
                    })),
                };
                return undefined;
            };
            const finish = (r: AgentResult): AgentResult => {
                emitDebug({ kind: "agent-result", id: runHash, ts: Date.now(), save: false, session: { hash: runHash, turn: r.steps }, summary: r.summary, steps: r.steps, hitCap: !!r.hitCap });
                return r;
            };
            inAgentRun++;   // suppress orphan chat sessions from internal tool chats (see emitDebug); finally-decremented below
            try {
            for (let step = 1; step <= maxSteps; step++) {
                const msg = await this.step(messages, { tools: toolDefs, model, think });
                if (!msg.tool_calls || !msg.tool_calls.length) {
                    return finish({ summary: (msg.content || "").trim(), steps: step - 1, transcript, elements: answered });
                }
                // Surface the model's reasoning (its prose before the tool calls)
                // so callers can watch it think, not just navigate.
                const thought = (msg.content || "").trim();
                if (thought) {
                    transcript.push({ thought });
                    emit({ step, thought });
                }
                messages.push({ role: "assistant" as const, content: msg.content || "", tool_calls: msg.tool_calls });

                // Run a tool, unwrapping its { content, elements } envelope. A tool
                // may return a plain string, or { content, elements } to also hand
                // back real DOM nodes — routed to onStep/the transcript for hovering
                // in devtools, never to the model.
                const runTool = async (tool: MlTool, args: Record<string, unknown>) => {
                    try {
                        const raw = await tool.run(args);
                        // A tool may also hand back { image, imageLabel } — a screenshot
                        // for #3 inline vision, injected into the model's own history.
                        if (raw && typeof raw === "object" && typeof raw.content === "string") {
                            return { result: raw.content, elements: raw.elements, image: raw.image, imageLabel: raw.imageLabel };
                        }
                        return { result: raw };
                    } catch (e) { return { result: `Error: ${errText(e)}` }; }
                };

                const pendingImages = [];   // #3: screenshots captured this turn, injected below
                for (const call of msg.tool_calls) {
                    const tool = byName[call.name];
                    let args = (call.arguments || {}) as Record<string, unknown>;
                    let result, elements, image, imageLabel;
                    let approval: "readonly" | "user" | "denied" | undefined;
                    if (!tool) {
                        result = `Error: no tool named "${call.name}".`;
                    } else if (tool.requiresApproval) {
                        // Experimental fast-path: a read-only `exec` survey runs via the
                        // mediated mini-interpreter with NO approval (and no eval → clears
                        // Trusted Types). The interpreter is side-effect-free, so simply
                        // *trying* it is safe: any NotInDialect/Denied throw means nothing
                        // observable happened, and we fall through to the normal gate.
                        let handled = false;
                        if (autoRO && tool.name === "exec" && typeof (args as { js?: unknown }).js === "string") {
                            try {
                                const ro = evalReadonly((args as { js: string }).js, document);
                                ({ result, elements } = formatReadonlyExec(ro.value, ro.logs));
                                handled = true;
                                approval = "readonly";
                            } catch { /* outside the dialect / blocked → normal approval path */ }
                        }
                        if (!handled) {
                            // Approval gate. `approve` may return a boolean or the rich
                            // contract { approved, feedback?, arguments? } — a rejection
                            // can hand the model a comment, an approval can edit the args.
                            const decision = normalizeApproval(await approve({ tool: call.name, arguments: args }), args);
                            if (!decision.approved) {
                                approval = "denied";
                                result = decision.feedback
                                    ? `Denied by the user: ${decision.feedback}\nDo not retry this exact call unchanged; address the feedback or try another approach.`
                                    : "Denied by the user. Do not retry this exact call; try another approach.";
                            } else {
                                approval = "user";
                                args = decision.arguments;   // possibly caller-edited before running
                                ({ result, elements, image, imageLabel } = await runTool(tool, args));
                            }
                        }
                    } else {
                        ({ result, elements, image, imageLabel } = await runTool(tool, args));
                    }
                    result = String(result);
                    const entry: AgentTranscriptEntry = { tool: call.name, arguments: args, result };
                    if (elements && elements.length) entry.elements = elements;
                    transcript.push(entry);
                    const render = descriptorFor(tool, { result, elements, image, imageLabel }, args);
                    const argIssues = tool ? validateArgs(tool.parameters, args) : undefined;
                    emit({ step, ...entry, render, argIssues, approval });
                    // An answer-capable tool designates the caller-facing result node(s).
                    if (tool && tool.capabilities && tool.capabilities.includes("answer") && elements && elements.length) {
                        answered.push(...elements);
                    }
                    messages.push({ role: "tool" as const, tool_call_id: call.id, content: result });
                    if (image) pendingImages.push({ image, label: imageLabel || "screenshot" });
                }

                // #3 inline vision: hand any screenshots captured this turn to the
                // agent's OWN (vision-capable) model as a user turn, so the next step
                // reasons over the real pixels. v1 is the "dumb" way — the image stays
                // in history (no purge), so context grows with each look; that's the
                // known tradeoff (see roadmap #3). Tool RESULTS can't carry images, a
                // user turn can — buildMessage already renders images per format.
                if (pendingImages.length) {
                    const labels = pendingImages.map(p => p.label).join(", ");
                    messages.push({
                        role: "user" as const,
                        content: `Screenshot${pendingImages.length > 1 ? "s" : ""} you requested (${labels}). ` +
                            "Describe what you see, then take the next action — or give your final answer if the task is done.",
                        images: pendingImages.map(p => p.image)
                    });
                }
            }
            return finish({ summary: `Stopped at the ${maxSteps}-step cap without finishing.`, steps: maxSteps, transcript, elements: answered, hitCap: true });
            } finally { inAgentRun--; }
        },
        /**
         * A de-duplicating approval gate for {@link module:ml.agent}: prompts (via
         * confirm) the first time it sees a given call and remembers that answer per
         * **(tool + exact arguments)**. So an identical repeat isn't re-asked, but a
         * DIFFERENT call is — crucially, each distinct `exec` script must be approved
         * on its own (blanket-approving arbitrary eval would defeat the gate).
         * Denials are remembered too and fed back to the model. Pass it as `approve`:
         *   ml.agent(task, { approve: ml.approveOnce() })
         * @returns {(req: {tool: string, arguments: Object}) => boolean}
         */
        approveOnce: function(): (req: ApprovalRequest) => boolean {
            const remembered: Record<string, boolean> = {};   // (tool + args) key -> remembered decision
            return ({ tool, arguments: args }: ApprovalRequest): boolean => {
                let key;
                try { key = tool + " " + JSON.stringify(args); }
                catch { key = tool + " " + String(args); }
                if (!(key in remembered)) {
                    remembered[key] = (typeof window.confirm === "function") && window.confirm(
                        `${suspiciousArgsWarning(args)}window.ml agent wants to run "${tool}":\n\n${renderArgs(args)}\n\n` +
                        `Allow this call? (an identical repeat won't ask again)`
                    );
                }
                return remembered[key];
            };
        },
        /**
         * One-shot chat with a "short and concise" modifier.
         *
         * @param {string} prompt The user prompt.
         * @param {Object} [options] Chat options.
         * @returns {Promise<string>} The model's concise reply.
         */
        chatShort: async function(prompt: string, options: ChatOptions): Promise<string> {
            return (await this.chat(`${prompt}. Short and concise:`, options)) as string;
        },
        // OCR: transcribe baked-in text from an image to a plain string, using
        // the dedicated OCR (vision) model — so the reasoning model never sees
        // image tokens. Composes with chat:
        //   await ml.chat("Summarize: " + await ml.read($0))
        /**
         * OCR: transcribe baked-in text from an image to a plain string, using
         * the dedicated OCR (vision) model — so the reasoning model never sees
         * image tokens. Composes with chat:
         *   await ml.chat("Summarize: " + await ml.read($0))
         *   await Promise.all(imgs.map(i => ml.read(i)))
         *
         * @param {string|HTMLImageElement} image An <img> element or URL string.
         * @param {Object} [options] Options object.
         * @param {string} [options.model=null] Per-call override of the configured OCR model.
         * @param {string} [options.prompt=null] Override the default transcription prompt.
         * @returns {Promise<string>} The transcribed text.
         */
        read: async function(image: string | HTMLImageElement, { model = null, prompt = null }: { model?: string | null; prompt?: string | null } = {}): Promise<string> {
            const dataUrl = await this._imageToDataUrl(image);
            const instruction = prompt ||
                "Transcribe all text in this image exactly as it appears, " +
                "preserving reading order. Output only the transcribed text — " +
                "no commentary, no descriptions, no markdown.";
            const reply = await makeBackgroundTaskPromise<string>(
                "LLM_REQUEST",
                "LLM_RESPONSE",
                {
                    "messages": [{ role: "user", content: instruction, images: [dataUrl] }],
                    "think": null,
                    "model": model,
                    "ocr": true
                }
            );
            return reply.trim();
        },
        /**
         * Screenshot to a PNG data URL. With no target, captures the whole visible
         * viewport (use it to ORIENT — see the page like you would in devtools).
         * With a target, scrolls it into view and crops to its rect. Feed either
         * to a vision model:
         *
         * ```js
         *   await ml.chat("What does this show?", { images: [await ml.screenshot("#card")] })
         *   await ml.chat("What page is this?", { images: [await ml.screenshot()] })
         *```
         *
         * @param {string|Element|null} [target=null] A CSS selector, an Element, or null for the whole viewport.
         * @param {Object} [options] Options object.
         * @param {boolean} [options.scroll=true] Set false to skip scroll-into-view.
         * @param {boolean} [options.fullPage=false] Set true to capture the full page (stitched).
         * @param {number} [options.index=0] Which match of a selector to shoot (0-based).
         * @returns {Promise<string>} The screenshot as a PNG data URL.
         */
        screenshot: async function(target: string | Element | null = null, { scroll = true, fullPage = false, index = 0 }: { scroll?: boolean; fullPage?: boolean; index?: number } = {}): Promise<string> {
            // Hide the debug sidebar overlay (if mounted) for the shot, so it isn't
            // captured into the agent's `look`; restore after. No wait when the
            // sidebar is off (no #ml-sb-root) — it's a no-op then.
            const viewport = async (): Promise<string> => {
                await hideSidebarForShot();
                try { return await makeBackgroundTaskPromise<string>("CAPTURE_TAB_REQUEST", "CAPTURE_TAB_RESPONSE", {}); }
                finally { window.postMessage({ __mlSidebarShot: "show" }, "*"); }
            };
            if (target == null) return fullPage ? this._stitchFullPage(viewport) : viewport();

            let el = target;
            if (typeof target === "string") {
                el = queryAll(target)[index];   // Nth match (queryAll adds :contains support)
                if (!el) throw new Error(`No element matches "${target}"${index ? ` at index ${index}` : ""}.`);
            }
            if (!(el instanceof Element)) throw new Error("ml.screenshot needs a CSS selector, an Element, or nothing.");
            if (scroll) {
                el.scrollIntoView({ block: "center", inline: "center" });
                // Let the scroll paint before we capture.
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            }
            const rect = el.getBoundingClientRect();
            // A zero- or sliver-sized element (e.g. a 1px-tall spacer/rule, or a
            // collapsed container) crops to a degenerate 1px-by-N image the vision
            // model just hallucinates over. Reject it with an actionable message
            // rather than sending the sliver off (roadmap #10).
            if (rect.width < MIN_SHOT_PX || rect.height < MIN_SHOT_PX) {
                throw new Error(
                    `element is ${Math.round(rect.width)}×${Math.round(rect.height)}px — too small to ` +
                    `screenshot (hidden, collapsed, or a 1px spacer?). Target a parent container with real size.`
                );
            }
            return cropDataUrl(await viewport(), rect, window.devicePixelRatio || 1);
        },
        /**
         * Scroll the page in viewport-height steps, capture each, and stitch them
         * vertically into one tall PNG data URL. Browser-only (canvas). Paces
         * captures to respect captureVisibleTab's 2/sec limit, with backoff retries.
         *
         * @param {Function} capture The capture function that returns a viewport screenshot.
         * @returns {Promise<string>} The stitched full-page screenshot as a PNG data URL.
         */
        _stitchFullPage: async function(capture: () => Promise<string>): Promise<string> {
            const dpr = window.devicePixelRatio || 1;
            const vh = window.innerHeight;
            // Cap at ~8 screens so the image stays sane
            const total = Math.min(document.documentElement.scrollHeight, vh * 8);
            const startY = window.scrollY;
            const shots: { y: number; url: string }[] = [];

            for (let y = 0; y < total; y += vh) {
                window.scrollTo(0, y);
                // Wait for the browser to actually paint the new scroll position
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

                let url: string | null = null;
                let retries = 3;

                while (retries > 0 && !url) {
                    try {
                        // 600ms ensures we strictly stay under the 2 calls/sec limit
                        await new Promise(r => setTimeout(r, 600));
                        url = await capture();
                    } catch (e) {
                        // If we still hit the quota, back off for a full second and retry
                        if ((e as Error).message && (e as Error).message.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) {
                            console.warn(`Hit Chrome capture limit at scroll ${y}, backing off...`);
                            await new Promise(r => setTimeout(r, 1000));
                            retries--;
                        } else {
                            throw e; // Unrelated error, fail fast
                        }
                    }
                }

                if (!url) throw new Error("Failed to capture after retries due to quota limits.");
                shots.push({ y, url });
            }
            window.scrollTo(0, startY);

            return new Promise((resolve, reject) => {
                if (!shots.length) return reject(new Error("nothing captured"));
                const imgs: HTMLImageElement[] = [];
                let loaded = 0;
                const done = () => {
                    const canvas = document.createElement("canvas");
                    canvas.width = imgs[0].naturalWidth;
                    canvas.height = Math.round(total * dpr);
                    const ctx = canvas.getContext("2d")!;
                    shots.forEach((s, i) => ctx.drawImage(imgs[i], 0, Math.round(s.y * dpr)));
                    resolve(canvas.toDataURL("image/png"));
                };
                shots.forEach((s, i) => {
                    const img = new Image();
                    img.onload = () => { imgs[i] = img; if (++loaded === shots.length) done(); };
                    img.onerror = () => reject(new Error("failed to load a capture"));
                    img.src = s.url;
                });
            });
        },
        /**
         * Build a "look" agent tool: it screenshots an element and returns a
         * vision-model *description* as text, so a text-only reasoning agent can
         * still "see" (icons, badges, greyed-out/sponsored styling, layout). Not
         * in ml.domTools by default because it needs a vision model and a capture
         * round-trip — opt in by composing it:
         *
         * ```js
         *   ml.agent(task, { extraTools: [ml.lookTool({ model: "qwen2.5vl" })] })
         *```
         *
         * @param {Object} [options] Options object.
         * @param {string} [options.model=null] Vision model for the description (null = the saved default).
         * @param {number} [options.maxTokens=512] Hard cap on the description length.
         * @returns {MlTool} A tool with `name: "look"` and `capabilities: ["vision"]`.
         */
        lookTool: function({ model = null, maxTokens = 512 }: { model?: string | null; maxTokens?: number } = {}): MlTool {
            const ml = this;
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
        },
        /**
         * Build a "click" interaction tool: click a link/button/tab/result.
         * Navigation, form submit, expand/collapse — irreversible, hence gated.
         * Interaction tools that DRIVE the page (real side effects), so they are
         * `requiresApproval` and deliberately NOT in the default read-only domTools —
         * opt in per task, gated by the approval flow:
         *
         * ```js
         *   ml.agent(task, { extraTools: [ml.clickTool(), ml.typeTool()] })
         * ```
         *
         * @returns {MlTool} A tool with `name: "click"` and `requiresApproval: true`.
         */
        clickTool: function(): MlTool {
            const ml = this;
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
        },
        /**
         * Build a "type" interaction tool: type text into an input/textarea/contenteditable (e.g. a search
         * box), firing input/change so the page's JS reacts. Side-effecting (it can
         * trigger live search / autosave), so gated + opt-in like click. `submit`
         * presses Enter afterwards, so "search for X" is one call without eval.
         *
         * @returns {MlTool} A tool with `name: "type"` and `requiresApproval: true`.
         */
        typeTool: function(): MlTool {
            const ml = this;
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
        },
        /**
         * Pick a vision model for the auto-registered `look` tool (see ml.agent's `vision` option).
         * Returns a model id the agent can see with, or null. `agentModel` is the agent's own model
         * (opts.model, or null = the saved default). A string `vision` forces that model; otherwise
         * probe the agent's model, then the configured OCR model, accepting only a POSITIVE Ollama
         * vision capability — unknown/null (cloud/non-Ollama) must NOT qualify, or we'd send image
         * tokens to a text-only model. The caps probe is cached per service-worker lifetime in the
         * background worker.
         *
         * @param {string|null} agentModel The agent's model (or null for default).
         * @param {string|boolean|null} [vision] Vision option from ml.agent options.
         * @returns {Promise<string|null>} A vision-capable model id, or null.
         */
        _resolveVisionModel: async function(agentModel: string | null, vision: boolean | string | null): Promise<string | null> {
            if (typeof vision === "string" && vision) return vision;   // forced
            let cfg: MlPublicConfig | null;
            try { cfg = await this.config(); } catch (e) { cfg = null; }
            const primary = agentModel || (cfg && cfg.model);
            if (await this._modelSees(primary)) return primary;
            const ocr = cfg && cfg.ocrModel;
            if (ocr && ocr !== primary && await this._modelSees(ocr)) return ocr;
            return null;
        },
        /**
         * True only when `model` POSITIVELY reports vision capability.
         * Unknown/null (cloud, non-Ollama, unreachable) is false — never send image
         * tokens to a model we can't confirm sees. Caps are cached in the worker.
         *
         * @param {string|null} model The model id to check.
         * @returns {Promise<boolean>} True if the model has vision capability.
         */
        _modelSees: async function(model: string | null): Promise<boolean> {
            if (!model) return false;
            let caps: string[] | null;
            try { caps = await this.capabilities(model); } catch (e) { return false; }
            return Array.isArray(caps) && caps.includes("vision");
        },
        /**
         * Build a capture-only `look` tool for a vision-capable AGENT model.
         * It screenshots and hands the raw image back to ml.agent, which injects it
         * into the model's OWN history so it reasons over the real pixels (vs the
         * delegated lookTool, which returns a second model's text description).
         *
         * @returns {MlTool} A tool with `name: "look"`, `capabilities: ["vision"]`, returning
         *   `{ content, image, imageLabel, elements }` for inline vision.
         */
        _nativeLookTool: function(): MlTool {
            const ml = this;
            return ml.defineTool({
                name: "look",
                capabilities: ["vision"],
                description: "See the page with your OWN eyes — this screenshots the page (or an element) " +
                    "and shows YOU the image directly. Call with NO selector to see the viewport and ORIENT " +
                    "when a task is vague; pass a selector to inspect one element (icons, badges, whether " +
                    "something looks sponsored / greyed-out / out of stock); pass scope:'page' (no selector) " +
                    "to see the whole page stitched into one tall image (DOWNSCALED — use it for layout, not " +
                    "small text). To CLASSIFY items in a grid/list (which show a cat?), pass the item selector " +
                    "and iterate `index` (0,1,2,…) for a tight crop of each. After looking, DESCRIBE what you " +
                    "see, then take the next action.",
                parameters: {
                    type: "object",
                    properties: {
                        selector: { type: "string", description: "CSS selector of an element; omit to see the page." },
                        scope: { type: "string", enum: ["viewport", "page"], description: "'viewport' (default), or 'page' to scroll+stitch the full page (only when no selector)." },
                        index: { type: "integer", description: "Which match of the selector to look at (0-based); iterate a grid with 0,1,2,…" }
                    }
                },
                run: async ({ selector, scope, index }: { selector?: string; scope?: "viewport" | "page"; index?: number } = {}): Promise<string | ToolResult> => {
                    const fullPage = scope === "page" && !selector;
                    let shot;
                    try { shot = await ml.screenshot(selector || null, { fullPage, index: index || 0 }); }
                    catch (e) { return `Error: ${errText(e)}`; }
                    const label = selector
                        ? `element "${selector}"${index ? ` #${index}` : ""}`
                        : (fullPage ? "full page" : "viewport");
                    // Hand the screenshotted element back on the elements side-channel
                    // so it's hoverable in `logDebug`/`onStep` (never sent to the model).
                    // Guarded: a bad/stub-DOM selector just yields no node.
                    let elements;
                    if (selector) { try { const el = queryAll(selector)[index || 0]; if (el) elements = [el]; } catch {} }
                    return {
                        content: `Screenshot of the ${label} captured — shown to you in the next message. Describe it, then continue.`,
                        image: shot,
                        imageLabel: label,
                        elements
                    };
                }
            });
        },
        // The built-in ml.agent({ logDebug: true }) tracer; pass as onStep too.
        _logStep: logStep,
        // Internal DOM helpers used by the agent tools, exposed under `_` (as
        // with _parseJSON below) so tests and console debugging can reach them.
        _truncate: truncate,
        _suspiciousChars: suspiciousChars,
        _elPath: elPath,
        _describeSkeleton: describeSkeleton,
        _queryAll: queryAll,
        // Parses a structured-output reply, tolerating a stray ```json fence
        // and surfacing the raw text on failure for debugging.
        /**
         * Parse a structured-output reply, tolerating a stray ```json fence
         * and surfacing the raw text on failure for debugging.
         *
         * @param {string} text The JSON text to parse.
         * @returns {Object} The parsed JSON object.
         * @throws {Error} If the text is not valid JSON.
         */
        _parseJSON: function(text: string): unknown {
            const stripped = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
            try {
                return JSON.parse(stripped);
            } catch (err) {
                throw new Error(
                    `schema was set but the reply wasn't valid JSON (${(err as Error).message}). ` +
                    `Got: ${text.slice(0, 200)}`
                );
            }
        },
        /**
         * Convert an image to a data URL.
         * Accepts a URL string or <img> element, returns "data:image/...;base64,...".
         * Handles data URIs (passed through), blob URIs (read via FileReader),
         * and external URLs (delegated to background for CORS).
         *
         * @param {string|HTMLImageElement} image A URL string or <img> element.
         * @returns {Promise<string>} The image as a data URL.
         */
        _imageToDataUrl: async function(image: string | HTMLImageElement): Promise<string> {
            let url = "";

            if (typeof image === "string") {
                url = image;
            } else if (image instanceof HTMLImageElement) {
                url = image.currentSrc || image.src;
            } else {
                throw new Error("Image must be a URL string or <img> element!");
            }

            // Case A: Data URI (Already Base64)
            // e.g. "data:image/png;base64,iVBOR..."
            if (url.startsWith("data:")) {
                return url;
            }

            // Case B: Blob URI (Local Memory)
            // e.g. "blob:https://example.com/..."
            // The Background Script CANNOT fetch these (they exist only in the Tab).
            // We must fetch them here in the Main World.
            if (url.startsWith("blob:")) {
                return new Promise((resolve, reject) => {
                    fetch(url)
                        .then(r => r.blob())
                        .then(blob => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result as string);
                            reader.readAsDataURL(blob);
                        })
                        .catch(e => reject("Failed to read Blob: " + (e as Error).message));
                });
            }

            // Case C: Standard HTTP/HTTPS (External Images)
            // The Page Context will likely fail (CORS).
            // The Background Script will SUCCEED (Extension Permissions).
            // We delegate the fetch to the background.
            return this._fetchImageBase64(url);
        },
        /**
         * Fetch an external image as base64 via the background worker (for CORS).
         *
         * @param {string} url The image URL to fetch.
         * @returns {Promise<string>} The image as a base64 data URL.
         */
        _fetchImageBase64: async function(url: string): Promise<string> {
            return makeBackgroundTaskPromise(
                "B64_REQUEST",
                "B64_RESPONSE",
                { "url": url }
            );
        },
        /**
         * Get available model ids on the server.
         *
         * @returns {Promise<string[]>} Array of model ids.
         */
        models: async function(): Promise<string[]> {
            return makeBackgroundTaskPromise("LIST_MODELS_REQUEST", "LIST_MODELS_RESPONSE", {});
        },
        /**
         * Get capability list for a model, read from Ollama's /api/show.
         * Returns e.g. ["completion", "tools", "vision", "thinking"]. Handy for feature
         * gating (e.g. only offer server-side tools on a tool-capable model).
         * Returns null when it can't be determined (cloud/non-Ollama model, old
         * Ollama, unreachable) — treat null as "unknown", never as "no".
         *
         * @param {string} [model=null] The model id (omitted = saved default).
         * @returns {Promise<string[]|null>} Array of capabilities, or null if undeterminable.
         */
        capabilities: async function(model: string | null = null): Promise<string[] | null> {
            return makeBackgroundTaskPromise("CAPS_REQUEST", "CAPS_RESPONSE", { "model": model });
        },
        /**
         * Get the saved default model.
         *
         * @returns {Promise<string|null>} The model id.
         */
        getModel: async function(): Promise<string | null> {
            return makeBackgroundTaskPromise("GET_MODEL_REQUEST", "GET_MODEL_RESPONSE", {});
        },
        /**
         * Get the non-secret saved config the page is allowed to read:
         * { model, ocrModel, apiFormat }. The server URL and API key are never
         * exposed to the page (see the security invariants in CLAUDE.md).
         * ml.agent uses this to auto-wire a vision tool from the OCR model.
         *
         * @returns {Promise<{model: string, ocrModel: string, apiFormat: string}>} The config object.
         */
        config: async function(): Promise<MlPublicConfig> {
            return makeBackgroundTaskPromise("CONFIG_REQUEST", "CONFIG_RESPONSE", {});
        },
        /**
         * Persistently switch the default model (validated against the server;
         * the settings popup picks it up automatically).
         *
         * @param {string} model The model id to set.
         * @returns {Promise<string>} The newly set model id.
         */
        setModel: async function(model: string): Promise<string> {
            return makeBackgroundTaskPromise("SET_MODEL_REQUEST", "SET_MODEL_RESPONSE", { "model": model });
        },
        /**
         * Get models currently loaded in VRAM.
         *
         * @returns {Promise<Array<{model: string, vramGB: number, expiresAt: number}>>} Array of loaded models.
         */
        ps: async function(): Promise<LoadedModel[]> {
            return makeBackgroundTaskPromise("PS_REQUEST", "PS_RESPONSE", {});
        },
        /**
         * Evict a model from VRAM (keep_alive: 0).
         * No argument = evict all. Returns the list of models that were told to unload.
         *
         * @param {string} [model] The model id to evict; omitted = evict all.
         * @returns {Promise<string[]>} The unloaded models.
         */
        unload: async function(model: string | null = null): Promise<string[]> {
            return makeBackgroundTaskPromise("UNLOAD_REQUEST", "UNLOAD_RESPONSE", { "model": model });
        },
        /**
         * Chat and log the response to the console.
         *
         * @param {string} prompt The user prompt.
         * @param {Object} [options] Chat options.
         */
        logChat: async function(prompt: string, options: ChatOptions): Promise<void> {
            const response = await this.chat(prompt, options);
            console.log(response);
        },
        /**
         * Chat with a "short and concise" modifier and log the response.
         *
         * @param {string} prompt The user prompt.
         * @param {Object} [options] Chat options.
         */
        logChatShort: async function(prompt: string, options: ChatOptions): Promise<void> {
            const response = await this.chatShort(prompt, options);
            console.log(response);
        },
    };

    // ---- Default agent tool registry (ml.domTools) ----
    // Generic, page-agnostic DOM introspection + escape-hatch tools. Pass this
    // array (or a superset — `[...ml.domTools, myTool]`) to ml.agent. Each tool
    // returns a short string; observations never balloon into raw HTML.
    const T = window.ml.defineTool;
    window.ml.domTools = [
        T({
            name: "findByText",
            description: "Find elements whose visible text contains a snippet. Returns the " +
                "deepest matching elements (not their containers) as structural paths, so you " +
                "can walk UP to the repeating card. Start here from a title/label you can see.",
            parameters: {
                type: "object",
                properties: {
                    text: { type: "string", description: "Visible text to search for (case-insensitive)." },
                    limit: { type: "integer", description: "Max matches to return (default 10)." }
                },
                required: ["text"]
            },
            run: ({ text, limit = 10 }: { text: string; limit?: number }): string | ToolResult => {
                if (!text) return "Provide `text` to search for.";
                const wanted = normalizeText(text);
                const out = [], els = [];
                for (const el of (document.body || document).querySelectorAll("*")) {
                    const tc = el.textContent;
                    if (!tc || !normalizeText(tc).includes(wanted)) continue;
                    // Deepest match only: skip if a child element also contains it.
                    let childHas = false;
                    for (const c of el.children) {
                        if (c.textContent && normalizeText(c.textContent).includes(wanted)) { childHas = true; break; }
                    }
                    if (childHas) continue;
                    out.push(`#${els.length}: ${elPath(el)}  «${truncate(tc, 50)}»`);
                    els.push(el);
                    if (els.length >= limit) break;
                }
                return els.length ? { content: out.join("\n"), elements: els } : `No elements contain "${text}".`;
            }
        }),
        T({
            name: "interactives",
            description: "List the page's interactive controls the way a SCREEN READER does — each by " +
                "ROLE + ACCESSIBLE NAME (+ state), with a ready-to-use selector. Use this to LOCATE a control " +
                "you can't anchor by visible text (icon buttons, toolbar actions, the like/menu buttons): read " +
                "the list, pick the row whose name matches what you want, then click its selector — don't guess " +
                "aria-labels via exec. Includes hover-revealed row actions (edit/delete). When a selector matches " +
                "several (e.g. one Edit per message), the row shows 'index N of M' — pass N as click's `index`. " +
                "Like landmark navigation, it scopes to the main content (an open modal, else <main>, else the page " +
                "minus nav/sidebar chrome) so page content isn't drowned out — pass includeNav:true for nav/sidebar " +
                "controls. Defaults to the current viewport; pass scope:'page' for the whole document.",
            parameters: {
                type: "object",
                properties: {
                    scope: { type: "string", enum: ["viewport", "page"], description: "Where to look (default 'viewport')." },
                    contains: { type: "string", description: "Optional: only controls whose accessible name contains this text (case-insensitive)." },
                    limit: { type: "integer", description: "Max controls to return (default 40)." },
                    includeNav: { type: "boolean", description: "Include navigation/sidebar controls too (default false — they're skipped so page content isn't drowned out)." }
                }
            },
            run: ({ scope = "viewport", contains = "", limit = 40, includeNav = false }: { scope?: string; contains?: string; limit?: number; includeNav?: boolean }): string | ToolResult => {
                const layout = hasLayout();
                const NAV_SEL = 'nav, aside, [role="navigation"], [role="complementary"], [role="banner"], #sidebar, [class*="sidebar" i]';
                const inView = (el: Element): boolean => {
                    if (!layout || scope === "page") return true;
                    const r = el.getBoundingClientRect();
                    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
                };
                const want = String(contains).toLowerCase();
                type Item = { el: Element; role: string; name: string; state: string; al: string | null };
                const collect = (from: Element | Document, skipNav: boolean): Item[] => {
                    const acc: Item[] = [];
                    for (const el of from.querySelectorAll(INTERACTIVE_SEL)) {
                        if (styleHidden(el) || !inView(el)) continue;
                        if (skipNav) { try { if (el.closest(NAV_SEL)) continue; } catch { /* invalid :i on old engines */ } }
                        const name = accessibleName(el);
                        if (want && !name.toLowerCase().includes(want)) continue;
                        acc.push({ el, role: roleOf(el), name, state: [ariaState(el), isFaded(el) ? "hidden until hover" : ""].filter(Boolean).join(", "), al: el.getAttribute("aria-label") });
                        if (acc.length >= 500) break;   // scan safety cap
                    }
                    return acc;
                };
                // Scope like a screen reader's landmark navigation, but AUTO-BROADEN so an
                // empty region never dead-ends the model: a genuinely-open modal (visible +
                // actually holds controls, so a phantom modal-mount is skipped) → <main> →
                // the page minus nav/sidebar → the whole page. First non-empty wins.
                const visibleModal = [...document.querySelectorAll('[aria-modal="true"], dialog[open], [role="dialog"]')]
                    .find(d => !styleHidden(d) && !isFaded(d) && (!layout || d.getBoundingClientRect().height > 0) && d.querySelector(INTERACTIVE_SEL));
                const main = document.querySelector('main, [role="main"]');
                const tries: { root: Element | Document; skipNav: boolean; note: string }[] = [];
                if (visibleModal) tries.push({ root: visibleModal, skipNav: false, note: "A modal dialog is open — listing its controls:\n" });
                if (main && !styleHidden(main)) tries.push({ root: main, skipNav: false, note: "Listing the main content region's controls:\n" });
                tries.push({ root: document, skipNav: !includeNav, note: includeNav ? "" : "(navigation/sidebar controls skipped — pass includeNav:true for them)\n" });
                tries.push({ root: document, skipNav: false, note: "" });   // last resort: everything
                let items: Item[] = [], note = "";
                for (const t of tries) { items = collect(t.root, t.skipNav); if (items.length) { note = t.note; break; } }
                const groups = new Map<string, Item[]>();
                for (const it of items) { const k = it.role + " " + it.name; let g = groups.get(k); if (!g) groups.set(k, g = []); g.push(it); }
                const out: string[] = [], els: Element[] = [];
                let n = 0;
                for (const grp of groups.values()) {
                    if (out.length >= limit) break;
                    const f = grp[0], label = f.name ? `"${truncate(f.name, 60)}"` : "(no accessible name)";
                    const sameAl = !!f.al && !f.al.includes('"') && grp.every(g => g.al === f.al);
                    if (grp.length > 3 && sameAl) {   // collapse only real floods; keep small dup sets (e.g. 2 Edits) itemised with per-element state
                        out.push(`#${n++} [${f.role}] ${label} ×${grp.length}  →  ${f.el.tagName.toLowerCase()}[aria-label="${f.al}"] · index 0–${grp.length - 1}`);
                        els.push(...grp.map(g => g.el));
                    } else for (const it of grp) {
                        if (out.length >= limit) break;
                        let sel: string;
                        if (it.al && !it.al.includes('"')) {
                            sel = `${it.el.tagName.toLowerCase()}[aria-label="${it.al}"]`;
                            try { const m = [...document.querySelectorAll(sel)]; if (m.length > 1) sel += ` · index ${m.indexOf(it.el)} of ${m.length}`; } catch { /* ignore */ }
                        } else sel = elPath(it.el);
                        out.push(`#${n++} [${it.role}] ${it.name ? `"${truncate(it.name, 60)}"` : "(no accessible name)"}${it.state ? ` — ${it.state}` : ""}  →  ${sel}`);
                        els.push(it.el);
                    }
                }
                if (!els.length) return contains ? `No interactive controls with a name containing "${contains}". Try again without \`contains\` to list everything.` : "No interactive controls found.";
                return { content: note + out.join("\n"), elements: els };
            }
        }),
        T({
            name: "describeElement",
            description: "Skeleton of an element and its descendants to a depth: tags, ids, " +
                "classes, data-* attributes, own text. Use it to walk up/down the tree and " +
                "spot the repeating container and stable anchors. Never returns innerHTML.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector; the first match is described." },
                    depth: { type: "integer", description: "How many levels of children to include (default 2, max 4)." }
                },
                required: ["selector"]
            },
            run: ({ selector, depth = 2 }: { selector: string; depth?: number }): string | ToolResult => {
                let el: Element | undefined;
                try { el = queryAll(selector)[0]; }
                catch (e) { return selectorError(selector, e as Error); }
                if (!el) return `No element matches "${selector}".`;
                return { content: describeSkeleton(el, Math.min(Math.max(depth, 0), 4)), elements: [el] };
            }
        }),
        T({
            name: "ancestors",
            description: "Walk UP from the first element matching a selector: lists each ancestor " +
                "(tag, id, classes, data-*) from the element out to <body>, numbered by hop. The " +
                "counterpart to describeElement (which goes DOWN) — use it to find a containing or " +
                "repeating ancestor above a matched element.",
            parameters: {
                type: "object",
                properties: { selector: { type: "string", description: "CSS selector; the first match's ancestors are listed." } },
                required: ["selector"]
            },
            run: ({ selector }: { selector: string }): string | ToolResult => {
                let el: Element | undefined;
                try { el = queryAll(selector)[0]; }
                catch (e) { return selectorError(selector, e as Error); }
                if (!el) return `No element matches "${selector}".`;
                const chain: string[] = [];
                let node: Node | null = el, i = 0;
                while (node && node.nodeType === 1 && node !== document.documentElement && i < 15) {
                    chain.push(`[${i}] ${elLine(node as Element)}`);
                    node = node.parentElement;
                    i++;
                }
                return { content: chain.join("\n"), elements: [el] };
            }
        }),
        T({
            name: "countMatches",
            description: "How many elements a CSS selector matches. Cheap verification — call " +
                "this before acting to confirm the count is plausible for the page.",
            parameters: {
                type: "object",
                properties: { selector: { type: "string" } },
                required: ["selector"]
            },
            run: ({ selector }: { selector: string }): string | ToolResult => {
                let els: Element[];
                try { els = queryAll(selector); }
                catch (e) { return selectorError(selector, e as Error); }
                return { content: String(els.length), elements: els.slice(0, 50) };
            }
        }),
        T({
            name: "sampleText",
            description: "Visible text of the first N elements matching a selector. Use it to " +
                "confirm a selector grabbed the intended items and not headers/ads.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string" },
                    n: { type: "integer", description: "How many matches to sample (default 5)." }
                },
                required: ["selector"]
            },
            run: ({ selector, n = 5 }: { selector: string; n?: number }): string | ToolResult => {
                let els: Element[];
                try { els = queryAll(selector); }
                catch (e) { return selectorError(selector, e as Error); }
                if (!els.length) return `No element matches "${selector}".`;
                const count = Math.min(n, els.length);
                const out: string[] = [], sampled: Element[] = [];
                for (let i = 0; i < count; i++) {
                    out.push(`#${i}: ${truncate((els[i] as HTMLElement).innerText || els[i].textContent, 120)}`);
                    sampled.push(els[i]);
                }
                if (els.length > count) out.push(`…(${count} of ${els.length} shown)`);
                return { content: out.join("\n"), elements: sampled };
            }
        }),
        T({
            name: "exec",
            description: "Escape hatch: run JS in the page, like one cell in a console. You get back " +
                "BOTH anything it console.log's AND the final expression's value — so either " +
                "console.log the data you want to inspect, or make the last line evaluate to it " +
                "(e.g. `[...document.querySelectorAll('.card')].map(c => c.innerText.slice(0,80))`), " +
                "or both. Async is supported: you may `await` inside and `return` a value " +
                "(e.g. `const r = await fetch('/api').then(x => x.json()); return r.length`). " +
                "Use only when the other tools can't answer; prefer them.",
            requiresApproval: true,     // arbitrary eval — the agent gate confirms each call
            // Debug view: show the JS that ran as a highlighted code block (raw
            // toggle still reveals the underlying args/result).
            render: (_input, args) => ({ type: "code", text: String((args as { js?: string }).js || ""), lang: "javascript", target: "in", format: true }),
            parameters: {
                type: "object",
                properties: { js: { type: "string", description: "JavaScript to run. console.log to print observations and/or end with an expression to return its value." } },
                required: ["js"]
            },
            run: async ({ js }: { js: string }): Promise<string | ToolResult> => {
                // The model can't see the page's console, and expressions like
                // forEach(...) evaluate to undefined — so it often console.logs to
                // "read" data and gets nothing back. Capture console output during
                // the eval and return it too, so that pattern still works.
                const logs: string[] = [];
                const methods = ["log", "info", "warn", "error", "debug"] as const;
                const saved: Record<string, typeof console.log> = {};
                for (const m of methods) {
                    saved[m] = console[m];
                    console[m] = (...a: unknown[]) => logs.push(a.map(x => {
                        if (typeof x === "string") return x;
                        try { return JSON.stringify(x); } catch { return String(x); }
                    }).join(" "));
                }

                let result: unknown;
                let failed: unknown;
                try {
                    try {
                        result = (0, eval)(js);   // fast path — preserves the last expression's value
                    } catch (e) {
                        // eval rejects top-level `await`/`return` with a SyntaxError,
                        // thrown at parse time before anything runs — so retry the
                        // source as an async function body (both now work). The model
                        // must `return` its value here (no last-expression auto-return).
                        // A genuine syntax error re-throws from this attempt and is reported.
                        if (e instanceof SyntaxError) {
                            const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as { new (body: string): () => Promise<unknown> };
                            result = new AsyncFunction(js)();
                        } else throw e;
                    }
                    if (result && typeof (result as Promise<unknown>).then === "function") result = await result;
                } catch (e) {
                    failed = e;
                } finally {
                    for (const m of methods) console[m] = saved[m];
                }

                // Prefix any captured console output onto the returned value.
                const logged = logs.length ? `console:\n${truncate(logs.join("\n"), 500)}` : "";
                const withLogs = (value: string) => logged ? `${logged}\n\nvalue: ${value}` : value;

                if (failed) return withLogs(`Error: ${(failed as Error).message}`);

                // DOM node results come back hoverable (see the loop's envelope).
                if (typeof Element !== "undefined" && result instanceof Element) {
                    return { content: withLogs(elPath(result)), elements: [result] };
                }
                const isNodes = result && (
                    (typeof NodeList !== "undefined" && result instanceof NodeList) ||
                    (typeof HTMLCollection !== "undefined" && result instanceof HTMLCollection) ||
                    (Array.isArray(result) && result.length > 0 &&
                        result.every((n: unknown) => typeof Element !== "undefined" && n instanceof Element))
                );
                if (isNodes) {
                    return { content: withLogs(`${(result as NodeListOf<Node>).length} element(s)`), elements: [...(result as NodeListOf<Node>)].slice(0, 50) };
                }

                let value: string;
                if (result === undefined) value = "(undefined)";
                else if (typeof result === "object") {
                    try { value = truncate(JSON.stringify(result), 500); }
                    catch { value = truncate(String(result), 500); }
                } else value = truncate(String(result), 500);
                return withLogs(value);
            }
        }),
        T({
            name: "pageInfo",
            description: "Where and when you are: the page URL, title, language, and the current " +
                "date/time + locale/timezone. Use it to ground time-relative tasks (what counts as " +
                "'today'?) and to confirm the site and language before matching text.",
            parameters: { type: "object", properties: {} },
            run: (): string => pageContext()
        }),
        T({
            name: "scroll",
            description: "Scroll the page to reveal below-the-fold or lazy-loaded content, then " +
                "re-run look/countMatches/findByText to see what appeared. `to`: 'bottom' (default — " +
                "triggers infinite-scroll/lazy-load), 'top', or 'element' (needs `selector`). Or `by`: " +
                "scroll N pixels (negative = up).",
            parameters: {
                type: "object",
                properties: {
                    to: { type: "string", enum: ["bottom", "top", "element"], description: "Where to scroll (default 'bottom')." },
                    selector: { type: "string", description: "Element to bring into view (with to:'element')." },
                    by: { type: "integer", description: "Scroll by this many pixels instead (negative = up)." }
                }
            },
            run: async ({ to, selector, by }: { to?: "bottom" | "top" | "element"; selector?: string; by?: number } = {}): Promise<string> => {
                const doc = document.scrollingElement || document.documentElement || document.body;
                let note: string;
                if (typeof by === "number") {
                    window.scrollBy(0, by);
                    note = `Scrolled by ${by}px`;
                } else if (to === "element" || selector) {
                    if (!selector) return "Provide `selector` to scroll to an element.";
                    let el: Element | undefined;
                    try { el = queryAll(selector)[0]; }
                    catch (e) { return selectorError(selector, e as Error); }
                    if (!el) return `No element matches "${selector}".`;
                    el.scrollIntoView({ block: "center", inline: "center" });
                    note = `Scrolled "${selector}" into view`;
                } else if (to === "top") {
                    window.scrollTo(0, 0);
                    note = "Scrolled to top";
                } else {
                    window.scrollTo(0, (doc && doc.scrollHeight) || 0);
                    note = "Scrolled to bottom";
                }
                // Let lazy-load fire and layout settle before reporting (skipped where
                // requestAnimationFrame is absent, e.g. the jsdom test sandbox).
                const raf = (typeof window !== "undefined" && window.requestAnimationFrame) || null;
                if (raf) await new Promise(r => raf(() => raf(r)));
                const y = Math.round(typeof window.scrollY === "number" ? window.scrollY : ((doc && doc.scrollTop) || 0));
                const max = Math.max(0, Math.round(((doc && doc.scrollHeight) || 0) - (window.innerHeight || 0)));
                const atBottom = max === 0 || y >= max - 2;
                return `${note}. Position y=${y}/${max}${atBottom ? " (at bottom)" : ""}. ` +
                    "Re-run look/countMatches/findByText to see any newly loaded content.";
            }
        }),
        T({
            name: "wait",
            description: "Wait for the page to settle after an async update (a click/type/navigation " +
                "takes effect after a delay, not instantly). Pass `selector` to wait until an element " +
                "APPEARS (best — waits exactly as long as needed), or `ms` for a fixed pause. Use it " +
                "generously before you look/read again; reading a mid-update page gives stale results.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "Wait until an element matching this appears (up to `timeout`)." },
                    ms: { type: "integer", description: "Fixed pause in milliseconds (used when no selector; default 500)." },
                    timeout: { type: "integer", description: "Max wait for a selector, in ms (default 5000)." }
                }
            },
            run: async ({ selector, ms, timeout = 5000 }: { selector?: string; ms?: number; timeout?: number } = {}): Promise<string> => {
                if (selector) {
                    const cap = Math.min(Math.max(timeout | 0, 0) || 5000, 30000);
                    const has = () => { try { return queryAll(selector).length > 0; } catch { return false; } };
                    const start = Date.now();
                    const appeared = has() || await new Promise<boolean>(resolve => {
                        let done = false;
                        const finish = (v: boolean) => { if (done) return; done = true; try { obs.disconnect(); } catch {} clearTimeout(timer); resolve(v); };
                        const obs = new MutationObserver(() => { if (has()) finish(true); });
                        try { obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true }); }
                        catch { finish(false); return; }
                        const timer = setTimeout(() => finish(false), cap);
                    });
                    return appeared
                        ? `"${selector}" appeared after ${Date.now() - start}ms. Re-run look/findByText to see the updated page.`
                        : `Timed out after ${cap}ms waiting for "${selector}" — it did not appear.`;
                }
                const dur = Math.min(typeof ms === "number" && ms > 0 ? ms : 500, 30000);
                await new Promise(r => setTimeout(r, dur));
                return `Waited ${dur}ms. Re-run look/findByText to see any updates.`;
            }
        }),
        T({
            name: "answer",
            capabilities: ["answer"],
            description: "Return specific element(s) as your RESULT — use this when the task asks " +
                "you to find / locate / return an element rather than change the page. Pass the CSS " +
                "selector (supports :contains()/:has-text()); pass `index` to designate one specific " +
                "match (0-based) — call it once per item to collect several. The element(s) are handed " +
                "back to the caller (and are hoverable in the console).",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector for the answer element(s)." },
                    index: { type: "integer", description: "Designate one specific match (0-based); omit to return all matches." },
                    note: { type: "string", description: "Optional note about what these are." }
                },
                required: ["selector"]
            },
            run: ({ selector, index, note }: { selector: string; index?: number; note?: string }): string | ToolResult => {
                let els: Element[];
                try { els = queryAll(selector); }
                catch (e) { return selectorError(selector, e as Error); }
                if (index != null) {
                    const el = els[index];
                    if (!el) return `No element at index ${index} for "${selector}" (${els.length} match(es)).`;
                    els = [el];
                }
                if (!els.length) return `No element matches "${selector}".`;
                const preview = els.slice(0, 5).map(elLine).join("; ");
                return {
                    content: `Answer: ${els.length} element(s)${note ? ` — ${note}` : ""}: ${preview}`,
                    elements: els.slice(0, 50)
                };
            }
        })
    ];

    // Readiness signal for scripts (e.g. userscripts) that may run before this
    // one injects. Resolves immediately since window.ml is fully synchronous:
    //   const ml = await (window.ml?.ready
    //       ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));
    window.ml.ready = Promise.resolve(window.ml);
    window.dispatchEvent(new Event("ml:ready"));

    console.log("🟢 window.ml is ready.");
})();
// The default agent tool registry (ml.domTools): generic, page-agnostic DOM
// introspection + escape-hatch tools. Extracted from injected.ts — each tool is a
// plain data+run object that closes over only the imported DOM/a11y helpers (no
// `ml`/bus state), so the whole set lifts out cleanly. `makeDomTools` takes the
// (detached, `this`-free) `defineTool` and returns the array.

import type { MlTool, ToolResult, ToolContext, AnswerMedia } from "./contract";
import type { VerifyArea } from "./builtin-tools";
/** Serialize a screenshot-crop of each designated `answer` element for the HUD completion card. ml-backed
 *  (built in injected.ts), so the pure domTools stay pure — the answer tool just calls it when present. */
export type CaptureAnswer = (els: Element[], note?: string, show?: "inline" | "highlight") => Promise<AnswerMedia[]>;
import { truncate, clipOut, errText, elPath, normalizeText, clickSelector, elLine, describeSkeleton, queryAll, deepQueryAll, closedShadowHosts, frameHostOf, selectorError } from "./dom";
import { INTERACTIVE_SEL, roleOf, accessibleName, placeholderText, ariaState, hasLayout, styleHidden, isFaded } from "./a11y";
import { pageContext, browserInfo, agentState } from "./util";
import { makeBackgroundTaskPromise } from "./bridge";
import type { InvocationInfo, MlPublicConfig } from "./contract";
import { ML_READONLY_METHODS } from "./readonly-exec";
// Generated from contract.ts at build time (scripts/gen-api-docs.mjs) — the public MlApi
// surface, so the doc the model reads can never drift from the interface it describes.
import { resolveOutputCap, outputCapPrecheck } from "./contract";
import { ML_API_DOCS } from "./api-docs.gen";
import { BUILD_INFO } from "./build-info.gen";

// A single-element tool (describeElement/ancestors) uses the FIRST of N matches — say so, so
// a loose selector's wrong pick doesn't silently mislead the run (the model can narrow it).
// How long invocationSection waits for the background's shortcut reply before answering
// generically. Short: it's one section of a docs lookup, never worth stalling a step for.
const INVOCATION_TIMEOUT_MS = 1500;

/**
 * Await a background lookup, giving up with `null` after {@link INVOCATION_TIMEOUT_MS} — a docs
 * lookup must never stall an agent step on a slow/torn-down relay, and every caller here degrades
 * to generic advice. The timer is cleared on the fast path so a resolved lookup leaves nothing
 * pending on the event loop.
 *
 * @param p The in-flight background promise.
 * @returns Its value, or null on timeout/rejection.
 */
const bounded = async <T>(p: Promise<T>): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([p, new Promise<null>(r => { timer = setTimeout(() => r(null), INVOCATION_TIMEOUT_MS); })]);
    } catch {
        return null;
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
};

/**
 * The "how the user opens the HUD here" section of agent_api_docs — resolved at RUN TIME, not
 * baked into the generated reference, because the keyboard shortcut is user-rebindable: a
 * hardcoded "Alt+Space" sends them to a key that may do nothing. Reports what is bound right
 * now, whether they changed it, and the settings URL for THEIR browser (the scheme differs on
 * Edge/Brave/…). Degrades to the generic instructions if the background can't be reached.
 *
 * @returns {Promise<string>} A markdown section for the tool's output.
 */
const invocationSection = async (): Promise<string> => {
    const b = browserInfo();
    const shortcutsUrl = `${b.scheme}://extensions/shortcuts`;
    const lines = [`## Opening the HUD (this browser: ${b.name}${b.version ? ` ${b.version}` : ""})`, ""];
    // Bounded: makeBackgroundTaskPromise waits forever for its reply, and a missing/slow relay
    // (torn-down content script, sleeping worker) must degrade to generic advice rather than
    // stall the agent step on a docs lookup.
    const info = await bounded(makeBackgroundTaskPromise<InvocationInfo>("INVOCATION_REQUEST", "INVOCATION_RESPONSE", {}));
    if (info?.shortcut) {
        lines.push(`- **Keyboard: \`${info.shortcut}\`** — the shortcut bound RIGHT NOW` +
            (info.isDefault ? " (the extension's default)." : ` (the user CHANGED this from the default \`${info.defaultShortcut}\`).`));
    } else if (info) {
        lines.push(`- **Keyboard: not assigned.** The default (\`${info.defaultShortcut || "Alt+Space"}\`) is not bound — ` +
            "either the user cleared it or it collided with another extension. They must set one to open the HUD by keyboard.");
    } else {
        lines.push("- **Keyboard:** a shortcut opens the HUD, but the live binding could not be read here — " +
            "tell the user to check the shortcuts page below rather than guessing a key.");
    }
    lines.push(`- **Rebinding it:** the user opens \`${shortcutsUrl}\` and edits "Open the window.ml command bar". ` +
        "Chromium reserves that page for the user — neither you nor the extension can set a shortcut for them, " +
        "and you cannot navigate there yourself (tools don't act on browser-internal pages), so hand them the URL.");
    if (info?.contextMenu) lines.push("- **Right-click** anywhere on the page and pick window.ml from the context menu.");
    lines.push("- **Toolbar:** the extension's icon opens the popup (settings, model picker), not the HUD.");
    return lines.join("\n");
};

/**
 * The "you can read your own setup for free" section of agent_api_docs. Like the HUD shortcut,
 * this is RUNTIME state the generated reference can't hold: it's true only while
 * `autoApproveReadonly` is on, so it's resolved here rather than stated unconditionally — and it
 * lives behind this tool call rather than in the system prompt, which every run pays for.
 *
 * @returns {Promise<string>} A markdown section, or "" when the flag is off (then these calls
 *          go through the normal approval gate and there is nothing special to say).
 */
const selfIntrospectionSection = async (): Promise<string> => {
    // Unreadable → say nothing: the approval gate is the safe default to describe.
    const cfg = await bounded(makeBackgroundTaskPromise<MlPublicConfig>("CONFIG_REQUEST", "CONFIG_RESPONSE", {}));
    if (!cfg?.autoApproveReadonly) return "";
    return ["## Reading your own setup (no approval needed)", "",
        `\`${ML_READONLY_METHODS.map(m => `ml.${m}()`).join("`, `")}\` are read-only, so calling them ` +
        "from `exec` runs with NO approval prompt — that's how to answer \"which model am I?\" and the like. " +
        "Every other `ml` method still asks the user first."].join("\n");
};

/**
 * The "here's my source" section of agent_api_docs: the public repo, the exact commit this harness was
 * built from + when that commit was made, and the build time. Lets the agent READ ITS OWN CODE (e.g. clone
 * or browse the repo at this commit) instead of guessing how it works. Build-time git provenance (the
 * extension can't run git live); fields it doesn't have are simply omitted, so a git-less build says less.
 * @returns {string} A markdown section, or "" when no provenance was captured.
 */
const sourceSection = (): string => {
    const b = BUILD_INFO;
    const lines: string[] = [];
    if (b.repoUrl) lines.push(`- Public repository: ${b.repoUrl}`);
    if (b.shortCommit) lines.push(`- This harness is built from commit \`${b.shortCommit}\`${b.commitDate ? ` (committed ${b.commitDate})` : ""}${b.commitUrl ? ` — ${b.commitUrl}` : ""}`);
    if (b.buildTime) lines.push(`- Built: ${b.buildTime}`);
    if (!lines.length) return "";
    return ["## My source", "",
        "You are open source — you can read your own implementation to answer questions about how you work:",
        ...lines].join("\n");
};

const firstOfNote = (selector: string, count: number): string =>
    count > 1 ? `⚠ "${selector}" matched ${count} elements — using the FIRST (#0). Narrow it (an id, or :nth-of-type(N)), or countMatches to list them.\n\n` : "";

// Appended to a page-SCANNING tool's output: the CLOSED shadow roots a selector scan couldn't enter, so the
// model knows a target it can't find may be sealed inside one. The workaround is conditional on `locate`
// being wired this run (ctx.hasTool) — without it there is no way in. "" when there are no closed roots.
const shadowScanNote = (ctx?: ToolContext): string => {
    const closed = closedShadowHosts();
    if (!closed.length) return "";
    const advice = ctx?.hasTool("locate")
        ? " If a control you can't find is inside one, `locate({ description: \"<how it looks>\", selector: \"<that host>\" })` searches it visually — then click the @pt it returns."
        : " Their contents can't be reached by ANY selector, and no `locate` tool is available to click them visually.";
    return `\n\n⚠ ${closed.length} CLOSED shadow root${closed.length === 1 ? "" : "s"} were not scanned (selectors can't enter them): ${closed.join(", ")}.${advice}`;
};

// Pass this array (or a superset — `[...ml.domTools, myTool]`) to ml.agent. Each
// tool returns a short string; observations never balloon into raw HTML.
export const makeDomTools = (defineTool: (tool?: Partial<MlTool>) => MlTool, verifyArea?: VerifyArea, captureAnswer?: CaptureAnswer): MlTool[] => {
    const T = defineTool;
    return [
        T({
            name: "findByText",
            summary: "Finds elements on the page by their visible text.",
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
            run: ({ text, limit = 10 }: { text: string; limit?: number }, ctx?: ToolContext): string | ToolResult => {
                if (!text) return "Provide `text` to search for.";
                const wanted = normalizeText(text);
                const out = [], els = [];
                // deepQueryAll pierces OPEN shadow roots — text inside a Web Component (e.g. Gemini's editor)
                // is otherwise invisible to a light-only `querySelectorAll("*")`. A shadow match gets a `>>>`
                // reference (clickSelector) since elPath can't express a path across a shadow boundary.
                for (const el of deepQueryAll("*", document.body || document)) {
                    const tc = el.textContent;
                    if (!tc || !normalizeText(tc).includes(wanted)) continue;
                    // Deepest match only: skip if a child element also contains it.
                    let childHas = false;
                    for (const c of el.children) {
                        if (c.textContent && normalizeText(c.textContent).includes(wanted)) { childHas = true; break; }
                    }
                    if (childHas) continue;
                    const path = el.getRootNode() === document ? elPath(el) : clickSelector(el);
                    out.push(`#${els.length}: ${path}  «${truncate(tc, 50)}»`);
                    els.push(el);
                    if (els.length >= limit) break;
                }
                const shadowNote = shadowScanNote(ctx);
                return els.length ? { content: out.join("\n") + shadowNote, elements: els } : `No elements contain "${text}".${shadowNote}`;
            }
        }),
        T({
            name: "interactives",
            summary: "Lists the clickable/interactive elements on the page.",
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
            run: ({ scope = "viewport", contains = "", limit = 40, includeNav = false }: { scope?: string; contains?: string; limit?: number; includeNav?: boolean }, ctx?: ToolContext): string | ToolResult => {
                const layout = hasLayout();
                const NAV_SEL = 'nav, aside, [role="navigation"], [role="complementary"], [role="banner"], #sidebar, [class*="sidebar" i]';
                const inView = (el: Element): boolean => {
                    if (!layout || scope === "page") return true;
                    const r = el.getBoundingClientRect();
                    return r.width > 1 && r.height > 1 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
                };
                const want = String(contains).toLowerCase();
                type Item = { el: Element; role: string; name: string; ph: string; state: string; al: string | null };
                const collect = (from: Element | Document, skipNav: boolean): Item[] => {
                    const acc: Item[] = [];
                    // deepQueryAll pierces OPEN shadow roots — web-component controls (icon buttons, custom
                    // inputs) are otherwise invisible here. Each shadow control's clickSelector is a `>>>` path.
                    for (const el of deepQueryAll(INTERACTIVE_SEL, from)) {
                        if (styleHidden(el) || !inView(el)) continue;
                        if (skipNav) { try { if (el.closest(NAV_SEL)) continue; } catch { /* invalid :i on old engines */ } }
                        const name = accessibleName(el);
                        const ph = placeholderText(el);
                        // Match by what the user SEES or TYPED: the accessible name, the (DOM-persistent) placeholder
                        // — still there after the field is filled, only hidden visually — and any current value /
                        // contenteditable text. So a filled field is findable by its placeholder OR its content, and
                        // a labelled box (Gemini: aria-label "Enter a prompt…", placeholder "Ask Gemini") by either.
                        if (want) {
                            const ce = el.getAttribute("contenteditable");
                            const editable = (el as HTMLElement).isContentEditable || ce === "" || ce === "true";   // attr check: jsdom doesn't compute isContentEditable
                            const typed = (el as HTMLInputElement).value || (editable ? (el.textContent || "") : "");
                            if (![name, ph, typed].some(s => s.toLowerCase().includes(want))) continue;
                        }
                        acc.push({ el, role: roleOf(el), name, ph, state: [ariaState(el), isFaded(el) ? "hidden until hover" : ""].filter(Boolean).join(", "), al: el.getAttribute("aria-label") });
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
                const skip = !includeNav;   // skip nav/sidebar in EVERY scope (a broad role="main"
                // can wrap the sidebar too), except inside a real modal where you want it all.
                // Only NOTE the skip when the page actually HAS nav/sidebar landmarks —
                // otherwise nothing was skipped and the note is misleading noise.
                const hasNav = (() => { try { return !!document.querySelector(NAV_SEL); } catch { return false; } })();
                const navNote = skip && hasNav ? "(navigation/sidebar controls skipped — pass includeNav:true for them)\n" : "";
                if (visibleModal) tries.push({ root: visibleModal, skipNav: false, note: "A modal dialog is open — listing its controls:\n" });
                if (main && !styleHidden(main)) tries.push({ root: main, skipNav: skip, note: "Listing the main content region's controls:\n" + navNote });
                tries.push({ root: document, skipNav: skip, note: navNote });
                tries.push({ root: document, skipNav: false, note: "" });   // last resort: everything
                let items: Item[] = [], note = "";
                for (const t of tries) { items = collect(t.root, t.skipNav); if (items.length) { note = t.note; break; } }
                const groups = new Map<string, Item[]>();
                for (const it of items) { const k = it.role + "\x00" + it.name; let g = groups.get(k); if (!g) groups.set(k, g = []); g.push(it); }
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
                        // A shadow-DOM control needs its `>>>` reference (clickSelector) — a plain
                        // `[aria-label]` selector's uniqueness/index check runs against `document` and can't
                        // see shadow siblings, so it'd be ambiguous. Light-DOM controls keep the aria-label form.
                        if (it.el.getRootNode() === document && it.al && !it.al.includes('"')) {
                            sel = `${it.el.tagName.toLowerCase()}[aria-label="${it.al}"]`;
                            try { const m = [...document.querySelectorAll(sel)]; if (m.length > 1) sel += ` · index ${m.indexOf(it.el)} of ${m.length}`; } catch { /* ignore */ }
                        } else sel = clickSelector(it.el);
                        // Show the placeholder when it's not already the name — it's what the model sees on screen
                        // (e.g. Gemini's "Ask Gemini") and bridges the gap when the accessible name differs.
                        const phNote = it.ph && it.ph.toLowerCase() !== it.name.toLowerCase() ? ` · placeholder "${truncate(it.ph, 40)}"` : "";
                        out.push(`#${n++} [${it.role}] ${it.name ? `"${truncate(it.name, 60)}"` : "(no accessible name)"}${phNote}${it.state ? ` — ${it.state}` : ""}  →  ${sel}`);
                        els.push(it.el);
                    }
                }
                const shadowNote = shadowScanNote(ctx);
                if (!els.length) return (contains ? `No interactive controls with a name containing "${contains}". Try again without \`contains\` to list everything.` : "No interactive controls found.") + shadowNote;
                return { content: note + out.join("\n") + shadowNote, elements: els };
            }
        }),
        T({
            name: "describeElement",
            summary: "Describes one element's structure and attributes.",
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
            run: ({ selector, depth = 2 }: { selector: string; depth?: number }, ctx?: ToolContext): string | ToolResult => {
                let els: Element[];
                try { els = queryAll(selector); }
                catch (e) { return selectorError(selector, e as Error); }
                const el = els[0];
                if (!el) return `No element matches "${selector}".`;
                return { content: firstOfNote(selector, els.length) + describeSkeleton(el, Math.min(Math.max(depth, 0), 4), "", ctx?.hasTool("locate")), elements: [el] };
            }
        }),
        T({
            name: "ancestors",
            summary: "Shows an element's parent chain up the DOM.",
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
                let els: Element[];
                try { els = queryAll(selector); }
                catch (e) { return selectorError(selector, e as Error); }
                const el = els[0];
                if (!el) return `No element matches "${selector}".`;
                const chain: string[] = [];
                let node: Element | null = el, i = 0;
                while (node && node.nodeType === 1 && node !== document.documentElement && i < 15) {
                    chain.push(`[${i}] ${elLine(node)}`);
                    if (node.parentElement) { node = node.parentElement; }
                    else {
                        // parentElement is null at the TOP of a shadow tree OR a same-origin iframe document —
                        // cross the boundary UP to the host (the shadow host, or the <iframe> element), noting
                        // it, so the chain reaches the real light-DOM ancestors in the parent document.
                        const root = node.getRootNode() as ShadowRoot;
                        if (root && root.nodeType === 11 && root.host) { chain.push(`    ⇡ (crossed a shadow boundary → host)`); node = root.host; }
                        else {
                            const frame = frameHostOf(node);
                            if (frame) { chain.push(`    ⇡ (crossed a same-origin iframe boundary → host)`); node = frame; }
                            else break;
                        }
                    }
                    i++;
                }
                return { content: firstOfNote(selector, els.length) + chain.join("\n"), elements: [el] };
            }
        }),
        T({
            name: "countMatches",
            summary: "Counts how many elements match a selector.",
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
            summary: "Samples visible text from matching elements.",
            description: "Visible text of the first N elements matching a selector. Use it to " +
                "confirm a selector grabbed the intended items and not headers/ads.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "CSS selector for possible matches." },
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
            summary: "Runs JavaScript to inspect the page.",
            description: "Escape hatch: run JS in the page, like one cell in a console. You get back " +
                "BOTH anything it console.log's AND the final expression's value — so either " +
                "console.log the data you want to inspect, or make the last line evaluate to it " +
                "(e.g. `[...document.querySelectorAll('.card')].map(c => c.innerText.slice(0,80))`), " +
                "or both. Async is supported: you may `await` inside and `return` a value " +
                "(e.g. `const r = await fetch('/api').then(x => x.json()); return r.length`). " +
                "The returned value AND the console output are EACH truncated to ~500 chars, so " +
                "don't dump whole elements/pages — return a compact, filtered summary (counts, a " +
                "handful of fields, the few items you actually need), not a full outerHTML dump. " +
                "If you GENUINELY need more room for ONE call, pass `maxChars` (up to 8000) WITH a " +
                "`maxCharsReason` — that raise asks the human first (a bigger dump costs your own context). " +
                // Define "read-only" so the model writes qualifying code instead of guessing why some
                // exec calls run instantly and others prompt (the auto-run is the autoApproveReadonly flag):
                "AUTO-RUN vs APPROVAL: code that is read-only BY CONSTRUCTION — only queries/reads + pure " +
                "computation (`.map`/`.filter`/`.reduce`, `for (const x of …)`, `ml.range`, the read-only " +
                "`ml.*` reads; NO mutation, effectful calls, reassignment (`x += …`), `.push`, a C-style " +
                "`for(;;)`/`while`, or `for…in`) — runs in a mediated \"safe\" interpreter with NO approval " +
                "prompt; anything else is still allowed but falls back to real `eval` and asks the user first. " +
                "So for a read-only survey prefer `.map`/`.filter`/`.reduce`/`for…of` + `ml.range(n)` — reach " +
                "for mutation or a while-loop only when the task actually needs it. " +
                "SHADOW DOM / IFRAMES: use `ml.queryAll('host >>> inner')` — a shadow/iframe-piercing " +
                "querySelectorAll that returns an Array and understands the same selector dialect the DOM " +
                "tools use (`>>>` crosses each OPEN shadow root / same-origin iframe; a trailing " +
                "`:contains(\"text\")` filters by visible text) — instead of hand-chaining `.shadowRoot` / " +
                "`.contentDocument`. " +
                // ml.fetch in exec: the fetch_url tool, callable inline — the payoff is cached RE-reads are a
                // read-only op (free), so approve a source once then parse/slice it across calls. Trimmed
                // signature here; full FetchResult type is in agent_api_docs.
                "CROSS-SITE READS: `ml.fetch(url)` — the same GET as the `fetch_url` tool, but callable inline — " +
                "reads a raw file / JSON API / other site the DOM can't reach, returning " +
                "`{ url, status, ok, type: 'json'|'csv'|'html'|'code'|'text'|…, text, json?, schema? }` (full type " +
                "via `agent_api_docs`). For a JSON body, `.json` is pre-parsed and `.schema` is a compact TS-like " +
                "SHAPE of it (`{ id: number, items: { name: string }[] }`) — read that to learn the structure of a " +
                "big payload without dumping it all. A NEW url asks once; then RE-reading that same url from a " +
                "read-only survey is FREE (cached) — approve a source once, then parse/slice/re-query it freely " +
                "(like `python_exec` on a Google Sheet). Failures aren't cached; pass `ml.fetch(url, { fresh: " +
                "true })` to SKIP the cache and force a live re-fetch (needs approval, even for a cached url). " +
                "PERSISTENT STATE: you have a `state` object (also `ml.state`) that is NOT reset between calls — " +
                "it's a live page kernel, like cells in a Jupyter notebook. For any multi-step work, DEFINE helper " +
                "functions and stash intermediate results on it ONCE, then REUSE them on later calls instead of " +
                "re-deriving from scratch (e.g. call 1: `state.rows = [...document.querySelectorAll('tr')].map(...)`; " +
                "call 2: `state.rows.filter(r => r.total > 100).length`). It's a single object shared across the whole " +
                "page session (and every run in this tab), so it survives — but two parallel runs share it. " +
                "Use exec only when the other tools can't answer; prefer them.",
            requiresApproval: true,     // arbitrary eval — the agent gate confirms each call
            // Debug view: show the JS that ran as a highlighted code block (raw
            // toggle still reveals the underlying args/result).
            render: (_input, args) => ({ type: "code", text: String((args as { js?: string }).js || ""), lang: "javascript", format: true }),
            parameters: {
                type: "object",
                properties: {
                    js: { type: "string", description: "JavaScript to run. console.log to print observations and/or end with an expression to return its value. Output is truncated to ~500 chars — return a filtered summary, not a full dump." },
                    maxChars: { type: "number", description: "Raise the per-slot output truncation for THIS call (default 500, max 8000). A raise needs human approval + `maxCharsReason`. Prefer a filtered summary instead." },
                    maxCharsReason: { type: "string", description: "Why this call needs more than the default 500 chars — required when `maxChars` exceeds it; shown to the human on the approval card." },
                },
                required: ["js"]
            },
            // A raise of maxChars beyond the default with no justification is DOOMED (it will just ask for one) —
            // skip the gate and steer the model to supply `maxCharsReason` (then the human sees it on the card).
            precheck: (args) => outputCapPrecheck("exec", args as Record<string, unknown>),
            run: async ({ js, maxChars, maxCharsReason }: { js: string; maxChars?: number; maxCharsReason?: string }): Promise<string | ToolResult> => {
                // Effective per-slot output cap. Default 500; a raise past it is only reachable AFTER the human
                // gate (the readonly try refuses to auto-approve an escalated call), clamped to the ceiling.
                const { cap, clamped } = resolveOutputCap("exec", maxChars, maxCharsReason);
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
                        // Fast path — preserves the last expression's value. Runs the source with the agent's
                        // persistent `state` scratchpad in scope (a direct eval INSIDE a fresh Function → the
                        // source sees `state` + globals, NOT this module's internals). `new Function`/eval are
                        // the same effectful, approval-gated capability the plain eval already needed.
                        result = new Function("state", "src", "return eval(src);")(agentState, js);
                    } catch (e) {
                        // eval rejects top-level `await`/`return` with a SyntaxError,
                        // thrown at parse time before anything runs — so retry the
                        // source as an async function body (both now work). The model
                        // must `return` its value here (no last-expression auto-return).
                        // A genuine syntax error re-throws from this attempt and is reported.
                        if (e instanceof SyntaxError) {
                            const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as { new (arg: string, body: string): (state: unknown) => Promise<unknown> };
                            // eval threw away the completion value when it rejected top-level
                            // await/return. Re-run as an async body — but first preserve the REPL
                            // trailing-expression convention (the fast-path eval and python_exec
                            // both honor it): if the whole source is a single expression, `return`
                            // it so its resolved value comes back. A multi-statement body isn't a
                            // valid parenthesized expression → SyntaxError at construction → fall
                            // back to the plain body (there the model must `return` explicitly).
                            const expr = js.trim().replace(/;\s*$/, "");
                            let fn: (state: unknown) => Promise<unknown>;
                            try { fn = new AsyncFunction("state", `return (${expr})`); }
                            catch { fn = new AsyncFunction("state", js); }
                            result = fn(agentState);
                        } else throw e;
                    }
                    if (result && typeof (result as Promise<unknown>).then === "function") result = await result;
                } catch (e) {
                    failed = e;
                } finally {
                    for (const m of methods) console[m] = saved[m];
                }

                // Prefix any captured console output onto the returned value.
                const logged = logs.length ? `console:\n${clipOut(logs.join("\n"), cap)}` : "";
                const clampNote = clamped ? `\n\n(output limit clamped to ${cap} chars — the hard ceiling.)` : "";
                const withLogs = (value: string) => (logged ? `${logged}\n\nvalue: ${value}` : value) + clampNote;

                if (failed) {
                    // errText, NOT `.message`: a rejected `ml.*` call (makeBackgroundTaskPromise) rejects with a
                    // STRING (the actionable message), which has no `.message` → the "Error: undefined" bug.
                    const msg = errText(failed);
                    // The #1 exec mistake: querySelectorAll / .children / getElementsBy* return a
                    // NodeList/HTMLCollection (array-LIKE, no .map/.filter). Steer the retry
                    // instead of leaving the model to flail on "map is not a function".
                    const arrayish = /\.(map|filter|forEach|reduce|some|every|find|flatMap|sort|slice) is not a function/.test(msg)
                        && /querySelectorAll|getElementsBy|\.children\b|\.childNodes\b|classList/.test(js);
                    const hint = arrayish
                        ? " — querySelectorAll / .children / getElementsBy* return a NodeList/HTMLCollection, not an Array. Wrap it first: [...document.querySelectorAll('…')].map(…) or Array.from(…)."
                        : "";
                    return withLogs(`Error: ${msg}${hint}`);
                }

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
                    try { value = clipOut(JSON.stringify(result), cap); }
                    catch { value = clipOut(String(result), cap); }
                } else value = clipOut(String(result), cap);
                return withLogs(value);
            }
        }),
        T({
            name: "pageInfo",
            summary: "Reports the page URL, title, and size.",
            description: "Where and when you are: the page URL, title, language, and the current " +
                "date/time + locale/timezone. Use it to ground time-relative tasks (what counts as " +
                "'today'?) and to confirm the site and language before matching text.",
            parameters: { type: "object", properties: {} },
            run: (): string => pageContext()
        }),
        T({
            name: "agent_api_docs",
            summary: "Looks up the window.ml extension's own API reference.",
            // Deliberately terse: this is a "when you need it" escape hatch, not a step in the
            // method, and it pays ~4k tokens of reference into context when called. The system
            // prompt's SELF_CLAUSE is what tells the model the tool is worth reaching for.
            description: "Your own implementation details: the public API of window.ml, the browser " +
                "extension you run inside, and how a user invokes you — the devtools console, or the " +
                "in-page HUD and the keyboard shortcut currently bound to it. Also gives the public repo " +
                "link + the exact commit this build is on (with its date), so you can read your own source. " +
                "Call it when asked about yourself, how to reach you, or the API, instead of guessing. " +
                "Takes no arguments.",
            parameters: { type: "object", properties: {} },
            // The generated reference is build-time; the source provenance (repo/commit) is build-time too;
            // the HUD shortcut and the read-only-exec flag are runtime state the user owns, appended live.
            run: async (): Promise<string> => [ML_API_DOCS, sourceSection(), await invocationSection(), await selfIntrospectionSection()]
                .filter(Boolean).join("\n\n")
        }),
        T({
            name: "scroll",
            summary: "Scrolls the page or an element into view.",
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
            summary: "Waits for an element to appear on the page.",
            description: "Wait for the page to settle after an async update (a click/type/navigation " +
                "takes effect after a delay, not instantly). Pass `selector` to wait until an element " +
                "APPEARS (best — waits exactly as long as needed), or `ms` for a fixed pause. Use it " +
                "generously before you look/read again; reading a mid-update page gives stale results.",
            parameters: {
                type: "object",
                properties: {
                    selector: { type: "string", description: "Wait until an element matching this appears (up to `timeout`)." },
                    ms: { type: "integer", description: "Fixed pause in milliseconds (used when no selector; default 500)." },
                    timeout: { type: "integer", description: "Max wait for a selector, in ms (default 5000)." },
                    verify: { type: "boolean", description: "Set true if you'd call look() right after — it returns a screenshot of the settled VIEWPORT in THIS call, so you skip the separate look and see the updated page immediately." }
                }
            },
            run: async ({ selector, ms, timeout = 5000, verify = false }: { selector?: string; ms?: number; timeout?: number; verify?: boolean } = {}, ctx?: ToolContext): Promise<string | ToolResult> => {
                // After the wait settles, optionally fold in a viewport screenshot (area-first: you verify the
                // settled PAGE, not the element you waited on). `verifyArea` is null-center → a plain viewport shot.
                const withVerify = async (base: string): Promise<string | ToolResult> => {
                    if (!verify || !verifyArea) return base;
                    const v = await verifyArea(ctx, null, "wait");
                    return { content: base + (v.content || ""), image: v.image, imageLabel: v.imageLabel, feedback: v.feedback };
                };
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
                    return withVerify(appeared
                        ? `"${selector}" appeared after ${Date.now() - start}ms.${verify ? "" : " Re-run look/findByText to see the updated page."}`
                        : `Timed out after ${cap}ms waiting for "${selector}" — it did not appear.`);
                }
                const dur = Math.min(typeof ms === "number" && ms > 0 ? ms : 500, 30000);
                await new Promise(r => setTimeout(r, dur));
                return withVerify(`Waited ${dur}ms.${verify ? "" : " Re-run look/findByText to see any updates."}`);
            }
        }),
        T({
            name: "answer",
            summary: "Marks the final answer / result elements.",
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
                    note: { type: "string", description: "Optional note about what these are." },
                    show: { type: "string", enum: ["inline", "highlight"], description: "How the HUD shows it to the user: 'inline' renders the image/screenshot in the card; 'highlight' shows a compact chip that spotlights the live element on the page. Default: an <img> → inline (show the picture), any other element → highlight (point at it). Hovering either highlights it on the page." }
                },
                required: ["selector"]
            },
            run: async ({ selector, index, note, show }: { selector: string; index?: number; note?: string; show?: "inline" | "highlight" }): Promise<string | ToolResult> => {
                let els: Element[];
                try { els = queryAll(selector); }
                catch (e) { return selectorError(selector, e as Error); }
                if (index != null) {
                    const el = els[index];
                    if (!el) return `No element at index ${index} for "${selector}" (${els.length} match(es)).`;
                    els = [el];
                }
                if (!els.length) return `No element matches "${selector}".`;
                const kept = els.slice(0, 50);
                const preview = kept.slice(0, 5).map(elLine).join("; ");
                // Serialize a screenshot-crop of each designated element for the HUD completion card (user-facing
                // output). Best-effort — a failed capture just omits the media; the answer still stands.
                let answerMedia: AnswerMedia[] | undefined;
                if (captureAnswer) { try { answerMedia = await captureAnswer(kept, note, show); } catch { /* no media */ } }
                return {
                    content: `Answer: ${els.length} element(s)${note ? ` — ${note}` : ""}: ${preview}`,
                    elements: kept,
                    ...(answerMedia && answerMedia.length ? { answerMedia } : {}),
                };
            }
        })
    ];
};

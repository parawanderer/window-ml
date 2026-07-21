// The default agent tool registry (ml.domTools): generic, page-agnostic DOM
// introspection + escape-hatch tools. Extracted from injected.ts — each tool is a
// plain data+run object that closes over only the imported DOM/a11y helpers (no
// `ml`/bus state), so the whole set lifts out cleanly. `makeDomTools` takes the
// (detached, `this`-free) `defineTool` and returns the array.

import type { MlTool, ToolResult } from "./contract";
import { truncate, elPath, normalizeText, clickSelector, elLine, describeSkeleton, queryAll, selectorError } from "./dom";
import { INTERACTIVE_SEL, roleOf, accessibleName, ariaState, hasLayout, styleHidden, isFaded } from "./a11y";
import { pageContext } from "./util";

// Pass this array (or a superset — `[...ml.domTools, myTool]`) to ml.agent. Each
// tool returns a short string; observations never balloon into raw HTML.
export const makeDomTools = (defineTool: (tool?: Partial<MlTool>) => MlTool): MlTool[] => {
    const T = defineTool;
    return [
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
                const skip = !includeNav;   // skip nav/sidebar in EVERY scope (a broad role="main"
                const navNote = skip ? "(navigation/sidebar controls skipped — pass includeNav:true for them)\n" : "";
                // can wrap the sidebar too), except inside a real modal where you want it all.
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
                        if (it.al && !it.al.includes('"')) {
                            sel = `${it.el.tagName.toLowerCase()}[aria-label="${it.al}"]`;
                            try { const m = [...document.querySelectorAll(sel)]; if (m.length > 1) sel += ` · index ${m.indexOf(it.el)} of ${m.length}`; } catch { /* ignore */ }
                        } else sel = clickSelector(it.el);
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
                "The returned value AND the console output are EACH truncated to ~500 chars, so " +
                "don't dump whole elements/pages — return a compact, filtered summary (counts, a " +
                "handful of fields, the few items you actually need), not a full outerHTML dump. " +
                "Use only when the other tools can't answer; prefer them.",
            requiresApproval: true,     // arbitrary eval — the agent gate confirms each call
            // Debug view: show the JS that ran as a highlighted code block (raw
            // toggle still reveals the underlying args/result).
            render: (_input, args) => ({ type: "code", text: String((args as { js?: string }).js || ""), lang: "javascript", target: "in", format: true }),
            parameters: {
                type: "object",
                properties: { js: { type: "string", description: "JavaScript to run. console.log to print observations and/or end with an expression to return its value. Output is truncated to ~500 chars — return a filtered summary, not a full dump." } },
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
};

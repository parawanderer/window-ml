// Pure DOM / string utilities used across injected.js — path building, the
// jQuery-tolerant query engine, skeleton descriptions, text normalization. No
// dependency on injected's closure state; only args + browser globals.

/**
 * Collapse whitespace, then truncate to a max length with a trailing ellipsis.
 *
 * @param {string} str The value to normalize (coerced; null/undefined → "").
 * @param {number} n Max length before truncating.
 * @returns {string} The collapsed string, ellipsized if it exceeded n.
 */
export const truncate = (str: string, n: number): string => {
    str = String(str == null ? "" : str).replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n) + "…" : str;
};

/**
 * Length-only truncate: cap to n chars with a trailing ellipsis, PRESERVING
 * whitespace — newlines included. Use for multi-line output (e.g. exec's console
 * capture) where {@link truncate}'s `\s+`→" " collapse would flatten the line
 * breaks into spaces.
 *
 * @param {string} str The value to cap (coerced; null/undefined → "").
 * @param {number} n Max length before truncating.
 * @returns {string} The string, ellipsized if it exceeded n, whitespace intact.
 */
export const clip = (str: string, n: number): string => {
    str = String(str == null ? "" : str);
    return str.length > n ? str.slice(0, n) + "…" : str;
};

/** Like {@link clip}, but for TOOL OUTPUT fed back to the model: it reports HOW MANY chars
 *  were dropped, so the model knows it's seeing a prefix (and a runaway result — e.g. a
 *  string-concat blowup — can't silently flood the context). */
export const clipOut = (str: string, n: number): string => {
    str = String(str == null ? "" : str);
    return str.length > n ? `${str.slice(0, n)}… [+${str.length - n} chars truncated]` : str;
};

/**
 * Extract error text from a caught throw. Background tasks reject with a plain
 * STRING (not an Error), so `e.message` would be undefined — fall back to String.
 *
 * @param {unknown} e The caught value (Error or bare string).
 * @returns {string} A human-readable message.
 */
export const errText = (e: unknown): string => (e && (e as Error).message) ? (e as Error).message : String(e);

/**
 * Escape an id/class token so it's a VALID CSS identifier. Tailwind classes are
 * full of chars that are illegal unescaped in a selector — `/` (opacity, bg-black/5),
 * `:` (variants, hover:bg-…), `[` `]` (arbitrary values, text-[10px]), `.` (size-8.5),
 * `!` (important). Prefers the platform CSS.escape; falls back to a minimal escaper
 * (backslash-prefix anything outside [A-Za-z0-9_-]) for environments without it
 * (e.g. jsdom in the tests).
 *
 * @param {string} s The raw id or class token.
 * @returns {string} The token, escaped so it's safe to splice into a selector.
 */
export const cssEsc = (s: string): string =>
    typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, m => "\\" + m);

/**
 * Build one `tag#id.class.class` selector segment for an element, with id +
 * classes escaped so the segment is ALWAYS valid CSS. Shared by elPath / elLine
 * so every path we hand the model is copy-paste-clickable, not a Tailwind-class
 * string that throws in querySelector.
 *
 * @param {Element} el The element to describe.
 * @param {number} maxClasses Cap on classes appended (keeps segments readable).
 * @returns {string} A valid single-element selector segment.
 */
export const cssSegment = (el: Element, maxClasses: number): string => {
    let seg = el.tagName.toLowerCase();
    if (el.id) seg += "#" + cssEsc(el.id);
    if (el.classList && el.classList.length) {
        seg += "." + [...el.classList].slice(0, maxClasses).map(cssEsc).join(".");
    }
    return seg;
};

/**
 * Compact structural path for an element: body > div#main > div.card > h2.title —
 * tag + id + up to 4 classes per ancestor, capped at 8 hops. A DESCRIPTION (shows
 * classes so the model sees structure) that is ALSO a valid selector (segments are
 * escaped) — though a shorter clickSelector is preferred where brevity matters.
 *
 * @param {Element} el The leaf element to trace up from.
 * @returns {string} A `>`-joined root→leaf selector path.
 */
export const elPath = (el: Element): string => {
    const parts: string[] = [];
    let node: Node | null = el, hops = 0;
    while (node && node.nodeType === 1 && node !== document.documentElement && hops < 8) {
        parts.unshift(cssSegment(node as Element, 4));
        node = node.parentElement;
        hops++;
    }
    return parts.join(" > ");
};

/** A copy-pasteable JS reference to the element a selector path (as elPath produces) locates:
 *  `document.querySelector('<path>')`, or `document.querySelectorAll('<path>')[i]` for a non-zero
 *  index. Backslashes (CSS escapes elPath emits, e.g. Tailwind `\/`) and single quotes are escaped for
 *  the JS string literal, so the emitted line evaluates to the right selector. Pure. */
export const elementReference = (path: string, index?: number): string => {
    const q = `'${String(path).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
    return typeof index === "number" && index > 0
        ? `document.querySelectorAll(${q})[${index}]`
        : `document.querySelector(${q})`;
};

/**
 * Fold typographic punctuation + whitespace to ASCII so a search for
 * "web-browser" matches a page that rendered "web‑browser" (non-breaking
 * hyphen) — plus curly quotes, non-breaking spaces, ellipsis, full-width
 * forms (NFKC). A model's own fancy hyphen in its output otherwise defeats its
 * own later findByText/:contains search. Also lowercases for case-insensitivity.
 *
 * @param {string|null|undefined} s The text to normalize.
 * @returns {string} The normalized, lowercased text.
 */
export const normalizeText = (s: string | null | undefined): string => (s || "")
    .normalize("NFKC")
    .replace(/[‐-―−⁃﹘﹣－]/g, "-")   // hyphens/dashes/minus → -
    .replace(/[‘’‚‛′]/g, "'")               // curly / prime single quotes → '
    .replace(/[“”„‟″]/g, '"')               // curly / prime double quotes → "
    .replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Shortest VALID, unique CSS selector for an element — for lists whose selectors
 * are meant to be CLICKED (interactives). Prefers a unique id (own or ancestor);
 * else `tag:nth-of-type(n)` walking UP only until unique. Avoids elPath's giant,
 * un-escapable Tailwind-class chains. Falls through to a best-effort path.
 *
 * @param {Element} target The element to build a selector for.
 * @returns {string} A unique (where resolvable), valid selector.
 */
export const clickSelector = (target: Element): string => {
    const root = target.getRootNode() as ShadowRoot;
    // Inside an OPEN shadow root → a shadow-CROSSING reference: `<host path> >>> <inner path>`. queryAll
    // parses `>>>` back (stepping into each host's shadowRoot), so click/type/describeElement re-find it.
    // Duck-type (nodeType 11 + a `host`) rather than `instanceof ShadowRoot` — the latter breaks across
    // realms (e.g. the vm/jsdom test harness) and when ShadowRoot isn't a global.
    if (root && root.nodeType === 11 && root.host) {
        return `${clickSelector(root.host)} >>> ${selectorWithin(target, root)}`;
    }
    return selectorWithin(target, document);
};
// The shortest-unique-selector logic, scoped to a root (document OR a shadow root) so uniqueness is checked
// within that tree and the walk-up stops at the root's boundary (a shadow tree's top element has no parent).
const selectorWithin = (target: Element, scope: Document | ShadowRoot): string => {
    const esc = cssEsc;
    const uniq = (sel: string): boolean => { try { const m = scope.querySelectorAll(sel); return m.length === 1 && m[0] === target; } catch { return false; } };
    const idUnique = (el: Element) => !!el.id && (() => { try { return scope.querySelectorAll("#" + esc(el.id)).length === 1; } catch { return false; } })();
    if (idUnique(target)) return "#" + esc(target.id);
    const top = scope.nodeType === 9 ? (scope as Document).documentElement : null;   // stop here (or at a null parent in a shadow root)
    const parts: string[] = [];
    let el: Element | null = target, hops = 0;
    while (el && el.nodeType === 1 && el !== top && hops < 12) {
        if (idUnique(el)) parts.unshift("#" + esc(el.id));
        else {
            let seg = el.tagName.toLowerCase();
            const p = el.parentElement;
            if (p) { const sibs = [...p.children].filter(c => c.tagName === el!.tagName); if (sibs.length > 1) seg += `:nth-of-type(${sibs.indexOf(el) + 1})`; }
            parts.unshift(seg);
        }
        if (uniq(parts.join(" > "))) return parts.join(" > ");
        el = el.parentElement; hops++;
    }
    return parts.join(" > ") || target.tagName.toLowerCase();
};

// --- Closed-shadow-root piercing (opt-in `pierceClosedShadow`) ---------------------------------------
// The document_start patch (shadow-patch.ts, main world) stashes every CLOSED shadow root in
// window.__mlClosedRoots as it's created. We CONSULT that map only when the user turned the flag on —
// injected.ts calls setPierceClosedShadow() with the run's config before the DOM tools execute. Off (the
// default) → capturedClosedRoot always returns null and every closed root stays unreachable, exactly as
// before. This is the single seam; all traversal (deepQueryAll, `>>>` resolution, describeSkeleton, the
// stats/host scans) reads closed roots through traversableRoot/capturedClosedRoot so the feature is on or
// off uniformly.
// The flag and the captured-roots map both live on `window` (the main world, where `window === globalThis`)
// — the map because shadow-patch.js sets it there at document_start, the flag so the same lives beside it and
// stays reachable from the one `window` both this module and the patch share.
/** Enable/disable closed-shadow-root piercing for subsequent DOM-tool calls (set per agent run from config). */
export const setPierceClosedShadow = (on: boolean): void => {
    (window as unknown as Record<string, unknown>).__mlPierceClosed = on;
};

/** The CLOSED shadow root the document_start patch captured for `el`, IF piercing is enabled and it grabbed
 *  it. null when the flag is off, the patch is absent (shadow-patch.js didn't run), or the root is one it
 *  can't see (a declarative `shadowrootmode="closed"` or native root). */
export const capturedClosedRoot = (el: Element): ShadowRoot | null => {
    const w = window as unknown as { __mlPierceClosed?: boolean; __mlClosedRoots?: WeakMap<Element, ShadowRoot> };
    if (!w.__mlPierceClosed) return null;
    return w.__mlClosedRoots?.get(el) ?? null;
};

/** The shadow root the DOM tools should TRAVERSE for `el`: its OPEN root, or — when piercing is on — a
 *  captured CLOSED root. Makes captured closed roots first-class selector targets while the flag is set. */
export const traversableRoot = (el: Element): ShadowRoot | null => el.shadowRoot ?? capturedClosedRoot(el);

/**
 * One compact line for an element: tag#id.classes [data-*] "own text" (own text
 * only — never descendants' text or innerHTML). Shared by describeSkeleton and
 * the ancestors tool.
 *
 * @param {Element} el The element to describe.
 * @returns {string} A single descriptive line.
 */
export const elLine = (el: Element): string => {
    let seg = cssSegment(el, 6);
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
 * Skeleton tree of an element + descendants to a depth: elLine per node, indented.
 *
 * @param {Element} el The root element.
 * @param {number} depth How many descendant levels to expand.
 * @param {string} [indent=""] Current indentation prefix (used in recursion).
 * @returns {string} A newline-joined, indented skeleton.
 */
// `canLocate` tailors the CLOSED-shadow-root steer: true → suggest locate()/@pt; false → say it can't be
// reached (no locate tool); undefined → a natural-language "IF you have a locate tool" (safe default when the
// caller doesn't pass a ToolContext). Propagated through the recursion.
export const describeSkeleton = (el: Element, depth: number, indent = "", canLocate?: boolean): string => {
    let out = indent + elLine(el);
    if (el.children.length && depth > 0) {
        for (const k of [...el.children].slice(0, 12)) {
            out += "\n" + describeSkeleton(k, depth - 1, indent + "  ", canLocate);
        }
        if (el.children.length > 12) out += "\n" + indent + `  …(${el.children.length - 12} more)`;
    } else if (el.children.length) {
        // Depth exhausted here — flag that children exist so the model knows to
        // describeElement deeper instead of mistaking this for a leaf.
        out += ` › ${el.children.length} child${el.children.length === 1 ? "" : "ren"}`;
    }
    // Shadow root handling. `el.shadowRoot` is the OPEN root, or null for BOTH "closed" and "none" (there's
    // no non-destructive API to distinguish them). So: an OPEN root → flag it + show the tree (its contents
    // are the element's real content, not the empty light children — reachable via `<sel> >>> <inner>`). A
    // custom element (hyphenated tag) with NO open root and NO light children almost certainly has a CLOSED
    // root — steer to visual navigation, since selectors can't reach in.
    // OPEN root, or — when piercing is on — a CLOSED root the document_start patch captured. Both are
    // traversable and referenced with `>>>`, so they render the same tree; only the label differs.
    const sr = el.shadowRoot ?? capturedClosedRoot(el);
    if (sr) {
        const label = el.shadowRoot ? "(OPEN)" : "(CLOSED, pierced) — captured at page load, so it's reachable;";
        out += "\n" + indent + `  #shadow-root ${label} its contents are shown below; reference them with \`>>> <inner selector>\`.`;
        const shadowKids = [...sr.children];
        if (depth > 0) {
            for (const k of shadowKids.slice(0, 12)) out += "\n" + describeSkeleton(k, depth - 1, indent + "    ", canLocate);
            if (shadowKids.length > 12) out += "\n" + indent + `    …(${shadowKids.length - 12} more)`;
        } else if (shadowKids.length) {
            out += `\n${indent}  › ${shadowKids.length} element${shadowKids.length === 1 ? "" : "s"} inside the shadow root (describeElement deeper to expand)`;
        }
    } else if (el.tagName.includes("-") && !el.children.length) {
        const hostSel = clickSelector(el);   // the host is a light-DOM element → a normal selector
        const base = `\n${indent}  #shadow-root (CLOSED) — this Web Component has no light children and no OPEN ` +
            "root, so any controls it renders are in a CLOSED shadow root that selectors CANNOT reach. ";
        // Tailor the workaround to whether `locate` is actually wired this run (ctx.hasTool → canLocate).
        out += base + (canLocate === false
            ? "You have no `locate` tool, so you can't interact with a closed shadow root — say so rather than guessing a selector."
            : (canLocate === true ? "Find them visually scoped to this element — " : "IF you have a `locate` tool, ") +
              `locate({ description: "<how the control looks>", selector: "${hostSel}" }) — then click the @pt it returns.`);
    } else if (!el.children.length && !indent) {
        // No child elements and no shadow root. Say so at the ROOT (not every leaf of an expanded tree) so an
        // empty container — e.g. a collapsed/lazily-rendered table like #bigsales — reads as "empty" instead
        // of a bare, useless single line.
        out += " (no child elements)";
    }
    return out;
};

// Resolve a selector that MAY carry a jQuery/Sizzle/Playwright predicate the model
// reaches for but native `querySelectorAll` lacks:
//   • Playwright `text=Foo` engine (whole selector): match by visible text, keeping the
//     smallest/leaf-most element (so a click hits the button, not <body>).
//   • text — `:contains("x")` / `:has-text("x")`: peel OFF THE END, run the
//     (native) base, filter by textContent (case-insensitive, all required).
//   • positional — `:eq(n)` (jQuery, 0-based): peel and pick the nth match.
//   • `:nth-of-type(n)` / `:nth-child(n)` FALLBACK: native, but the model habitually
//     writes `.foo:nth-of-type(2)` meaning "the 2nd .foo"; native nth-of-type is
//     per-TAG and usually matches nothing. So run the literal selector first and
//     ONLY when it finds nothing, reinterpret a trailing nth as the 1-based nth
//     match of the base set. Correct native uses (non-empty) are never touched.
// Greedy prefixes so the LAST predicate peels first (chains like
// `.card:contains("a"):eq(0)`).
const TRAILING_TEXT_PSEUDO = /^([\s\S]*):(?:contains|has-text)\(\s*(['"]?)([\s\S]*?)\2\s*\)\s*$/i;
const TRAILING_EQ_PSEUDO = /^([\s\S]*):eq\(\s*(\d+)\s*\)\s*$/i;
const TRAILING_NTH_NATIVE = /^([\s\S]*):nth-(?:of-type|child)\(\s*(\d+)\s*\)\s*$/i;

/**
 * Query the document with the jQuery-tolerant selector dialect described above
 * (`:contains`/`:has-text`/`:eq`, plus the dead-`:nth-of-type` reinterpretation).
 *
 * @param {string} selector The (possibly predicate-carrying) selector.
 * @returns {Element[]} Matching elements, after peeling + applying predicates.
 */
/** querySelectorAll that PIERCES open shadow roots. Chrome's native querySelectorAll stops at shadow
 *  boundaries, so web-component content (Gemini's editor, many design systems) is invisible to a selector.
 *  Collects matches at `root` + recursively inside every OPEN shadowRoot (closed roots are unreachable by
 *  design), deduped. Reads the live DOM. */
export const deepQueryAll = (selector: string, root: ParentNode = document): Element[] => {
    const out: Element[] = [];
    const seen = new Set<Element>();
    const visit = (r: ParentNode): void => {
        try { for (const e of r.querySelectorAll(selector || "*")) if (!seen.has(e)) { seen.add(e); out.push(e); } } catch { /* invalid selector in this scope */ }
        for (const host of r.querySelectorAll("*")) {
            const sr = traversableRoot(host as Element);   // open root, or (when piercing is on) a captured closed root
            if (sr) visit(sr);
        }
    };
    visit(root);
    return out;
};

/** Count shadow roots for ORIENTATION — a model scanning the DOM may not realise shadow roots exist at all.
 *  `open` = REACHABLE roots (recursive, incl. nested) — open roots, PLUS captured closed roots when piercing
 *  is on (the DOM tools reach both). `closed` = a heuristic for Web Components whose content is an
 *  UNREACHABLE closed root (hyphenated tag, no light children, no open/captured root — visual-only). */
export const shadowRootStats = (root: ParentNode = document): { open: number; closed: number } => {
    let open = 0, closed = 0;
    const visit = (r: ParentNode): void => {
        for (const el of r.querySelectorAll("*")) {
            const e = el as Element;
            if (e.shadowRoot) { open++; visit(e.shadowRoot); continue; }
            const captured = capturedClosedRoot(e);   // piercing on + patch grabbed it → now reachable
            if (captured) { open++; visit(captured); continue; }
            if (e.tagName.includes("-") && !e.children.length) closed++;   // truly unreachable
        }
    };
    visit(root);
    return { open, closed };
};

/** The HOST selectors of UNREACHABLE closed-root Web Components — the ones a selector scan can't enter EVEN
 *  with piercing on (a captured closed root is reachable, so it's excluded here). A scanning tool appends
 *  these so the model knows a target it can't find may be sealed inside one (and can fall back to visual
 *  `locate`/@pt scoped to the host). Uses the same heuristic as shadowRootStats.closed. */
export const closedShadowHosts = (root: ParentNode = document, limit = 8): string[] => {
    const hosts: string[] = [];
    const visit = (r: ParentNode): void => {
        for (const el of r.querySelectorAll("*")) {
            const e = el as Element;
            if (e.shadowRoot) { visit(e.shadowRoot); continue; }
            const captured = capturedClosedRoot(e);
            if (captured) { visit(captured); continue; }   // pierced → reachable, don't nag; recurse for nested sealed ones
            if (e.tagName.includes("-") && !e.children.length && hosts.length < limit) hosts.push(clickSelector(e));
        }
    };
    visit(root);
    return hosts;
};

/** Resolve a shadow-CROSSING reference `hostSel >>> innerSel [>>> …]` (the inverse of clickSelector's `>>>`
 *  output): each `>>>` steps into the open shadowRoot of the previous segment's matches. */
const resolveShadowPath = (path: string): Element[] => {
    const segs = path.split(">>>").map(s => s.trim()).filter(Boolean);
    if (!segs.length) return [];
    let scopes: ParentNode[] = [document];
    for (let i = 0; i < segs.length; i++) {
        const matched: Element[] = [];
        for (const sc of scopes) { try { matched.push(...sc.querySelectorAll(segs[i])); } catch { /* skip a bad segment */ } }
        if (i === segs.length - 1) return matched;
        scopes = matched.map(e => traversableRoot(e)).filter((r): r is ShadowRoot => !!r);
        if (!scopes.length) return [];
    }
    return [];
};

export const queryAll = (selector: string): Element[] => {
    let base = String(selector).trim();
    if (base.includes(">>>")) return resolveShadowPath(base);   // a shadow-crossing reference
    const texts: string[] = [];
    let eqIndex: number | null = null;   // trailing :eq(n) → jQuery-style 0-based positional pick
    // Playwright's `text=Foo` / `text="Foo"` engine (a common model reflex): match by
    // visible text, case-insensitive substring. Playwright targets the SMALLEST element
    // with the text, so we run "*" + the text filter and keep only the leaf-most matches
    // (below) — otherwise every ancestor (body/…) would match and click the wrong thing.
    let deepest = false;
    const tm = /^text=\s*(['"]?)([\s\S]+?)\1\s*$/i.exec(base);
    if (tm) { texts.push(tm[2]); base = "*"; deepest = true; }
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
    const filterText = (els: Element[]): Element[] => {
        if (!texts.length) return els;
        const wanted = texts.map(normalizeText);
        return els.filter(el => { const tc = normalizeText(el.textContent); return wanted.every(w => tc.includes(w)); });
    };
    // Run a selector + any text filter, ALWAYS merging light DOM + open shadow roots (deepQueryAll includes
    // the light matches first, in document order). Merge — not a fallback-when-empty — because a text/tag can
    // legitimately match in BOTH the page chrome AND inside a component (the task text mentions "Display name"
    // while the real control is in a shadow root); the caller wants the shadow one too. On a shadow-free page
    // deepQueryAll returns exactly the light matches, so behaviour there is unchanged.
    const run = (sel: string): Element[] => {
        // Validate first: deepQueryAll swallows per-scope throws, but an INVALID selector must still error
        // (tools report "Invalid selector") rather than silently return 0 — native querySelectorAll throws here.
        document.querySelectorAll(sel || "*");
        return filterText(deepQueryAll(sel || "*"));
    };
    let els = run(base);
    // `text=` → keep only the deepest text carriers (drop matching ancestors), so a click
    // lands on the actual button, not <body>.
    if (deepest && els.length > 1) els = els.filter(el => !els.some(o => o !== el && el.contains(o)));
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
 * Turn a querySelector failure into a useful message. A text pseudo is only
 * supported at the END (queryAll peels it there) — so blame placement ONLY when a
 * `:contains`/`:has-text` genuinely survives mid-selector after peeling the trailing
 * ones. Otherwise the throw was something else (e.g. an unescaped Tailwind `/` in a
 * class) — surface the raw error instead of misdiagnosing it as a placement problem.
 *
 * @param {string} selector The selector that failed.
 * @param {Error} err The caught querySelector error.
 * @returns {string} A `Invalid selector: …` message to hand back to the model.
 */
export const selectorError = (selector: string, err: Error): string => {
    // Peel trailing text/eq pseudos exactly as queryAll does, then see if a text
    // predicate is still left mid-selector — that's the only real placement error.
    let base = String(selector).trim();
    for (let changed = true; changed; ) {
        changed = false;
        let m = base.match(TRAILING_EQ_PSEUDO);
        if (m) { base = m[1].trim(); changed = true; continue; }
        m = base.match(TRAILING_TEXT_PSEUDO);
        if (m) { base = m[1].trim(); changed = true; }
    }
    if (/:has-text\s*\(|:contains\s*\(/i.test(base)) {
        return "Invalid selector: :contains()/:has-text() text predicates are only supported at " +
            'the END of a selector (e.g. `div.card:contains("text")`). Move it to the final part, ' +
            "or use exec for a text filter.";
    }
    return `Invalid selector: ${err.message}`;
};

/** A page table → a structured `{ columns, rows }` for a pandas DataFrame, or `null` when the
 *  element isn't a clean table (no recognizable table/ARIA-grid, or it uses col/rowspans — the
 *  caller then falls back to pandas.read_html on its outerHTML). Case-preserving (unlike
 *  normalizeText): cell VALUES must survive verbatim for the df. Rows/cols capped so a wrong
 *  selector can't extract a runaway grid. Native `<table>` and ARIA `role=table/grid/treegrid`. */
const MAX_TABLE_ROWS = 5000, MAX_TABLE_COLS = 200;

/** Page `<table>`s that actually hold data — at least one `<td>` (a data cell), so a collapsed /
 *  header-only / lazily-rendered table (e.g. the empty `#bigsales`) is excluded. Shared by the
 *  python_exec `current` shorthand (which resolves to the SINGLE non-empty table when the page isn't
 *  a Google Sheet) and the tool description (which only advertises `current` when there's exactly one,
 *  or the page is a Sheet). Pure over the given root. */
export const nonEmptyTables = (root: Document | Element): HTMLTableElement[] =>
    (root && typeof root.querySelectorAll === "function")
        ? [...root.querySelectorAll("table")].filter(t => t.querySelector("td")) as HTMLTableElement[]
        : [];

/** Classify a candidate fixed/sticky element for the full-page stitch, from its viewport rect at
 *  two scroll positions. PINNED = the rect's top is invariant to scroll — a `position:fixed`
 *  element, or a `position:sticky` one that's currently STUCK — so it repeats in every captured
 *  tile and must be shown exactly ONCE. (A sticky element still flowing with content moves between
 *  the two probes, so it's NOT pinned and is left alone — it legitimately appears in one tile.)
 *  ANCHOR = which end of the stitch it belongs at (a top header vs a bottom footer), by its
 *  vertical centre. Pure (no DOM) so it's unit-testable; the rect-measuring + scroll probing +
 *  visibility toggling stay in injected.ts's browser-only `_stitchFullPage`. */
export function classifyOverlay(
    r0: { top: number; height: number },
    r1: { top: number },
    vh: number,
): { pinned: boolean; anchor: "top" | "bottom" } {
    return {
        pinned: Math.abs(r1.top - r0.top) < 2,                       // top unchanged across a scroll ⇒ pinned
        anchor: r0.top + r0.height / 2 < vh / 2 ? "top" : "bottom",  // centre in the top half ⇒ header, else footer
    };
}

const cellText = (c: Element): string => (c.textContent || "").replace(/\s+/g, " ").trim();
const hasSpans = (t: Element): boolean =>
    [...t.querySelectorAll("td,th,[role='cell'],[role='gridcell'],[role='columnheader']")]
        .some(c => parseInt(c.getAttribute("colspan") || "1", 10) > 1 || parseInt(c.getAttribute("rowspan") || "1", 10) > 1);

export function extractTable(el: Element): { columns: string[]; rows: string[][] } | null {
    const GRID = '[role="table"],[role="grid"],[role="treegrid"]';
    const table = el.matches("table") ? el
        : el.matches(GRID) ? el
        : el.querySelector("table") || el.querySelector(GRID);
    if (!table) return null;
    if (hasSpans(table)) return null;   // col/rowspans misalign a flat walk → let read_html handle it

    const cap = (rows: string[][]): { columns: string[]; rows: string[][] } | null => {
        if (!rows.length) return null;
        return { columns: [], rows: rows.slice(0, MAX_TABLE_ROWS).map(r => r.slice(0, MAX_TABLE_COLS)) };
    };

    if (table.matches("table")) {
        const trs = [...table.querySelectorAll("tr")];
        if (!trs.length) return null;
        let headerRow = table.querySelector("thead tr");
        let bodyRows = [...table.querySelectorAll("tbody tr")];
        if (!headerRow && trs[0].querySelector("th")) { headerRow = trs[0]; bodyRows = trs.slice(1); }
        if (!bodyRows.length) bodyRows = headerRow ? trs.filter(t => t !== headerRow) : trs;
        const out = cap(bodyRows.map(tr => [...tr.querySelectorAll("th,td")].map(cellText)));
        if (!out) return null;
        if (headerRow) out.columns = [...headerRow.querySelectorAll("th,td")].map(cellText).slice(0, MAX_TABLE_COLS);
        return out;
    }

    // ARIA grid: role=row holds columnheader / cell / gridcell.
    const rowEls = [...table.querySelectorAll('[role="row"]')];
    if (!rowEls.length) return null;
    const heads = (r: Element) => [...r.querySelectorAll('[role="columnheader"]')];
    const cells = (r: Element) => [...r.querySelectorAll('[role="cell"],[role="gridcell"]')];
    const hdr = rowEls.find(r => heads(r).length);
    const bodyEls = hdr ? rowEls.filter(r => r !== hdr) : rowEls;
    const out = cap(bodyEls.map(r => { const c = cells(r); return (c.length ? c : [...r.children]).map(cellText); }));
    if (!out) return null;
    if (hdr) out.columns = heads(hdr).map(cellText).slice(0, MAX_TABLE_COLS);
    return out;
}

/** Parse a table cell as a number, tolerating corporate formatting — thousands commas,
 *  currency ($€£¥), a trailing %, whitespace, and accounting parens ((150) → -150). Returns
 *  null when it isn't a clean int/decimal (names, alphanumeric IDs, blanks). Pure. */
export function parseNumericCell(v: string): number | null {
    let s = String(v == null ? "" : v).trim();
    if (!s) return null;
    const paren = /^\((.*)\)$/.exec(s);
    if (paren) s = "-" + paren[1];
    s = s.replace(/[,$€£¥%\s]/g, "");
    if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(s)) return null;   // int/decimal only — no "1e3"/"421A"/leading-word
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/** Auto-cast the NUMERIC columns of an extracted table so pandas infers int64/float64 (else
 *  every cell is a string and df.sum() string-CONCATENATES). Per column: if ≥90% of non-empty
 *  cells parse as numbers, coerce the whole column to number|null (blank/stray → null, pandas
 *  NaN); otherwise leave it as strings (names, and IDs/ZIPs where a leading zero would drop —
 *  pass tableRaw to skip casting for those). Returns a NEW rows array. Pure. */
export function castTableColumns(columns: string[], rows: string[][]): (string | number | null)[][] {
    const width = Math.max(columns.length, ...rows.map(r => r.length), 0);
    const out: (string | number | null)[][] = rows.map(r => r.slice());
    for (let c = 0; c < width; c++) {
        let nonEmpty = 0, numeric = 0;
        for (const r of rows) {
            const s = r[c] == null ? "" : String(r[c]).trim();
            if (!s) continue;
            nonEmpty++;
            if (parseNumericCell(s) != null) numeric++;
        }
        if (nonEmpty === 0 || numeric / nonEmpty < 0.9) continue;   // not a numeric column
        for (const r of out) {
            const s = r[c] == null ? "" : String(r[c]).trim();
            r[c] = s ? parseNumericCell(s) : null;   // non-numeric outlier → null (pandas NaN)
        }
    }
    return out;
}

/** A Google Sheets URL → its spreadsheet id (the stable `/d/<id>` key), or null if it isn't a
 *  Sheets URL. Used to cache a per-session access approval by the SPREADSHEET (its tabs share it). */
export const googleSheetId = (url: string): string | null => {
    const m = /^https?:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(String(url || ""));
    return m ? m[1] : null;
};

/** Every EXTERNAL Google Sheet (a Sheets URL that isn't 'current') a python_exec call touches —
 *  whether its `tables` arg is a single source string OR a map of them — as spreadsheet ids. Reading
 *  arbitrary Google data the user didn't navigate to is privileged, so these drive the approval
 *  escalation + the auto-approve decision. Pure; shared by the page loop and the (design-A) background
 *  auto-approve so both agree on "which sheets need consent". */
export const externalSheetIds = (args: unknown): string[] => {
    const t = (args as { tables?: unknown } | null)?.tables;
    const vals: unknown[] = typeof t === "string" ? [t] : (t && typeof t === "object") ? Object.values(t as Record<string, unknown>) : [];
    return vals
        .filter((v): v is string => typeof v === "string" && v !== "current")
        .map(v => googleSheetId(v))
        .filter((id): id is string => !!id);
};

/** A Google Sheets URL → its CSV export URL (fetched credentialed → the user's own data),
 *  or null if it isn't a Sheets URL. Pulls the spreadsheet id + the gid (the specific tab,
 *  default 0). Pure — the CSV then flows through the same parse→auto-cast→df path as `table`. */
export const googleSheetCsvUrl = (url: string): string | null => {
    const id = googleSheetId(url);
    if (!id) return null;
    const gid = /[#?&]gid=([0-9]+)/.exec(url);
    return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid ? gid[1] : "0"}`;
};

/** Parse RFC-4180 CSV → an array of rows (each an array of string cells). Handles quoted
 *  fields with embedded commas, newlines, and doubled "" quotes. Pure. */
export function parseCsv(text: string): string[][] {
    const s = String(text == null ? "" : text).replace(/\r\n?/g, "\n");
    const rows: string[][] = []; let row: string[] = [], field = "", inQ = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inQ) {
            if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
            else field += c;
        } else if (c === '"') inQ = true;
        else if (c === ",") { row.push(field); field = ""; }
        else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
        else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
}

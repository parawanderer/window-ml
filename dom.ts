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
    const esc = cssEsc;
    const uniq = (sel: string): boolean => { try { const m = document.querySelectorAll(sel); return m.length === 1 && m[0] === target; } catch { return false; } };
    const idUnique = (el: Element) => !!el.id && (() => { try { return document.querySelectorAll("#" + esc(el.id)).length === 1; } catch { return false; } })();
    if (idUnique(target)) return "#" + esc(target.id);
    const parts: string[] = [];
    let el: Element | null = target, hops = 0;
    while (el && el.nodeType === 1 && el !== document.documentElement && hops < 12) {
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
export const describeSkeleton = (el: Element, depth: number, indent = ""): string => {
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

// Resolve a selector that MAY carry a jQuery/Sizzle/Playwright predicate the model
// reaches for but native `querySelectorAll` lacks:
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
export const queryAll = (selector: string): Element[] => {
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

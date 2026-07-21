// Pure DOM / string utilities used across injected.js — path building, the
// jQuery-tolerant query engine, skeleton descriptions, text normalization. No
// dependency on injected's closure state; only args + browser globals.

export const truncate = (str: string, n: number): string => {
    str = String(str == null ? "" : str).replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n) + "…" : str;
};

// Extract error text from a caught throw. Background tasks reject with a plain
// STRING (not an Error), so `e.message` would be undefined — fall back to String.
export const errText = (e: unknown): string => (e && (e as Error).message) ? (e as Error).message : String(e);

// Compact structural path for an element: body > div#main > div.card > h2.title —
// tag + id + up to 4 classes per ancestor, capped at 8 hops. A DESCRIPTION (shows
// classes so the model sees structure), not necessarily a valid selector — for a
// clickable selector use clickSelector.
export const elPath = (el: Element): string => {
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
export const normalizeText = (s: string | null | undefined): string => (s || "")
    .normalize("NFKC")
    .replace(/[‐-―−⁃﹘﹣－]/g, "-")   // hyphens/dashes/minus → -
    .replace(/[‘’‚‛′]/g, "'")               // curly / prime single quotes → '
    .replace(/[“”„‟″]/g, '"')               // curly / prime double quotes → "
    .replace(/\s+/g, " ").trim().toLowerCase();

// Shortest VALID, unique CSS selector for an element — for lists whose selectors
// are meant to be CLICKED (interactives). Prefers a unique id (own or ancestor);
// else `tag:nth-of-type(n)` walking UP only until unique. Avoids elPath's giant,
// un-escapable Tailwind-class chains. Falls through to a best-effort path.
export const clickSelector = (target: Element): string => {
    const esc = (s: string) => typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s;
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

// One compact line for an element: tag#id.classes [data-*] "own text" (own text
// only — never descendants' text or innerHTML). Shared by describeSkeleton and
// the ancestors tool.
export const elLine = (el: Element): string => {
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

// Skeleton tree of an element + descendants to a depth: elLine per node, indented.
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

// Turn a querySelector failure into a useful message: if the model used a text
// pseudo-selector mid-selector (queryAll only supports it at the END), say so;
// otherwise surface the raw error.
export const selectorError = (selector: string, err: Error): string => {
    if (/:has-text\s*\(|:contains\s*\(/i.test(selector)) {
        return "Invalid selector: :contains()/:has-text() text predicates are only supported at " +
            'the END of a selector (e.g. `div.card:contains("text")`). Move it to the final part, ' +
            "or use exec for a text filter.";
    }
    return `Invalid selector: ${err.message}`;
};

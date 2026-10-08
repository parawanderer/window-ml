// settings-search.ts — filtering the Settings panel down to the rows that match a query, across every tab at once.
//
// Settings is the SUPERSET of every user-editable flag (AGENTS.md), which is exactly why it stopped being scannable:
// the flag you are looking for is the one you cannot name the tab of. So the search renders every tab and this hides
// what does not match, working on the DOM the panel already draws rather than on a second description of its rows
// that would drift from them.
//
// What counts as ONE row: a `.set-field` (or any element) together with the help text that follows it — a
// `.set-hint`, `.set-err`, `.set-warn` or `.set-moot` sitting after a field belongs to that field, so a query can match
// what a flag DOES and not only what it is called. A row matches when every word of the query appears in its text, its
// section's title or its tab's name. A section whose title matches shows whole.

/** The help text that explains the element before it rather than standing alone. */
const TRAILING = ".set-hint, .set-err, .set-warn, .set-moot";

/** The class that hides a non-matching element. A class, not `hidden`: rows set their own `display`, which beats it. */
export const MISS = "set-miss";

/** The words of a query, lower-cased; empty when there is nothing to search for. */
export function queryWords(q: string): string[] {
    return q.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Does `text` contain every word? */
const hasAll = (text: string, words: string[]): boolean => {
    const t = text.toLowerCase();
    return words.every((w) => t.includes(w));
};

/** Split a container's children into rows: each element, plus the help text that follows it. */
function rowsOf(children: Element[]): Element[][] {
    const rows: Element[][] = [];
    for (const el of children) {
        if (el.matches(TRAILING) && rows.length) rows[rows.length - 1].push(el);
        else rows.push([el]);
    }
    return rows;
}

/** Show or hide a whole row. */
const mark = (row: Element[], hit: boolean) => { for (const el of row) el.classList.toggle(MISS, !hit); };

/**
 * Filter the Settings body to the rows matching `q`, and return how many rows matched. Clears every mark when `q` is
 * empty. `root`'s direct children are tab headings (`.set-search-tab`, carrying the tab's name), sections
 * (`details.set-section` with a `summary`) and loose rows.
 */
export function filterSettings(root: Element, q: string): number {
    const words = queryWords(q);
    for (const el of Array.from(root.querySelectorAll(`.${MISS}`))) el.classList.remove(MISS);
    if (!words.length) return 0;
    let tabName = "", hits = 0;
    let heading: Element | null = null, headingHits = 0;
    const closeHeading = () => { if (heading) heading.classList.toggle(MISS, headingHits === 0); };
    const rows = rowsOf(Array.from(root.children));
    for (const row of rows) {
        const el = row[0];
        if (el.matches(".set-search-tab")) {
            closeHeading();
            heading = el; headingHits = 0; tabName = el.textContent ?? "";
            continue;
        }
        if (el.matches("details.set-section")) {
            const title = el.querySelector(":scope > summary")?.textContent ?? "";
            const inner = rowsOf(Array.from(el.children).filter((c) => c.tagName !== "SUMMARY"));
            let n = 0;
            if (hasAll(`${tabName} ${title}`, words)) n = inner.length;   // the section is what was asked for
            else for (const r of inner) {
                const hit = hasAll(`${tabName} ${title} ${r.map((x) => x.textContent).join(" ")}`, words);
                mark(r, hit);
                if (hit) n++;
            }
            mark(row, n > 0);
            hits += n; headingHits += n;
            continue;
        }
        const hit = hasAll(`${tabName} ${row.map((x) => x.textContent).join(" ")}`, words);
        mark(row, hit);
        if (hit) { hits++; headingHits++; }
    }
    closeHeading();
    return hits;
}

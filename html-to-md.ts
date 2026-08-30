// HTML → Markdown for the `fetch_url` tool. A fetched HTML page is mostly slop to a reading model —
// scripts, styles, nav/chrome, deeply-nested divs — so by default we distil it to clean Markdown (headings,
// links, lists, tables survive; the noise doesn't). Turndown is the off-the-shelf converter; it needs a DOM,
// which it has in the page main world (injected.js runs there) and, for unit tests, via its bundled domino.
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";   // GFM tables + strikethrough + task lists (a data page's tables matter to a reader)

// Pure NOISE — elements that either can't contribute readable text (script/style/svg/…) or are page CHROME
// (nav/header/footer/aside), stripped before conversion so the Markdown is the page's CONTENT. A page that
// buried real content in one of these is recoverable: the caller re-runs fetch_url with `raw: true`.
const STRIP = [
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
    "link", "meta", "head", "title", "nav", "header", "footer", "aside",
];

let service: TurndownService | null = null;
function get(): TurndownService {
    if (service) return service;
    service = new TurndownService({
        headingStyle: "atx",          // # Heading, not the underline style — compact and unambiguous
        codeBlockStyle: "fenced",     // ```lang fences, not indented blocks
        bulletListMarker: "-",
        hr: "---",
        emDelimiter: "*",
        linkStyle: "inlined",
    });
    service.use(gfm);   // tables/strikethrough/task-lists survive as GFM instead of collapsing to linear text
    service.remove(STRIP as unknown as TurndownService.Filter);
    return service;
}

/** Convert an HTML document/fragment string to clean Markdown for a reading model: strip scripts/nav/chrome,
 *  emit ATX headings + fenced code, and collapse the runs of blank lines Turndown leaves behind. Never throws
 *  on malformed HTML (the parser is lenient); returns "" for empty input. */
export function htmlToMarkdown(html: string): string {
    if (!html || !html.trim()) return "";
    let md: string;
    try { md = get().turndown(html); }
    catch { return html; }   // conversion failed for some odd input → fall back to the raw HTML, never lose the content
    return md.replace(/\n{3,}/g, "\n\n").trim();
}

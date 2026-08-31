// HTML → Markdown for the `fetch_url` tool. A fetched HTML page is mostly slop to a reading model —
// scripts, styles, nav/chrome, deeply-nested divs — so by default we distil it to clean Markdown (headings,
// links, lists, tables survive; the noise doesn't). Turndown is the off-the-shelf converter; it needs a DOM,
// which it has in the page main world (injected.js runs there) and, for unit tests, via its bundled domino.
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";   // GFM tables + strikethrough + task lists (a data page's tables matter to a reader)

// Pure NOISE — elements that can't contribute readable text (script/style/svg/head/…), ALWAYS stripped.
const NOISE = [
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "embed",
    "link", "meta", "head", "title",
];
// Page CHROME — nav/header/footer/aside. Stripped by DEFAULT (the content is what a reader wants), but KEPT
// when the caller asks for everything (`stripChrome: false` → navigate's `verify: "text-all"`).
const CHROME = ["nav", "header", "footer", "aside"];

const services: Partial<Record<"strip" | "all", TurndownService>> = {};
function get(stripChrome: boolean): TurndownService {
    const key = stripChrome ? "strip" : "all";
    if (services[key]) return services[key]!;
    const service = new TurndownService({
        headingStyle: "atx",          // # Heading, not the underline style — compact and unambiguous
        codeBlockStyle: "fenced",     // ```lang fences, not indented blocks
        bulletListMarker: "-",
        hr: "---",
        emDelimiter: "*",
        linkStyle: "inlined",
    });
    service.use(gfm);   // tables/strikethrough/task-lists survive as GFM instead of collapsing to linear text
    service.remove([...NOISE, ...(stripChrome ? CHROME : [])] as unknown as TurndownService.Filter);
    services[key] = service;
    return service;
}

/** Convert an HTML document/fragment string to clean Markdown for a reading model: strip scripts (+ page
 *  chrome unless `stripChrome: false`), emit ATX headings + fenced code, and collapse the runs of blank lines
 *  Turndown leaves. Never throws on malformed HTML (the parser is lenient); returns "" for empty input. */
export function htmlToMarkdown(html: string, opts: { stripChrome?: boolean } = {}): string {
    if (!html || !html.trim()) return "";
    let md: string;
    try { md = get(opts.stripChrome !== false).turndown(html); }
    catch { return html; }   // conversion failed for some odd input → fall back to the raw HTML, never lose the content
    return md.replace(/\n{3,}/g, "\n\n").trim();
}

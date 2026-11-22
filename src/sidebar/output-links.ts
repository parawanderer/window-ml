// output-links.ts — which parts of a line of tool output become clickable http(s) links, and which stay text.

/** The longest URL, in characters, that is made a link. A longer one stays text: a link is a thing to judge before
 *  clicking, and nobody judges two kilobytes. */
export const MAX_LINK_CHARS = 2048;

/** A link found in a line: what was printed, where it goes, and the host the browser itself will connect to. */
export interface OutputLink {
    /** the characters as printed, which the anchor shows */
    text: string;
    /** the normalised address (`URL.href`), which the anchor opens */
    url: string;
    /** `URL.hostname`: punycode for an internationalised name, never the printed text */
    host: string;
}

// A candidate runs to whitespace, a quote, a backtick or an angle bracket. It must not start inside a word, so
// `xhttps://` is not one.
const CANDIDATE = /(?<![A-Za-z0-9])https?:\/\/[^\s"'`<>]+/gi;
// Format characters (\p{Cf} covers the zero-width and bidi controls), the explicit ranges for the ones that matter
// most, and anything outside printable ASCII in the host part.
const FORMAT = /[\p{Cf}​-‏‪-‮⁦-⁩]/u;
const NON_ASCII = /[^\x21-\x7e]/;
// A C0 control or DEL anywhere: it draws nothing, so the shown address and the opened one would differ by it.
const CONTROL = /[\x00-\x1f\x7f]/;
const TRAILING = new Set([".", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"']);
const PAIR: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Strip the punctuation a sentence puts after a URL, keeping a closer that a bracket INSIDE the URL opened. */
function trimTrailing(s: string): string {
    let end = s.length;
    while (end > 0 && TRAILING.has(s[end - 1])) {
        const c = s[end - 1], open = PAIR[c];
        if (open) {
            const body = s.slice(0, end);
            const opens = body.split(open).length - 1, closes = body.split(c).length - 1;
            if (closes <= opens) break;
        }
        end--;
    }
    return s.slice(0, end);
}

/** One printed candidate as a link, or null when it must stay text: another scheme's remainder, userinfo, a host
 *  with non-ASCII, bidi-control or zero-width characters, a parse failure, an over-long address. */
function asLink(raw: string): OutputLink | null {
    if (raw.length > MAX_LINK_CHARS || FORMAT.test(raw) || CONTROL.test(raw) || raw.includes("\\")) return null;
    const authority = raw.slice(raw.indexOf("//") + 2).split(/[/?#]/, 1)[0];
    if (!authority || authority.includes("@") || NON_ASCII.test(authority)) return null;
    let u: URL;
    try { u = new URL(raw); } catch { return null; }
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !u.hostname) return null;
    return { text: raw, url: u.href, host: u.hostname };
}

/**
 * Split one line of tool output into plain text and http(s) links, in order. Only `http://` and `https://` qualify;
 * a URL with userinfo, a non-ASCII or invisible-format character, an unparseable one or one past
 * {@link MAX_LINK_CHARS} stays text, so a program cannot print a look-alike address that reads as one host and goes
 * to another. A line with no link comes back as `[line]`, the very string.
 */
export function outputLinks(line: string): Array<string | OutputLink> {
    if (!line.includes("://")) return [line];
    const out: Array<string | OutputLink> = [];
    let at = 0, plain = "";
    for (const m of line.matchAll(CANDIDATE)) {
        const raw = trimTrailing(m[0]);
        const link = asLink(raw);
        if (!link) continue;
        plain += line.slice(at, m.index);
        if (plain) out.push(plain);
        plain = "";
        out.push(link);
        at = m.index + raw.length;
    }
    if (!out.length) return [line];
    plain += line.slice(at);
    if (plain) out.push(plain);
    return out;
}

/** Does this text hold at least one link {@link outputLinks} would draw? */
export function hasOutputLink(text: string): boolean {
    if (!text.includes("://")) return false;
    return text.split("\n").some((l) => outputLinks(l).some((s) => typeof s !== "string"));
}

/** The tooltip for a link: the HOST first, then the address cut to a readable length. */
export function outputLinkTip(link: OutputLink): string {
    const cut = link.url.length > 80 ? link.url.slice(0, 80) + "…" : link.url;
    return `Opens ${link.host} in a new tab · ${cut}`;
}

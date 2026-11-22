// files-hide.ts — the rule for which files of a session's browser copy are held unreadable: the built-in defaults, `hide` and `show` entries, and which entry wins.

/** Whether an entry holds what it matches (`hide`) or releases a hold on it (`show`). */
export type HideEffect = "hide" | "show";

/** One `hide` or `show` policy of the files consumer: its id, effect, path or glob, and the layer (session or global) it is stored in. */
export interface HideEntry {
    id: string;
    effect: HideEffect;
    source: string;
    layer: "session" | "global";
}

/** A built-in default as the layer rule sees it: an id and the lowest layer, never above an entry. */
interface DefaultRef {
    id: string;
    layer: "default";
}

/** The longest pattern an entry may have, in characters. */
export const HIDE_PATTERN_MAX = 512;

/** The most entries one scope (session or global) may hold. */
export const HIDE_ENTRIES_MAX = 256;

// --- glob tokens ---

type Tok = { k: "lit"; c: string } | { k: "any" } | { k: "one" } | { k: "cls"; neg: boolean; ranges: [number, number][] };

/** Parses one path segment into glob tokens, and says whether a `[` was left unclosed (that `[` is then a literal). */
function parseSeg(seg: string): { toks: Tok[]; unclosed: boolean } {
    const chars = Array.from(seg);
    const toks: Tok[] = [];
    let unclosed = false;
    let i = 0;
    while (i < chars.length) {
        const c = chars[i];
        if (c === "*") {
            toks.push({ k: "any" });
            i++;
        } else if (c === "?") {
            toks.push({ k: "one" });
            i++;
        } else if (c === "[") {
            let j = i + 1;
            let neg = false;
            if (chars[j] === "!" || chars[j] === "^") {
                neg = true;
                j++;
            }
            const start = j;
            if (chars[j] === "]") j++; // a ] first in the class is a literal member
            while (j < chars.length && chars[j] !== "]") j++;
            if (j >= chars.length) {
                unclosed = true;
                toks.push({ k: "lit", c });
                i++;
            } else {
                const body = chars.slice(start, j);
                const ranges: [number, number][] = [];
                for (let m = 0; m < body.length; ) {
                    const lo = body[m].codePointAt(0)!;
                    if (body[m + 1] === "-" && m + 2 < body.length) {
                        ranges.push([lo, body[m + 2].codePointAt(0)!]);
                        m += 3;
                    } else {
                        ranges.push([lo, lo]);
                        m++;
                    }
                }
                toks.push({ k: "cls", neg, ranges });
                i = j + 1;
            }
        } else {
            toks.push({ k: "lit", c });
            i++;
        }
    }
    return { toks, unclosed };
}

/** Whether one single-character token accepts the character. */
function accepts(t: Tok, ch: string): boolean {
    if (t.k === "lit") return t.c === ch;
    if (t.k === "one") return true;
    if (t.k === "cls") {
        const cp = ch.codePointAt(0)!;
        const inside = t.ranges.some(([lo, hi]) => cp >= lo && cp <= hi);
        return inside !== t.neg;
    }
    return false;
}

/** Whether one segment pattern matches one segment, by a dynamic program over tokens and characters. */
function segMatch(pattern: string, seg: string): boolean {
    const toks = parseSeg(pattern).toks;
    const s = Array.from(seg);
    let cur: boolean[] = new Array(s.length + 1).fill(false);
    cur[0] = true;
    for (const t of toks) {
        const next: boolean[] = new Array(s.length + 1).fill(false);
        if (t.k === "any") {
            next[0] = cur[0];
            for (let j = 1; j <= s.length; j++) next[j] = cur[j] || next[j - 1];
        } else {
            for (let j = 1; j <= s.length; j++) next[j] = cur[j - 1] && accepts(t, s[j - 1]);
        }
        cur = next;
    }
    return cur[s.length];
}

/** Whether a glob matches a path, segment by segment: `*`, `?` and `[...]` stay inside one `/` segment, case-sensitive, with no regex built from the pattern. */
export function globMatch(pattern: string, path: string): boolean {
    const p = pattern.split("/");
    const s = path.split("/");
    if (p.length !== s.length) return false;
    for (let i = 0; i < p.length; i++) if (!segMatch(p[i], s[i])) return false;
    return true;
}

// --- refusing a pattern ---

const CREDENTIAL_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store", "Keychains"];
const CREDENTIAL_CONFIG_DIRS = ["gcloud", "gh"];

/** The reason an entry's pattern is refused, or undefined when it is fine: empty, too long, not absolute, `**`, a dot or empty segment, an unclosed `[`, a control character, and for a `show` one that could release a credential directory. */
export function patternRefusal(source: string, effect: HideEffect): string | undefined {
    if (source.length === 0) return "the pattern is empty";
    if (source.length > HIDE_PATTERN_MAX) return `the pattern is longer than ${HIDE_PATTERN_MAX} characters`;
    if (/[\u0000-\u001f\u007f]/.test(source)) return "the pattern holds a control character";
    if (!source.startsWith("/")) return "the pattern must be an absolute path starting with /";
    if (source.includes("**")) return "** is not supported (a pattern matches within one path segment)";
    const segs = source.split("/").slice(1);
    for (const seg of segs) {
        if (seg === "") return "the pattern has an empty segment or a trailing /";
        if (seg === "." || seg === "..") return `the pattern has a "${seg}" segment`;
        if (parseSeg(seg).unclosed) return "the pattern has an unclosed [";
    }
    if (effect === "show") {
        // A directory segment that could BE a credential directory, or a last segment that names one literally: a show
        // releases what is inside it. A last-segment glob (`*.txt`, `*`) names files, so it is not read as the directory.
        for (const [i, seg] of segs.entries()) {
            const last = i === segs.length - 1;
            for (const dir of CREDENTIAL_DIRS) {
                if (last ? seg === dir : segMatch(seg, dir)) return `a show cannot release ${dir} (a credential directory)`;
            }
        }
        for (let i = 0; i + 1 < segs.length; i++) {
            if (!segMatch(segs[i], ".config")) continue;
            for (const d of CREDENTIAL_CONFIG_DIRS) {
                if (i + 2 === segs.length ? segs[i + 1] === d : segMatch(segs[i + 1], d)) return `a show cannot release .config/${d} (a credential directory)`;
            }
        }
    }
    return undefined;
}

// --- specificity ---

/** How specific a pattern is, as [no glob character (1) or some (0), segment count, literal character count], compared lexicographically, bigger meaning more specific. */
export function specificity(source: string): [number, number, number] {
    const segs = source.split("/");
    let glob = false;
    let lits = 0;
    for (const seg of segs) {
        for (const t of parseSeg(seg).toks) {
            if (t.k === "lit") lits++;
            else glob = true;
        }
    }
    return [glob ? 0 : 1, segs.length, lits];
}

/** Compares two patterns by `specificity`: positive when the first is more specific, negative when the second is, 0 when they tie. */
export function moreSpecific(a: string, b: string): number {
    const x = specificity(a);
    const y = specificity(b);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
}

// --- the defaults ---

/** The built-in holds, with the stable ids a `show` names and the view shows as overridden; `default:link-target` and `default:linked-template` never match in the browser copy, which has no symlinks. */
export const DEFAULT_HOLDS: readonly { id: string; label: string }[] = [
    { id: "default:dotenv", label: ".env and .env.* files, but the templates" },
    { id: "default:credential-files", label: ".netrc, .git-credentials and .pgpass at a root's top" },
    { id: "default:link-target", label: "the file a held name's symlink resolves to" },
    { id: "default:linked-template", label: "a template a held name resolves to" },
];

/** The dotenv names that are templates and so are not held by `default:dotenv`. */
export const DOTENV_TEMPLATES = [".env.example", ".env.sample", ".env.template"];

const CREDENTIAL_FILES = [".netrc", ".git-credentials", ".pgpass"];

/** Whether a path's parent directory is a root of the browser copy: `/files/agent` or `/files/attached/<handle>`. */
function isRootDir(dir: string): boolean {
    if (dir === "/files/agent") return true;
    const m = /^\/files\/attached\/([^/]+)$/.exec(dir);
    return m !== null;
}

/** The id of the default that holds a path, or undefined: dotenv by last component, credential files at a root's top; the two link defaults never hold anything in the browser copy, which has no symlinks. */
export function defaultHold(path: string): string | undefined {
    const at = path.lastIndexOf("/");
    const name = path.slice(at + 1);
    const dir = at <= 0 ? "" : path.slice(0, at);
    if ((name === ".env" || name.startsWith(".env.")) && !DOTENV_TEMPLATES.includes(name)) return "default:dotenv";
    if (CREDENTIAL_FILES.includes(name) && isRootDir(dir)) return "default:credential-files";
    return undefined;
}

// --- which entry wins ---

/** Decides whether a path is hidden: layers read from the top (session, global, defaults), the first layer with a matching entry decides, the most specific entry wins within it and a tie hides; `by` is the deciding id, and a refused entry is ignored. */
export function resolveHidden(path: string, entries: readonly HideEntry[]): { hidden: boolean; by: string | undefined } {
    for (const layer of ["session", "global"] as const) {
        let best: HideEntry | undefined;
        for (const e of entries) {
            if (e.layer !== layer) continue;
            if (patternRefusal(e.source, e.effect) !== undefined) continue;
            if (!globMatch(e.source, path)) continue;
            if (best === undefined) {
                best = e;
                continue;
            }
            const c = moreSpecific(e.source, best.source);
            if (c > 0 || (c === 0 && e.effect === "hide" && best.effect === "show")) best = e;
        }
        if (best !== undefined) return { hidden: best.effect === "hide", by: best.id };
    }
    const d = defaultHold(path);
    if (d !== undefined) return { hidden: true, by: d };
    return { hidden: false, by: undefined };
}

/** Whether the first entry decides over the second on a path both match: session over global over default, then more specific, then `hide` over `show`; two equal entries and any default over anything give false. */
export function beats(a: HideEntry | DefaultRef, b: HideEntry | DefaultRef): boolean {
    const rank = (x: HideEntry | DefaultRef) => (x.layer === "session" ? 2 : x.layer === "global" ? 1 : 0);
    if (rank(a) !== rank(b)) return rank(a) > rank(b);
    if (a.layer === "default" || b.layer === "default") return false;
    const c = moreSpecific(a.source, b.source);
    if (c !== 0) return c > 0;
    return a.effect === "hide" && b.effect === "show";
}

// --- overlap ---

/** Whether two single-character tokens could accept a common character; two classes count as overlapping unless provably disjoint. */
function compatible(a: Tok, b: Tok): boolean {
    if (a.k === "lit") return accepts(b, a.c);
    if (b.k === "lit") return accepts(a, b.c);
    if (a.k === "one" || b.k === "one") return true;
    if (a.k === "cls" && b.k === "cls" && !a.neg && !b.neg) {
        return a.ranges.some(([l1, h1]) => b.ranges.some(([l2, h2]) => l1 <= h2 && l2 <= h1));
    }
    return true;
}

/** Whether two segment patterns could match a common string, by a reachability program over both token lists. */
function segOverlap(a: string, b: string): boolean {
    const x = parseSeg(a).toks;
    const y = parseSeg(b).toks;
    const n = x.length;
    const m = y.length;
    const seen: boolean[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(false));
    const stack: [number, number][] = [[0, 0]];
    seen[0][0] = true;
    const go = (i: number, j: number) => {
        if (!seen[i][j]) {
            seen[i][j] = true;
            stack.push([i, j]);
        }
    };
    while (stack.length > 0) {
        const [i, j] = stack.pop()!;
        if (i === n && j === m) return true;
        const ta = i < n ? x[i] : undefined;
        const tb = j < m ? y[j] : undefined;
        if (ta?.k === "any") {
            go(i + 1, j); // the star matches nothing more
            if (tb !== undefined) go(i, j + 1); // the star absorbs the other side's token
        }
        if (tb?.k === "any") {
            go(i, j + 1);
            if (ta !== undefined) go(i + 1, j);
        }
        if (ta !== undefined && tb !== undefined && ta.k !== "any" && tb.k !== "any" && compatible(ta, tb)) go(i + 1, j + 1);
    }
    return false;
}

/** Whether some path could match both globs: the same segment count, and in each segment a string both match (conservatively true for two classes not provably disjoint). */
export function patternsOverlap(a: string, b: string): boolean {
    const p = a.split("/");
    const q = b.split("/");
    if (p.length !== q.length) return false;
    for (let i = 0; i < p.length; i++) if (!segOverlap(p[i], q[i])) return false;
    return true;
}

/** Whether a pattern could match something the named default holds, so a `show` of it must name that default; the link defaults give false since the browser copy has no symlinks. */
export function overlapsDefault(source: string, defaultId: string): boolean {
    if (defaultId === "default:dotenv") {
        const last = source.slice(source.lastIndexOf("/") + 1);
        if (DOTENV_TEMPLATES.includes(last)) return false;
        return segOverlap(last, ".env") || segOverlap(last, ".env.*");
    }
    if (defaultId === "default:credential-files") {
        for (const name of CREDENTIAL_FILES) {
            if (patternsOverlap(source, `/files/agent/${name}`) || patternsOverlap(source, `/files/attached/*/${name}`)) return true;
        }
        return false;
    }
    return false;
}

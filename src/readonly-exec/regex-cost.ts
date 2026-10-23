// regex-cost.ts — an upper bound on the work one native regex search does over one input, so that a host call
// whose backtracking is polynomial in the input (`/a+b/` on a long run of "a") is charged before it runs.

import { STEP_BUDGET } from "./limits";

/** The most steps a search may cost for a caller that has no budget to charge it to (a run's own `dereference` pipe, a
 *  `jsonPath` outside the dialect): one survey's whole budget, about a second. Over it, the search is refused. */
export const UNCHARGED_SEARCH_STEPS = STEP_BUDGET;

/** Bound units (see {@link regexWork}) that cost one evaluation step. Measured (Node 22 and 26, M-series laptop) over
 *  twenty worst-case shapes, each on the input that makes it backtrack most (`a+b`, `a*a*b`, `.*b.*c`, `a{1,5000}b`,
 *  `(?=a+b)`, `(a*)\1b`, alternation, `i`/`u` flags, `split`, `replace`, lookbehind, a long literal tail), then over
 *  random patterns that pass `riskyRegex` on inputs of 2 million characters: with counted repeats weighted
 *  ({@link COUNTED_LOOP_WEIGHT}) the slowest is about 0.44 ns a unit, so at ~3.2M steps a second 713 units a step would
 *  hold; 512 leaves 1.39x. The measurements, and how to re-run them: `notebooks/readonly/regex-cost.ipynb`. */
export const REGEX_UNITS_PER_STEP = 512;

/** How much more a step of a COUNTED repeat (`{m,n}` with a finite n) costs than one of `*` or `+`: V8 keeps a counter
 *  for it. Measured at scale: `[ab]{2,300}c` with `gi` 1.29 ns a unit unweighted, `a{0,500}a{0,500}b` 1.03, against 0.4 for
 *  the unbounded shapes. */
const COUNTED_LOOP_WEIGHT = 3;

type Node =
    | { t: "char"; src: string }
    | { t: "assert" }
    | { t: "caret" }
    | { t: "backref" }
    | { t: "seq"; items: Node[] }
    | { t: "alt"; branches: Node[] }
    | { t: "group"; body: Node; capture: boolean }
    | { t: "look"; body: Node }
    | { t: "q"; atom: Node; min: number; max: number };

/** A regex source as the small tree the bound walks, or null when it holds syntax this reader does not know (a
 *  modifier group `(?i:…)`, say), which the caller then treats as unbounded. Atoms that consume one character (a
 *  literal, an escape, a class, `.`) keep their source, so a scan can find their runs with the same flags. */
function parse(src: string, flags: string): Node | null {
    const uv = flags.includes("u") || flags.includes("v");
    let i = 0;
    const fail = (): never => { throw new SyntaxError("regex-cost: unread syntax"); };
    const quant = (): { min: number; max: number } | null => {
        const c = src[i];
        let q: { min: number; max: number } | null = null;
        if (c === "*") { q = { min: 0, max: Infinity }; i++; }
        else if (c === "+") { q = { min: 1, max: Infinity }; i++; }
        else if (c === "?") { q = { min: 0, max: 1 }; i++; }
        else if (c === "{") {
            const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(i, i + 40));
            if (m) { q = { min: +m[1], max: m[2] === undefined ? +m[1] : m[3] === "" ? Infinity : +m[3] }; i += m[0].length; }
        }
        if (q && src[i] === "?") i++;   // lazy: the same choices, tried in the other order
        return q;
    };
    const atom = (): Node => {
        const c = src[i];
        if (c === "(") {
            i++;
            if (src[i] !== "?") { const body = alt(); if (src[i++] !== ")") fail(); return { t: "group", body, capture: true }; }
            const d = src[i + 1];
            let look = false, capture = false;
            if (d === ":") i += 2;
            else if (d === "=" || d === "!") { look = true; i += 2; }
            else if (d === "<" && (src[i + 2] === "=" || src[i + 2] === "!")) { look = true; i += 3; }
            else if (d === "<") { const e = src.indexOf(">", i); if (e < 0) fail(); i = e + 1; capture = true; }
            else fail();
            const body = alt();
            if (src[i++] !== ")") fail();
            return look ? { t: "look", body } : { t: "group", body, capture };
        }
        if (c === "[") {
            const s = i;
            let depth = 0;
            for (; i < src.length; i++) {
                if (src[i] === "\\") { i++; continue; }
                if (src[i] === "[") { if (depth === 0 || flags.includes("v")) depth++; }
                else if (src[i] === "]" && --depth === 0) break;
            }
            if (i >= src.length) fail();
            i++;
            return { t: "char", src: src.slice(s, i) };
        }
        if (c === "\\") {
            const s = i++;
            const d = src[i];
            if (d === undefined) fail();
            if (/[1-9]/.test(d)) { while (/\d/.test(src[i] ?? "")) i++; return { t: "backref" }; }
            if (d === "k" && src[i + 1] === "<") { const e = src.indexOf(">", i); if (e < 0) fail(); i = e + 1; return { t: "backref" }; }
            if (d === "b" || d === "B") { i++; return { t: "assert" }; }
            if ((d === "p" || d === "P" || d === "u") && src[i + 1] === "{" && uv) { const e = src.indexOf("}", i); if (e < 0) fail(); i = e + 1; }
            else if (d === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 1, i + 5))) i += 5;
            else if (d === "x" && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 1, i + 3))) i += 3;
            else if (d === "c" && /^[A-Za-z]$/.test(src[i + 1] ?? "")) i += 2;
            else i++;
            return { t: "char", src: src.slice(s, i) };
        }
        if (c === "^") { i++; return { t: "caret" }; }
        if (c === "$") { i++; return { t: "assert" }; }
        if (c === "*" || c === "+" || c === "?" || c === ")" || c === "|") fail();
        const s = i;
        i += uv && (src.codePointAt(i) ?? 0) > 0xffff ? 2 : 1;
        return { t: "char", src: src.slice(s, i) };
    };
    const seq = (): Node => {
        const items: Node[] = [];
        while (i < src.length && src[i] !== "|" && src[i] !== ")") {
            const a = atom();
            const q = quant();
            items.push(q ? { t: "q", atom: a, ...q } : a);
        }
        return { t: "seq", items };
    };
    const alt = (): Node => {
        const branches = [seq()];
        while (src[i] === "|") { i++; branches.push(seq()); }
        return branches.length === 1 ? branches[0] : { t: "alt", branches };
    };
    try {
        const tree = alt();
        return i === src.length ? tree : null;
    } catch { return null; }
}

/** The one-character atoms a node can consume, or null when it holds a backreference (which can consume anything). */
function charAtoms(n: Node, out: string[] = []): string[] | null {
    switch (n.t) {
        case "char": out.push(n.src); return out;
        case "backref": return null;
        case "seq": for (const x of n.items) if (!charAtoms(x, out)) return null; return out;
        case "alt": for (const x of n.branches) if (!charAtoms(x, out)) return null; return out;
        case "group": return charAtoms(n.body, out);
        case "q": return charAtoms(n.atom, out);
        default: return out;   // assertions and lookarounds consume nothing
    }
}

/**
 * An upper bound, in units of about one backtracking step, on the work one native search of `source`/`flags` does
 * over `input`: `test`, `exec`, `match`, `matchAll`, `search`, `replace` or `split`, with or without `g` (a global
 * search tries each start once, however many matches it finds). V8 has no match timeout, so this is the only place
 * that work can be priced.
 *
 * The bound. A search tries each START at most once. From one start, a node hands its continuation some number of
 * PATHS (the ways it can end) and costs some WORK: in a sequence an item runs once per path of everything before it, an
 * alternation is the sum of its branches, a lookaround is atomic (one path), and a quantifier over a one-path unit has
 * one path per iteration count it can stop at. That count is what makes the bound INPUT-AWARE: a unit can repeat only
 * along a run of characters it matches, so its iterations are capped by the longest such run in the input, found by a
 * linear scan (`(?:<atoms>)+`, which never backtracks, since nothing follows it). On prose, `\w+` runs a word; on a
 * million "a", `a+` runs a million, and `/a+b/` is quadratic. Starts are every position, or only those where an
 * unquantified first atom matches, or one (or one per line, with `m`) after a leading `^`, or one when sticky.
 *
 * A repeated unit that has more than one path on this input (`(a+)+` over a run of "a") is exponential and unbounded
 * here; `riskyRegex` refuses that shape on any input before a search is priced. So is syntax {@link parse} does not
 * read, such as a modifier group.
 * @param source the pattern's source
 * @param flags its flags
 * @param input the string it will search
 * @param charge called with the steps each run-scan costs BEFORE it scans, so the bound's own work is billed too
 * @param scanCharsPerStep characters of a scan that cost one step
 * @returns units of work, `Infinity` when unbounded
 */
export function regexWork(source: string, flags: string, input: string, charge?: (steps: number) => void, scanCharsPerStep = 256): number {
    const tree = parse(source, flags);
    if (!tree) return Infinity;
    const n = input.length;
    const scanFlags = [...flags].filter((f) => "iusv".includes(f)).join("") + "g";
    const runs = new Map<string, number>();
    const scan = (atoms: string[]): RegExp => {
        charge?.(Math.ceil((n * Math.max(1, atoms.length)) / scanCharsPerStep));
        return new RegExp(`(?:${atoms.join("|")})+`, scanFlags);
    };
    const longestRun = (atoms: string[] | null): number => {
        if (!atoms) return n;
        if (!atoms.length || !n) return 0;
        const key = atoms.join("\u0000");
        const known = runs.get(key);
        if (known !== undefined) return known;
        const re = scan(atoms);
        let best = 0;
        for (let m = re.exec(input); m; m = re.exec(input)) {
            if (m[0].length > best) best = m[0].length;
            if (!m[0].length) re.lastIndex++;
        }
        runs.set(key, best);
        return best;
    };
    // The longest a capture can be, for what a backreference compares: the sum over a sequence, the widest branch.
    const widest = (x: Node): number => {
        switch (x.t) {
            case "char": return 1;
            case "backref": return n;
            case "seq": return x.items.reduce((s, y) => s + widest(y), 0);
            case "alt": return Math.max(...x.branches.map(widest));
            case "group": return widest(x.body);
            case "q": return x.max === 0 ? 0 : Math.min(n, (x.max === 1 ? 1 : Math.min(x.max, longestRun(charAtoms(x.atom)))) * widest(x.atom));
            default: return 0;
        }
    };
    const captures: Node[] = [];
    const collect = (x: Node): void => {
        if (x.t === "group" && x.capture) captures.push(x.body);
        if (x.t === "seq") x.items.forEach(collect);
        else if (x.t === "alt") x.branches.forEach(collect);
        else if (x.t === "group" || x.t === "look") collect(x.body);
        else if (x.t === "q") collect(x.atom);
    };
    collect(tree);
    let backrefWork = -1;
    const cost = (x: Node): { paths: number; work: number } => {
        switch (x.t) {
            case "seq": {
                let paths = 1, work = 0;
                for (const y of x.items) { const c = cost(y); work += paths * c.work; paths *= c.paths; }
                return { paths, work };
            }
            case "alt": {
                let paths = 0, work = 0;
                for (const y of x.branches) { const c = cost(y); paths += c.paths; work += c.work; }
                return { paths, work };
            }
            case "group": return cost(x.body);
            case "look": return { paths: 1, work: cost(x.body).work };
            case "backref":
                if (backrefWork < 0) backrefWork = 1 + Math.max(0, ...captures.map(widest));
                return { paths: 1, work: backrefWork };
            case "q": {
                if (x.max === 0) return { paths: 1, work: 1 };
                const inner = cost(x.atom);
                if (x.max === 1) return { paths: (x.min === 0 ? 1 : 0) + inner.paths, work: inner.work + 1 };
                if (inner.paths !== 1) return { paths: Infinity, work: Infinity };
                const reps = Math.min(x.max, longestRun(charAtoms(x.atom)));
                const choices = Math.max(1, reps - x.min + 1);
                const own = Math.max(reps, x.min) * inner.work + choices;
                return { paths: choices, work: Number.isFinite(x.max) ? COUNTED_LOOP_WEIGHT * own : own };
            }
            default: return { paths: 1, work: 1 };
        }
    };
    const perStart = cost(tree).work;
    if (!Number.isFinite(perStart)) return Infinity;
    const first = tree.t === "seq" ? tree.items[0] : tree.t === "alt" ? undefined : tree;
    let starts = n + 1;
    if (flags.includes("y")) starts = 1;
    else if (first?.t === "caret") starts = flags.includes("m") ? 1 + (input.match(/[\n\r\u2028\u2029]/g)?.length ?? 0) : 1;
    else if (first?.t === "char" && n) {
        const re = scan([first.src]);
        starts = 0;
        for (let m = re.exec(input); m; m = re.exec(input)) starts += m[0].length;
    }
    return n + starts * perStart;
}

/** {@link regexWork} in evaluation steps. */
export function regexSteps(source: string, flags: string, input: string, charge?: (steps: number) => void, scanCharsPerStep?: number): number {
    return Math.ceil(regexWork(source, flags, input, charge, scanCharsPerStep) / REGEX_UNITS_PER_STEP);
}

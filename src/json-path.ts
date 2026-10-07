// json-path.ts — RFC 9535 JSONPath over JSON values: `ml.jsonPath(value, "$..author")`. Pure, no imports, and no
// `eval` anywhere: the popular libraries evaluate filter expressions as JavaScript, which is a known injection class and
// the opposite of what the read-only `exec` dialect is. This one has its own recursive-descent parser for the whole
// grammar (descendants, slices, unions, filters, the five standard functions) and is checked against the official
// compliance suite (tests/fixtures/jsonpath-cts/, tests/json-path.test.mjs).
//
// Bounded for a caller that cannot trust the expression or the data: the expression's length and nesting are capped,
// a cycle in the data is an error rather than a hang, every node visited can be charged to a caller's budget, and a
// `match()`/`search()` pattern is handed to the caller before it is compiled (the dialect refuses one that could
// backtrack catastrophically).

/** What a caller that cannot trust the input may hold a query to. The read-only dialect passes all three. */
export interface JsonPathLimits {
    /** Called with work done, in nodes visited; throw to stop. */
    charge?(n: number): void;
    /** Called with every JS regex SOURCE `match()`/`search()` is about to compile; throw to refuse it. */
    onPattern?(source: string): void;
}

/** One match: where it is, as an RFC 9535 Normalized Path (`$['store']['book'][0]`), and what is there. */
export interface JsonPathNode { path: string; value: unknown }

/** A query that is not valid JSONPath, or data that is not JSON. Its message says which, and where. */
export class JsonPathError extends Error {}

/** The longest expression accepted, and the deepest nesting of brackets, parentheses and filters within one. */
const MAX_EXPR = 4096;
const MAX_NESTING = 64;
/** I-JSON's exact integer range, which RFC 9535 requires of an index and a slice bound. */
const MAX_INT = 2 ** 53 - 1;

// ------------------------------------------------------------------------------------------------------------ AST ---

type Key = string | number;
type Query = { root: "$" | "@"; segments: Segment[] };
type Segment = { descendant: boolean; selectors: Selector[] };
type Selector =
    | { k: "name"; name: string }
    | { k: "wild" }
    | { k: "index"; i: number }
    | { k: "slice"; start: number | null; end: number | null; step: number | null }
    | { k: "filter"; expr: Logical };
type Logical =
    | { k: "or"; a: Logical[] } | { k: "and"; a: Logical[] } | { k: "not"; e: Logical }
    | { k: "cmp"; op: string; l: Comparable; r: Comparable }
    | { k: "test"; q: Query } | { k: "testfn"; f: Fn };
type Comparable = { k: "lit"; v: unknown } | { k: "query"; q: Query } | { k: "fn"; f: Fn };
type Fn = { name: string; args: FnArg[] };
type FnArg = { k: "lit"; v: unknown } | { k: "query"; q: Query } | { k: "fn"; f: Fn } | { k: "logical"; e: Logical };

/** What each standard function takes and gives (RFC 9535 §2.4). `value` = ValueType, `nodes` = NodesType,
 *  `logical` = LogicalType. */
const FUNCTIONS: Record<string, { args: ("value" | "nodes" | "logical")[]; result: "value" | "logical" }> = {
    length: { args: ["value"], result: "value" },
    count: { args: ["nodes"], result: "value" },
    value: { args: ["nodes"], result: "value" },
    match: { args: ["value", "value"], result: "logical" },
    search: { args: ["value", "value"], result: "logical" },
};

// --------------------------------------------------------------------------------------------------------- parser ---

class Parser {
    private i = 0;
    private nesting = 0;
    constructor(private readonly s: string) {}

    fail(why: string): never { throw new JsonPathError(`invalid JSONPath at character ${this.i}: ${why}`); }
    private peek(n = 0): string { return this.s[this.i + n] ?? ""; }
    private eat(t: string): boolean { if (this.s.startsWith(t, this.i)) { this.i += t.length; return true; } return false; }
    private expect(t: string, why: string): void { if (!this.eat(t)) this.fail(why); }
    /** RFC 9535 blank space: space, tab, LF, CR. */
    private ws(): void { while (" \t\n\r".includes(this.peek()) && this.peek() !== "") this.i++; }
    private enter(): void { if (++this.nesting > MAX_NESTING) this.fail(`nested more than ${MAX_NESTING} deep`); }
    private leave(): void { this.nesting--; }

    parseQuery(): Query {
        if (this.s.length > MAX_EXPR) this.fail(`longer than ${MAX_EXPR} characters`);
        if (!this.eat("$")) this.fail("a query starts with $");
        const q: Query = { root: "$", segments: this.segments() };
        if (this.i !== this.s.length) this.fail(`unexpected ${JSON.stringify(this.peek())}`);
        return q;
    }

    /** `*(S segment)`: blank space may come before a segment, so look past it and step back if no segment follows. */
    private segments(): Segment[] {
        const out: Segment[] = [];
        for (;;) {
            const at = this.i;
            this.ws();
            const c = this.peek();
            if (c !== "." && c !== "[") { this.i = at; return out; }
            out.push(this.segment());
        }
    }

    private segment(): Segment {
        if (this.eat("..")) {
            if (this.peek() === "[") return { descendant: true, selectors: this.bracketed() };
            if (this.eat("*")) return { descendant: true, selectors: [{ k: "wild" }] };
            return { descendant: true, selectors: [{ k: "name", name: this.shorthand() }] };
        }
        if (this.eat(".")) {
            if (this.eat("*")) return { descendant: false, selectors: [{ k: "wild" }] };
            return { descendant: false, selectors: [{ k: "name", name: this.shorthand() }] };
        }
        return { descendant: false, selectors: this.bracketed() };
    }

    /** member-name-shorthand: ALPHA / "_" / any non-ASCII scalar first, then those or DIGIT. */
    private shorthand(): string {
        const start = this.i;
        const first = (cp: number) => (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f || cp >= 0x80;
        const isChar = (cp: number) => first(cp) || (cp >= 0x30 && cp <= 0x39);
        const cp0 = this.s.codePointAt(this.i);
        if (cp0 === undefined || !first(cp0) || (cp0 >= 0xd800 && cp0 <= 0xdfff)) this.fail("expected a member name");
        while (this.i < this.s.length) {
            const cp = this.s.codePointAt(this.i)!;
            if (!isChar(cp) || (cp >= 0xd800 && cp <= 0xdfff)) break;
            this.i += cp > 0xffff ? 2 : 1;
        }
        return this.s.slice(start, this.i);
    }

    private bracketed(): Selector[] {
        this.expect("[", "expected [");
        this.enter();
        const out: Selector[] = [];
        this.ws();
        out.push(this.selector());
        for (;;) {
            this.ws();
            if (this.eat("]")) break;
            this.expect(",", "expected , or ]");
            this.ws();
            out.push(this.selector());
        }
        this.leave();
        return out;
    }

    private selector(): Selector {
        const c = this.peek();
        if (c === "'" || c === '"') return { k: "name", name: this.string() };
        if (this.eat("*")) return { k: "wild" };
        if (this.eat("?")) { this.ws(); this.enter(); const expr = this.logicalOr(); this.leave(); return { k: "filter", expr }; }
        // An index or a slice: [start S] ":" S [end S] [":" [S step]].
        const start = this.peek() === "-" || /[0-9]/.test(this.peek()) ? this.int() : null;
        this.ws();
        if (!this.eat(":")) {
            if (start === null) this.fail("expected a selector");
            return { k: "index", i: start };
        }
        this.ws();
        const end = this.peek() === "-" || /[0-9]/.test(this.peek()) ? this.int() : null;
        this.ws();
        let step: number | null = null;
        if (this.eat(":")) { this.ws(); if (this.peek() === "-" || /[0-9]/.test(this.peek())) step = this.int(); }
        return { k: "slice", start, end, step };
    }

    /** int = "0" / (["-"] DIGIT1 *DIGIT), within I-JSON's exact range. No leading zero, no "-0". */
    private int(): number {
        const m = /^(0|-?[1-9][0-9]*)/.exec(this.s.slice(this.i));
        if (!m) this.fail("expected an integer");
        if (/^-?0[0-9]/.test(this.s.slice(this.i)) || this.s.startsWith("-0", this.i)) this.fail("an integer has no leading zero, and no -0");
        this.i += m[0].length;
        const n = Number(m[0]);
        if (Math.abs(n) > MAX_INT) this.fail("integer out of the exact range");
        return n;
    }

    /** A string literal in single or double quotes, with JSON's escapes plus the other quote. */
    private string(): string {
        const q = this.peek();
        this.i++;
        let out = "";
        for (;;) {
            if (this.i >= this.s.length) this.fail("unterminated string");
            const c = this.s[this.i];
            if (c === q) { this.i++; return out; }
            const code = c.charCodeAt(0);
            if (code < 0x20) this.fail("a control character must be escaped");
            if (c !== "\\") { out += c; this.i++; continue; }
            const e = this.s[this.i + 1];
            this.i += 2;
            const simple: Record<string, string> = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", "/": "/", "\\": "\\" };
            if (e in simple) out += simple[e];
            else if (e === q) out += q;
            else if (e === "u") {
                const hi = this.hex4();
                if (hi >= 0xdc00 && hi <= 0xdfff) this.fail("a lone low surrogate");
                if (hi >= 0xd800 && hi <= 0xdbff) {
                    if (!this.eat("\\u")) this.fail("a high surrogate needs a low one after it");
                    const lo = this.hex4();
                    if (lo < 0xdc00 || lo > 0xdfff) this.fail("a high surrogate needs a low one after it");
                    out += String.fromCharCode(hi, lo);
                } else out += String.fromCharCode(hi);
            } else this.fail(`invalid escape \\${e ?? ""}`);
        }
    }

    private hex4(): number {
        const h = this.s.slice(this.i, this.i + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail("expected four hex digits");
        this.i += 4;
        return parseInt(h, 16);
    }

    // ---- filters ----

    private logicalOr(): Logical {
        const a = [this.logicalAnd()];
        for (;;) {
            const at = this.i;
            this.ws();
            if (!this.eat("||")) { this.i = at; break; }
            this.ws();
            a.push(this.logicalAnd());
        }
        return a.length === 1 ? a[0] : { k: "or", a };
    }

    private logicalAnd(): Logical {
        const a = [this.basic()];
        for (;;) {
            const at = this.i;
            this.ws();
            if (!this.eat("&&")) { this.i = at; break; }
            this.ws();
            a.push(this.basic());
        }
        return a.length === 1 ? a[0] : { k: "and", a };
    }

    private basic(): Logical {
        if (this.eat("!")) {
            this.ws();
            if (this.eat("(")) return { k: "not", e: this.paren() };
            const t = this.operand();
            if (t.k === "query") return { k: "not", e: { k: "test", q: t.q } };
            if (t.k === "fn") return { k: "not", e: this.testFn(t.f) };
            this.fail("! applies to a query, a function or a parenthesised expression");
        }
        if (this.eat("(")) return this.paren();
        const left = this.operand();
        const at = this.i;
        this.ws();
        const op = ["==", "!=", "<=", ">=", "<", ">"].find((o) => this.s.startsWith(o, this.i));
        if (op) {
            this.i += op.length;
            this.ws();
            const right = this.operand();
            return { k: "cmp", op, l: this.comparable(left), r: this.comparable(right) };
        }
        this.i = at;
        if (left.k === "query") return { k: "test", q: left.q };
        if (left.k === "fn") return this.testFn(left.f);
        this.fail("a literal on its own is not a test; compare it with something");
    }

    private paren(): Logical {
        this.enter();
        this.ws();
        const e = this.logicalOr();
        this.ws();
        this.expect(")", "expected )");
        this.leave();
        return e;
    }

    /** A function in TEST position must give a LogicalType (match, search); a value-returning one must be compared. */
    private testFn(f: Fn): Logical {
        if (FUNCTIONS[f.name].result !== "logical") this.fail(`${f.name}() gives a value, so compare it with something`);
        return { k: "testfn", f };
    }

    /** Something that may stand on either side of a comparison, or alone as a test. */
    private operand(): Comparable {
        const c = this.peek();
        if (c === "@" || c === "$") {
            this.i++;
            this.enter();
            const q: Query = { root: c as "$" | "@", segments: this.segments() };
            this.leave();
            return { k: "query", q };
        }
        if (c === "'" || c === '"') return { k: "lit", v: this.string() };
        if (c === "-" || /[0-9]/.test(c)) return { k: "lit", v: this.number() };
        for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
            if (this.s.startsWith(word, this.i) && !/[a-z0-9_]/.test(this.s[this.i + word.length] ?? "")) { this.i += word.length; return { k: "lit", v }; }
        }
        const m = /^[a-z][a-z0-9_]*\(/.exec(this.s.slice(this.i));
        if (m) return { k: "fn", f: this.fn(m[0].slice(0, -1)) };
        this.fail("expected a query, a literal or a function");
    }

    /** number = (int / "-0") [ frac ] [ exp ], as JSON writes one. */
    private number(): number {
        const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/.exec(this.s.slice(this.i));
        if (!m) this.fail("expected a number");
        this.i += m[0].length;
        return Number(m[0]);
    }

    private fn(name: string): Fn {
        const def = FUNCTIONS[name];
        if (!def) this.fail(`unknown function ${name}()`);
        this.i += name.length + 1;
        this.enter();
        const args: FnArg[] = [];
        this.ws();
        if (!this.eat(")")) {
            for (;;) {
                args.push(this.fnArg(def.args[args.length], name));
                this.ws();
                if (this.eat(")")) break;
                this.expect(",", "expected , or )");
                this.ws();
            }
        }
        this.leave();
        if (args.length !== def.args.length) this.fail(`${name}() takes ${def.args.length} argument${def.args.length === 1 ? "" : "s"}`);
        return { name, args };
    }

    /** One argument, checked against the parameter's TYPE as RFC 9535 §2.4.3 requires (a well-typed query). */
    private fnArg(want: "value" | "nodes" | "logical" | undefined, name: string): FnArg {
        if (!want) this.fail(`${name}() takes fewer arguments`);
        const at = this.i;
        const o = this.operand();
        // A LogicalType parameter takes a whole logical expression; none of the standard functions has one.
        if (want === "logical") { this.i = at; return { k: "logical", e: this.logicalOr() }; }
        if (want === "nodes") {
            if (o.k !== "query") this.fail(`${name}() takes a query`);
            return o;
        }
        // ValueType: a literal, a SINGULAR query, or a function that gives a value.
        if (o.k === "query" && !singular(o.q)) this.fail(`${name}() takes a single value, and this query can select several`);
        if (o.k === "fn" && FUNCTIONS[o.f.name].result !== "value") this.fail(`${name}() takes a value, and ${o.f.name}() gives a logical`);
        return o;
    }

    /** A comparison side must be a ValueType: a literal, a singular query, or a value-returning function. */
    private comparable(o: Comparable): Comparable {
        if (o.k === "query" && !singular(o.q)) this.fail("a comparison takes a single value, and this query can select several");
        if (o.k === "fn" && FUNCTIONS[o.f.name].result !== "value") this.fail(`${o.f.name}() gives a logical, which cannot be compared`);
        return o;
    }
}

/** A singular query selects at most one node: child segments of a name or an index only. */
function singular(q: Query): boolean {
    return q.segments.every((s) => !s.descendant && s.selectors.length === 1 && (s.selectors[0].k === "name" || s.selectors[0].k === "index"));
}

// ------------------------------------------------------------------------------------------------------ evaluation ---

/** Where a node is, as a link to its parent rather than a copied array: copying a path per child is quadratic in depth,
 *  which over 100,000-deep JSON was billions of copies for a walk charged a hundred thousand nodes. */
type Path = { up: Path; key: Key } | null;
type Node = { value: unknown; path: Path };
/** A path's keys from the root down. Costs its depth, so a caller materialising many is charged for it. */
function keysOf(p: Path): Key[] {
    const out: Key[] = [];
    for (; p; p = p.up) out.push(p.key);
    return out.reverse();
}
const NOTHING = Symbol("nothing");

/** Is this JSON? Plain objects and arrays, strings, finite numbers, booleans, null. Anything else (a DOM node, a Map, a
 *  class instance, a function) is refused rather than walked: walking a live object reads its getters. */
function checkJson(v: unknown): void {
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number") { if (!Number.isFinite(v)) throw new JsonPathError("not JSON: a number that is not finite"); return; }
    if (typeof v === "object") {
        if (Array.isArray(v)) return;
        const p = Object.getPrototypeOf(v);
        if (p === Object.prototype || p === null) return;
    }
    throw new JsonPathError(`not JSON data: ${v === undefined ? "undefined" : typeof v === "object" ? "an object that is not plain data" : `a ${typeof v}`}`);
}

/** One own member or array element, read as DATA: a getter is never run (on a live object it would be someone else's
 *  code), and that includes an array index, which `v[i]` or `v.map` would read through one. */
function own(o: object, k: Key): unknown {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d) throw new JsonPathError(`not JSON data: the array has a hole at ${k}`);
    if (!("value" in d)) throw new JsonPathError(`not JSON data: member ${JSON.stringify(k)} is a getter`);
    return d.value;
}
/** An object's own members, read as DATA (see `own`). */
function members(o: Record<string, unknown>): [string, unknown][] {
    return Object.keys(o).map((k) => [k, own(o, k)]);
}
function children(n: Node): Node[] {
    const v = n.value;
    if (Array.isArray(v)) {
        const out: Node[] = [];
        for (let i = 0; i < v.length; i++) out.push({ value: own(v, i), path: { up: n.path, key: i } });
        return out;
    }
    if (v !== null && typeof v === "object") return members(v as Record<string, unknown>).map(([k, x]) => ({ value: x, path: { up: n.path, key: k } }));
    return [];
}

class Evaluator {
    private regexes = new Map<string, RegExp | null>();
    constructor(private readonly root: unknown, private readonly limits: JsonPathLimits) {}

    run(q: Query, current: Node): Node[] {
        let nodes: Node[] = [q.root === "$" ? { value: this.root, path: null } : current];
        for (const seg of q.segments) nodes = this.segment(nodes, seg);
        return nodes;
    }

    private segment(input: Node[], seg: Segment): Node[] {
        const out: Node[] = [];
        for (const n of input) {
            for (const d of seg.descendant ? this.descendants(n) : [n]) {
                for (const sel of seg.selectors) out.push(...this.select(d, sel));
            }
        }
        return out;
    }

    /** The node and every node under it, in document order, ITERATIVELY (deep JSON cannot overflow the stack), and
     *  refusing a cycle (JSON has none, but an object a script built can, and a walk of one would never end). */
    private descendants(n: Node): Node[] {
        const out: Node[] = [];
        const seen = new Set<unknown>();
        const stack: Node[] = [n];
        while (stack.length) {
            const x = stack.pop()!;
            this.limits.charge?.(1);
            checkJson(x.value);
            if (x.value !== null && typeof x.value === "object") {
                if (seen.has(x.value)) throw new JsonPathError("not JSON: the value contains a cycle");
                seen.add(x.value);
            }
            out.push(x);
            const kids = children(x);
            for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
        }
        return out;
    }

    private select(n: Node, sel: Selector): Node[] {
        const v = n.value;
        checkJson(v);
        switch (sel.k) {
            case "name": {
                if (v === null || typeof v !== "object" || Array.isArray(v)) return [];
                if (!Object.prototype.hasOwnProperty.call(v, sel.name)) return [];
                const d = Object.getOwnPropertyDescriptor(v, sel.name)!;
                if (!("value" in d)) throw new JsonPathError(`not JSON data: member ${JSON.stringify(sel.name)} is a getter`);
                this.limits.charge?.(1);
                return [{ value: d.value, path: { up: n.path, key: sel.name } }];
            }
            case "wild": { const kids = children(n); this.limits.charge?.(kids.length); return kids; }
            case "index": {
                if (!Array.isArray(v)) return [];
                const i = sel.i < 0 ? v.length + sel.i : sel.i;
                return i >= 0 && i < v.length ? [{ value: own(v, i), path: { up: n.path, key: i } }] : [];
            }
            case "slice": {
                if (!Array.isArray(v)) return [];
                const out: Node[] = [];
                for (const i of sliceIndices(v.length, sel.start, sel.end, sel.step)) out.push({ value: own(v, i), path: { up: n.path, key: i } });
                this.limits.charge?.(out.length);
                return out;
            }
            case "filter": {
                const out: Node[] = [];
                for (const c of children(n)) {
                    this.limits.charge?.(1);
                    if (this.logical(sel.expr, c)) out.push(c);
                }
                return out;
            }
        }
    }

    private logical(e: Logical, cur: Node): boolean {
        switch (e.k) {
            case "or": return e.a.some((x) => this.logical(x, cur));
            case "and": return e.a.every((x) => this.logical(x, cur));
            case "not": return !this.logical(e.e, cur);
            case "test": return this.run(e.q, cur).length > 0;
            case "testfn": return this.call(e.f, cur) === true;
            case "cmp": return compare(e.op, this.comparable(e.l, cur), this.comparable(e.r, cur), this.limits);
        }
    }

    private comparable(c: Comparable, cur: Node): unknown {
        if (c.k === "lit") return c.v;
        if (c.k === "fn") return this.call(c.f, cur);
        const nodes = this.run(c.q, cur);
        return nodes.length === 1 ? nodes[0].value : NOTHING;
    }

    private arg(a: FnArg, cur: Node, want: "value" | "nodes" | "logical"): unknown {
        if (a.k === "logical") return this.logical(a.e, cur);
        if (want === "nodes") return a.k === "query" ? this.run(a.q, cur) : [];
        if (a.k === "lit") return a.v;
        if (a.k === "fn") return this.call(a.f, cur);
        const nodes = this.run(a.q, cur);
        return nodes.length === 1 ? nodes[0].value : NOTHING;
    }

    private call(f: Fn, cur: Node): unknown {
        const def = FUNCTIONS[f.name];
        const args = f.args.map((a, i) => this.arg(a, cur, def.args[i]));
        switch (f.name) {
            case "length": {
                const v = args[0];
                if (typeof v === "string") return [...v].length;
                if (Array.isArray(v)) return v.length;
                if (v !== null && typeof v === "object") return Object.keys(v).length;
                return NOTHING;
            }
            case "count": return (args[0] as Node[]).length;
            case "value": { const ns = args[0] as Node[]; return ns.length === 1 ? ns[0].value : NOTHING; }
            case "match": case "search": {
                const [s, p] = args;
                if (typeof s !== "string" || typeof p !== "string") return false;
                const re = this.regex(p, f.name === "match");
                return re ? re.test(s) : false;
            }
        }
        return NOTHING;
    }

    /** An I-Regexp (RFC 9485) as a JS RegExp, or null when the pattern is not one (which makes the test false, as the
     *  RFC says). The JS source is handed to `onPattern` first, so a caller can refuse one that could backtrack. */
    private regex(p: string, whole: boolean): RegExp | null {
        const key = `${whole ? "m" : "s"}:${p}`;
        if (this.regexes.has(key)) return this.regexes.get(key)!;
        const src = iregexpToJs(p);
        let re: RegExp | null = null;
        if (src !== null) {
            const full = whole ? `^(?:${src})$` : src;
            this.limits.onPattern?.(full);
            try { re = new RegExp(full, "u"); } catch { re = null; }
        }
        this.regexes.set(key, re);
        return re;
    }
}

/** RFC 9535 §2.3.4.2.2: the indices a slice selects, normalised exactly as the RFC states it. */
function* sliceIndices(len: number, start: number | null, end: number | null, step: number | null): Generator<number> {
    const st = step ?? 1;
    if (st === 0) return;
    const norm = (i: number) => (i >= 0 ? i : len + i);
    if (st > 0) {
        const lower = Math.min(Math.max(norm(start ?? 0), 0), len);
        const upper = Math.min(Math.max(norm(end ?? len), 0), len);
        for (let i = lower; i < upper; i += st) yield i;
    } else {
        const upper = Math.min(Math.max(norm(start ?? len - 1), -1), len - 1);
        const lower = Math.min(Math.max(end == null ? -1 : norm(end), -1), len - 1);
        for (let i = upper; lower < i; i += st) yield i;
    }
}

/** Unicode scalar value order, which RFC 9535 requires for `<` on strings (JS's `<` compares UTF-16 code units). */
function lessString(a: string, b: string): boolean {
    const x = [...a], y = [...b];
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const p = x[i].codePointAt(0)!, q = y[i].codePointAt(0)!;
        if (p !== q) return p < q;
    }
    return x.length < y.length;
}

/** Deep equality of two JSON values, ITERATIVELY, so nesting depth cannot overflow the stack. Members are read as DATA
 *  (`own`): a compared subtree is one the walk never visited, so it is the one place a getter could otherwise run. */
function equal(a: unknown, b: unknown, limits: JsonPathLimits): boolean {
    const stack: [unknown, unknown][] = [[a, b]];
    while (stack.length) {
        const [x, y] = stack.pop()!;
        limits.charge?.(1);
        if (x === y) continue;
        if (typeof x === "number" && typeof y === "number") { if (x !== y) return false; continue; }
        if (x === null || y === null || typeof x !== "object" || typeof y !== "object") return false;
        if (Array.isArray(x) !== Array.isArray(y)) return false;
        if (Array.isArray(x)) {
            const yy = y as unknown[];
            if (x.length !== yy.length) return false;
            for (let i = 0; i < x.length; i++) stack.push([own(x, i), own(yy, i)]);
            continue;
        }
        const kx = Object.keys(x), ky = Object.keys(y);
        if (kx.length !== ky.length) return false;
        for (const k of kx) {
            if (!Object.prototype.hasOwnProperty.call(y, k)) return false;
            stack.push([own(x, k), own(y, k)]);
        }
    }
    return true;
}

/** RFC 9535 §2.3.5.2.2: comparisons, where an absent value (Nothing) equals only Nothing and orders against nothing. */
function compare(op: string, l: unknown, r: unknown, limits: JsonPathLimits): boolean {
    const eq = () => (l === NOTHING || r === NOTHING) ? l === r : equal(l, r, limits);
    const lt = (a: unknown, b: unknown) =>
        typeof a === "number" && typeof b === "number" ? a < b
            : typeof a === "string" && typeof b === "string" ? lessString(a, b) : false;
    switch (op) {
        case "==": return eq();
        case "!=": return !eq();
        case "<": return lt(l, r);
        case ">": return lt(r, l);
        case "<=": return lt(l, r) || eq();
        case ">=": return lt(r, l) || eq();
    }
    return false;
}

/** An I-Regexp (RFC 9485) as JS RegExp source for the `u` flag, or null when it is not one. Outside a class, `.` is
 *  "any character but a line end". `^` and `$` pass through as anchors, which is what the compliance suite expects
 *  (harmless in `match()`, which matches the whole string anyway). Back-references, lookaround, groups with `?`, and
 *  the shorthand classes (`\d`, `\w`, `\b`) are not I-Regexp. */
function iregexpToJs(p: string): string | null {
    let out = "";
    let inClass = false;
    for (let i = 0; i < p.length; i++) {
        const c = p[i];
        if (c === "\\") {
            const e = p[i + 1];
            if (e === undefined) return null;
            if (e === "p" || e === "P") {
                const m = /^\{[A-Za-z0-9_-]+\}/.exec(p.slice(i + 2));
                if (!m) return null;
                out += `\\${e}${m[0]}`; i += 1 + m[0].length; continue;
            }
            if ("()*+-.?[\\]^{|}nrt".includes(e)) { out += `\\${e}`; i++; continue; }
            return null;
        }
        if (inClass) {
            if (c === "]") inClass = false;
            out += c === "[" ? "\\[" : c;
            continue;
        }
        if (c === "[") { inClass = true; out += c; if (p[i + 1] === "^") { out += "^"; i++; } if (p[i + 1] === "]") return null; continue; }
        if (c === "(" && p[i + 1] === "?") return null;
        if (c === ".") { out += "[^\\n\\r]"; continue; }
        out += c;
    }
    return inClass ? null : out;
}

/** A Normalized Path (RFC 9535 §2.7): `$`, then `[n]` for an index and `['name']` for a member, escaped as the RFC
 *  specifies (lowercase hex, the short escapes where they exist). */
export function normalizedPath(keys: readonly Key[]): string {
    let out = "$";
    for (const k of keys) {
        if (typeof k === "number") { out += `[${k}]`; continue; }
        let s = "";
        for (const ch of k) {
            const cp = ch.codePointAt(0)!;
            if (ch === "\\") s += "\\\\";
            else if (ch === "'") s += "\\'";
            else if (cp < 0x20) s += ({ 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" } as Record<number, string>)[cp] ?? `\\u${cp.toString(16).padStart(4, "0")}`;
            else s += ch;
        }
        out += `['${s}']`;
    }
    return out;
}

/** Parse an expression without running it: throws `JsonPathError` naming what is wrong and where. */
export function parseJsonPath(expr: string): Query {
    if (typeof expr !== "string") throw new JsonPathError("a JSONPath expression is a string, such as \"$..id\"");
    return new Parser(expr).parseQuery();
}

/**
 * Run an RFC 9535 JSONPath query over a JSON value.
 *
 * ```js
 *   ml.jsonPath(data, "$.store.book[?@.price < 10].title")   // ["Sayings of the Century", "Moby Dick"]
 *   ml.jsonPath(data, "$..author", { paths: true })           // [{ path: "$['store']['book'][0]['author']", value: "…" }, …]
 *   ml.jsonPath('{"items":[{"id":1}]}', "$.items[*].id")     // a JSON STRING is parsed first: [1]
 * ```
 *
 * `source` is JSON data, or a JSON string, which is parsed. An object is always data, never unwrapped: `{ text: "…" }`
 * is valid JSON to query, so guessing that its `text` was meant would be wrong half the time. Data that is not JSON (a
 * DOM node, a Map, a getter) is refused, not walked.
 */
export function mlJsonPath(source: unknown, expr: string, opts?: { paths?: boolean } | null, limits: JsonPathLimits = {}): unknown[] | JsonPathNode[] {
    const query = parseJsonPath(expr);
    let root = source;
    if (typeof source === "string" || source instanceof String) {
        try { root = JSON.parse(String(source)); }
        catch { throw new JsonPathError("ml.jsonPath needs JSON: this string is not JSON. Pass the parsed value, or the JSON text."); }
    }
    checkJson(root);
    const nodes = new Evaluator(root, limits).run(query, { value: root, path: null });
    if (!opts?.paths) return nodes.map((n) => n.value);
    return nodes.map((n) => {
        const keys = keysOf(n.path);
        limits.charge?.(keys.length);
        return { path: normalizedPath(keys), value: n.value };
    });
}

// policy-lift.ts — the policy tree's LIFTER: a policy's source, when it fits the analysable fragment, as a typed-node tree.

// docs/plan/repl/LANE_11_POLICY_TREE_DESIGN.md (the grammar) and docs/spec/POLICIES.md, "The tree, ruled 2026-10-21".
// A syntactic recogniser over the dialect's own AST: it never evaluates anything, and a source it does not recognise
// stays code (its breadth is MEASURED). Built first and alone, to measure what fraction of real proposals lift; no
// renderer, analyser or card exists yet, so nothing in the product reads a tree.

import { tokenize } from "./tokenizer";
import { Parser, Node } from "./parser";
import { OPS, RESOURCE_KINDS as KINDS } from "../effects";

/** A field, as a path from `c` (or from a list's element, after `"@"`). A number follows `"argv"` only. */
export type TreeField = readonly (string | number)[];

/** A constant an atom compares with. */
export type TreeScalar = string | number | boolean | null;

/** One node of a policy tree. `all: []` is true and `any: []` is false. */
export type PolicyTree =
    | { op: "all"; of: PolicyTree[] }
    | { op: "any"; of: PolicyTree[] }
    | { op: "not"; of: PolicyTree }
    | { op: "is"; field: TreeField; value: TreeScalar }
    | { op: "oneOf"; field: TreeField; values: TreeScalar[] }
    /** Strictly below `value` by the field's segments: path components, host labels from the right, a URL's path. */
    | { op: "under"; field: TreeField; value: string }
    /** A character prefix: an argv element only (opaque text). */
    | { op: "startsWith"; field: TreeField; values: string[] }
    | { op: "argCount"; values: number[] }
    | { op: "some" | "every"; list: TreeField; test: PolicyTree }
    | { op: "has"; effect: string; kind?: string }
    | { op: "uses"; name: string }
    | { op: "unknown" };

/** What the lifter answers: the tree, or why the source stays code. */
export type LiftResult = { tree: PolicyTree } | { tree?: undefined; why: string };

/** The consumers a tree can be typed by; `other` is a test's hybrid facts (both consumers' fields). */
export type LiftConsumer = "fetch" | "sh" | "other";

// --- the facts' types, per consumer ---

/** A fact's type, which decides the atoms that may read it. */
type FieldType =
    | { t: "str" } | { t: "host" } | { t: "url" } | { t: "path" } | { t: "bool" } | { t: "num" }
    | { t: "enum"; values: readonly string[] }
    | { t: "nullable"; of: FieldType }
    | { t: "obj"; fields: Readonly<Record<string, FieldType>> }
    | { t: "list"; elem: FieldType }
    | { t: "argv" }
    | { t: "effects" }
    /** Present only on some calls: reading it where it is missing is a refusal, so a tree does not read it. */
    | { t: "absent"; why: string }
    /** A fact no atom reads (an object compared as a whole, an id). */
    | { t: "opaque" };

/** A fact sent on some calls only, by name, for the reason a tree does not read it. */
const MAYBE = (f: string): FieldType => ({ t: "absent", why: `${f} is sent only on some calls (it becomes an explicit null first)` });
/** The plain types the tables below repeat. */
const STR: FieldType = { t: "str" }, BOOL: FieldType = { t: "bool" }, PATH: FieldType = { t: "path" };

/** A resource as `c.effects` shows it: every field present, `undefined` where its kind lacks it. */
const RESOURCE: FieldType = { t: "obj", fields: {
    kind: { t: "enum", values: KINDS }, of: { t: "opaque" }, path: PATH, inRoot: BOOL, secret: BOOL, exists: BOOL,
    topLevel: BOOL, isRoot: BOOL, names: BOOL, host: { t: "host" }, name: STR,
} };
/** One (operation, resource) pair. */
export const PAIR: FieldType = { t: "obj", fields: { op: { t: "enum", values: OPS }, res: RESOURCE } };

/** A `fetch_url` call's facts (`fetchFacts`). */
const FETCH: Record<string, FieldType> = {
    kind: { t: "enum", values: ["fetch"] }, url: { t: "url" }, host: { t: "host" }, method: { t: "enum", values: ["GET"] },
    credentials: BOOL, rendered: BOOL, effects: { t: "effects" },
};
/** An `ml.sh` call's facts (`ShFacts`); `repo` is read only through `repoConfigRunsCode`. */
const SH: Record<string, FieldType> = {
    argv: { t: "argv" },
    program: { t: "obj", fields: { path: PATH, inRoot: BOOL, version: { t: "nullable", of: STR } } },
    cwd: { t: "obj", fields: { path: PATH, inRoot: BOOL, topLevel: MAYBE("cwd.topLevel"), isRoot: MAYBE("cwd.isRoot"), containsSecret: MAYBE("cwd.containsSecret") } },
    env: { t: "obj", fields: { set: { t: "list", elem: STR }, free: BOOL } },
    secrets: { t: "list", elem: STR },
    paths: { t: "list", elem: { t: "obj", fields: {
        arg: { t: "num" }, given: STR, path: PATH, inRoot: BOOL, secret: BOOL, exists: BOOL, topLevel: MAYBE("a path's topLevel"),
        isRoot: MAYBE("a path's isRoot"), containsSecret: MAYBE("a path's containsSecret"), sha256: MAYBE("a path's sha256"),
    } } },
    repo: { t: "opaque" },
    repoConfigRunsCode: { t: "nullable", of: BOOL },
    effects: { t: "effects" },
    described: BOOL, why: { t: "list", elem: STR }, runner: BOOL,
    mode: { t: "enum", values: ["host", "container"] }, sandboxed: BOOL,
    placement: { t: "enum", values: ["host-sandbox", "host-plain", "container"] },
};
/** What `c` holds for each consumer (sh-call.ts `ShFacts`, sw-policies.ts `fetchFacts`). */
export const CONSUMER_FIELDS: Readonly<Record<LiftConsumer, FieldType>> = {
    fetch: { t: "obj", fields: FETCH },
    sh: { t: "obj", fields: SH },
    other: { t: "obj", fields: { ...SH, ...FETCH } },
};

// --- the lifter ---

/** Thrown inside the lifter for a source that stays code; its message is the reason. */
class NoLift extends Error {}
/** Refuse to lift, saying why. */
const no = (why: string): never => { throw new NoLift(why); };

/** What an expression is, to the lifter: a fact, a constant, a list of constants, or a list's `.length`. */
type Ref =
    | { r: "field"; path: TreeField; type: FieldType; argvIndex?: number }
    | { r: "lit"; value: unknown }
    | { r: "lits"; values: unknown[] }
    | { r: "length"; path: TreeField; type: FieldType };

/** The names a source binds: `c`, the element of the quantifier it is inside, and its const helpers. */
type Scope = { c: string; elem?: { name: string; path: TreeField; type: FieldType }; consts: Map<string, unknown> };

/** Whether a constant is one an atom can compare with. */
const isScalar = (v: unknown): v is TreeScalar => v === null || ["string", "number", "boolean"].includes(typeof v);

/** Lift a policy source over `consumer`'s facts: `{ tree }` when it fits, else `{ why }`. Never throws. */
export function liftPolicy(source: string, consumer: LiftConsumer): LiftResult {
    let ast: Node;
    try { ast = new Parser(tokenize(source)).parseProgram(); } catch (e) { return { why: `does not parse: ${(e as Error).message}` }; }
    try {
        const consts = new Map<string, unknown>();
        const body = ast.body as Node[];
        for (const s of body.slice(0, -1)) {
            if (s.type !== "VarDecl" || s.kind !== "const" || !s.name) no("a statement before the function that is not a const");
            consts.set(s.name, constant(s.init));
        }
        const last = body.at(-1);
        if (!last || last.type !== "ExprStmt" || last.expr.type !== "Arrow") no("the source is not a function (c) => …");
        const fn = last.expr;
        if (fn.params.length !== 1 || typeof fn.params[0] !== "string") no("the function does not take one parameter");
        if (fn.body.type !== "ExprBody") no("a function body with statements");
        const tree = bool(fn.body.expr, { c: fn.params[0], consts }, CONSUMER_FIELDS[consumer]);
        return { tree };
    } catch (e) {
        if (e instanceof NoLift) return { why: e.message };
        return { why: `lifter error: ${(e as Error).message}` };
    }
}

/** A constant expression's value (a literal, or an array of literals). */
function constant(n: Node): unknown {
    if (n.type === "Lit") return n.value;
    if (n.type === "Array" && n.elements.every((e: Node) => e.type === "Lit")) return n.elements.map((e: Node) => e.value);
    return no("a const that is not a literal or a list of literals");
}

/** What a value expression refers to. */
function ref(n: Node, s: Scope, root: FieldType): Ref {
    if (n.type === "Lit") return { r: "lit", value: n.value };
    if (n.type === "Array") {
        if (!n.elements.every((e: Node) => e.type === "Lit")) no("a list that is not all literals");
        return { r: "lits", values: n.elements.map((e: Node) => e.value) };
    }
    if (n.type === "Ident") {
        if (n.name === s.c) return { r: "field", path: [], type: root };
        if (s.elem && n.name === s.elem.name) return { r: "field", path: s.elem.path, type: s.elem.type };
        if (s.consts.has(n.name)) { const v = s.consts.get(n.name); return Array.isArray(v) ? { r: "lits", values: v } : { r: "lit", value: v }; }
        return no(`reads ${n.name}, which is not the call`);
    }
    if (n.type === "Member") {
        if (n.optional) no("optional chaining");
        const o = ref(n.obj, s, root);
        if (o.r !== "field") return no("a member of something that is not a fact");
        if (n.computed) {
            if (o.type.t !== "argv" || n.prop.type !== "Lit" || typeof n.prop.value !== "number" || !Number.isInteger(n.prop.value) || n.prop.value < 0)
                no("an index into a list other than argv, or not by a constant");
            return { r: "field", path: [...o.path, n.prop.value], type: STR, argvIndex: n.prop.value };
        }
        const prop: string = n.prop;
        if (prop === "length" && (o.type.t === "list" || o.type.t === "argv")) return { r: "length", path: o.path, type: o.type };
        if (prop === "length") no("a string's length");
        const t = o.type;
        let ft: FieldType | undefined;
        if (t.t === "obj") ft = Object.hasOwn(t.fields, prop) ? t.fields[prop] : undefined;
        else if (t.t === "effects") ft = ({ unknown: BOOL, pairs: { t: "list", elem: PAIR }, reads: { t: "list", elem: RESOURCE }, writes: { t: "list", elem: RESOURCE } } as Record<string, FieldType>)[prop];
        if (!ft) return no(`reads ${prop}, which ${o.path.length ? o.path.join(".") : "c"} does not have`);
        if (ft.t === "absent") no(ft.why);
        if (ft.t === "opaque") no(`${prop} is not a fact an atom reads`);
        return { r: "field", path: [...o.path, prop], type: ft };
    }
    if (n.type === "Call" && n.callee?.type === "Member") return no(`a value computed by .${n.callee.prop}(…)`);
    return no(`an expression the fragment does not have (${n.type})`);
}

/** A scalar field's type, through `nullable`. */
const base = (t: FieldType): FieldType => (t.t === "nullable" ? t.of : t);

/** Whether a constant is a value of a scalar field's type (so the atom means what it says). */
function fits(t: FieldType, v: unknown): boolean {
    if (v === null) return t.t === "nullable";
    const b = base(t);
    if (["str", "host", "url", "path", "enum"].includes(b.t)) return typeof v === "string";
    if (b.t === "bool") return typeof v === "boolean";
    if (b.t === "num") return typeof v === "number";
    return false;
}

/** Whether a reference is a fact holding one value (not a list, an object or the effect set). */
const scalarField = (f: Ref): f is Extract<Ref, { r: "field" }> =>
    f.r === "field" && ["str", "host", "url", "path", "bool", "num", "enum", "nullable"].includes(f.type.t);

/** Lift a boolean expression. */
function bool(n: Node, s: Scope, root: FieldType): PolicyTree {
    switch (n.type) {
        case "Lit":
            if (typeof n.value !== "boolean") no("a non-boolean literal as a condition");
            return n.value ? { op: "all", of: [] } : { op: "any", of: [] };
        case "Logical": {
            if (n.op !== "&&" && n.op !== "||") no(`the operator ${n.op}`);
            const op = n.op === "&&" ? "all" : "any";
            const parts = [bool(n.left, s, root), bool(n.right, s, root)].flatMap((p) => (p.op === op ? p.of : [p]));
            return { op, of: parts };
        }
        case "Unary":
            if (n.op !== "!") no(`the operator ${n.op}`);
            return { op: "not", of: bool(n.arg, s, root) };
        case "Cond": {
            const t = bool(n.cond, s, root);
            return { op: "any", of: [{ op: "all", of: [t, bool(n.cons, s, root)] }, { op: "all", of: [{ op: "not", of: t }, bool(n.alt, s, root)] }] };
        }
        case "Binary": return compare(n, s, root);
        case "Call": return call(n, s, root);
        case "Member": case "Ident": {
            // Truthiness, only where it is exact: a boolean fact (null and undefined are falsy, as `is true` is false).
            const f = ref(n, s, root);
            if (f.r === "field" && f.path.length === 2 && f.path[0] === "effects" && f.path[1] === "unknown") return { op: "unknown" };
            if (f.r === "field" && base(f.type).t === "bool") return { op: "is", field: f.path, value: true };
            return no("a fact used as a condition that is not a boolean (truthiness)");
        }
        default: return no(`an expression the fragment does not have (${n.type})`);
    }
}

/** `a === b`, `a !== b`, and the few comparisons of a length that are a count. */
function compare(n: Node, s: Scope, root: FieldType): PolicyTree {
    let l = ref(n.left, s, root), r = ref(n.right, s, root);
    if (l.r === "lit" || l.r === "lits") [l, r] = [r, l];
    const neg = (t: PolicyTree): PolicyTree => ({ op: "not", of: t });
    if (l.r === "length" && r.r === "lit" && typeof r.value === "number" && Number.isInteger(r.value) && r.value >= 0) {
        const k = r.value;
        // Only the comparisons with zero are a set question; argv's count is an atom of its own.
        if (l.type.t === "argv" && (n.op === "===" || n.op === "!==")) { const t: PolicyTree = { op: "argCount", values: [k] }; return n.op === "===" ? t : neg(t); }
        const nonEmpty: PolicyTree = { op: "some", list: l.path, test: { op: "all", of: [] } };
        if (k === 0 && n.op === "===") return neg(nonEmpty);
        if (k === 0 && (n.op === "!==" || n.op === ">")) return nonEmpty;
        return no("a length compared with a number (arithmetic over lengths)");
    }
    if (n.op !== "===" && n.op !== "!==") return no(`the comparison ${n.op} (order)`);
    if (l.r !== "field" || r.r !== "lit") return no("a comparison that is not a fact with a constant");
    if (l.argvIndex !== undefined && r.value === undefined) {
        // argv[k] is undefined exactly when there are at most k arguments.
        const t: PolicyTree = { op: "argCount", values: Array.from({ length: l.argvIndex + 1 }, (_, i) => i) };
        return n.op === "===" ? t : neg(t);
    }
    if (!scalarField(l)) return no("a comparison of a fact that is not a single value");
    if (!isScalar(r.value) || !fits(l.type, r.value)) return no(`${JSON.stringify(r.value)} is not a value of ${l.path.join(".")}`);
    const t: PolicyTree = { op: "is", field: l.path, value: r.value };
    return n.op === "===" ? t : neg(t);
}

/** The calls the fragment has: `includes` on a constant list, `startsWith`/`endsWith`, a literal regex's `test`,
 *  `some`/`every` over a list fact, and the effect set's `has` and `uses`. */
function call(n: Node, s: Scope, root: FieldType): PolicyTree {
    const callee = n.callee;
    if (n.optional || callee.type !== "Member" || callee.computed || callee.optional) return no("a call the fragment does not have");
    const m: string = callee.prop;
    if (n.args.some((a: Node) => a.type === "Spread")) no("a spread argument");
    if (callee.obj.type === "Regex" && m === "test" && n.args.length === 1) {
        const prefixes = literalPrefixes(callee.obj.pattern, callee.obj.flags);
        return prefixAtom(ref(n.args[0], s, root), prefixes);
    }
    const o = ref(callee.obj, s, root);
    if (m === "includes" && o.r === "lits" && n.args.length === 1) {
        const f = ref(n.args[0], s, root);
        if (!scalarField(f)) return no("includes of something that is not a single fact");
        if (!o.values.every((v) => isScalar(v) && fits(f.type, v))) no(`a value in the list is not a value of ${f.path.join(".")}`);
        return { op: "oneOf", field: f.path, values: o.values as TreeScalar[] };
    }
    if ((m === "startsWith" || m === "endsWith") && n.args.length === 1) {
        const a = ref(n.args[0], s, root);
        if (a.r !== "lit" || typeof a.value !== "string") return no(`${m} of something that is not a string constant`);
        if (m === "startsWith") return prefixAtom(o, [a.value]);
        // A subdomain: `.endsWith(".shop.com")` is strictly under shop.com by labels.
        if (o.r === "field" && base(o.type).t === "host" && a.value.length > 1 && a.value.startsWith(".")) return { op: "under", field: o.path, value: a.value.slice(1) };
        return no("endsWith other than a host's subdomain");
    }
    if ((m === "some" || m === "every") && n.args.length === 1 && o.r === "field" && (o.type.t === "list" || o.type.t === "argv")) {
        const fn = n.args[0];
        if (fn.type !== "Arrow" || fn.params.length !== 1 || typeof fn.params[0] !== "string" || fn.body.type !== "ExprBody") no(`${m} with something other than (x) => …`);
        if (s.elem) no("a quantifier inside a quantifier");
        const elem = o.type.t === "argv" ? STR : o.type.elem;
        const test = bool(fn.body.expr, { ...s, elem: { name: fn.params[0], path: ["@"], type: o.type.t === "argv" ? { t: "argv" } as FieldType : elem } }, root);
        return { op: m, list: o.path, test };
    }
    if (o.r === "field" && o.type.t === "effects" && (m === "has" || m === "uses")) {
        const args = n.args.map((a: Node) => ref(a, s, root));
        if (!args.every((a: Ref) => a.r === "lit" && typeof a.value === "string")) no(`${m} of something that is not a string constant`);
        const vals = args.map((a: Ref) => (a as { value: string }).value);
        if (m === "uses") { if (vals.length !== 1 || !vals[0]) no("uses takes one name"); return { op: "uses", name: vals[0] }; }
        if (vals.length < 1 || vals.length > 2 || !(OPS as readonly string[]).includes(vals[0]) || (vals[1] !== undefined && !(KINDS as readonly string[]).includes(vals[1])))
            no("has of an operation or kind outside the algebra");
        return vals.length === 2 ? { op: "has", effect: vals[0], kind: vals[1] } : { op: "has", effect: vals[0] };
    }
    return no(`the call .${m}(…) on ${o.r === "field" ? (o.path.join(".") || "c") : "a constant"}`);
}

/** A character-prefix test as an atom of the field's own kind: segments for a path or a URL, characters for argv. */
function prefixAtom(f: Ref, prefixes: string[]): PolicyTree {
    if (f.r !== "field") return no("a prefix test of something that is not a fact");
    const t = base(f.type).t;
    // An argv element (`c.argv[i]`, or the element of argv.some/every) is opaque text: a character prefix.
    if (f.argvIndex !== undefined || t === "argv") return { op: "startsWith", field: f.path, values: prefixes };
    const segment = (p: string): string => {
        // A prefix that ends at a segment boundary is `under` the part before it; any other is a character prefix.
        if (t === "path" && p.startsWith("/") && p.endsWith("/")) return p.slice(0, -1);
        if (t === "url" && /^[a-z][a-z0-9+.-]*:\/\/[^/?#@\\]+\/(?:[^?#]*\/)?$/.test(p)) return p.slice(0, -1);
        return no(`a character prefix of ${f.path.join(".")} (${JSON.stringify(p)}) that does not end at a ${t === "url" ? "path segment" : t === "path" ? "path component" : "segment"}`);
    };
    const atoms: PolicyTree[] = prefixes.map((p) => ({ op: "under", field: f.path, value: segment(p) }));
    return atoms.length === 1 ? atoms[0] : { op: "any", of: atoms };
}

/** An anchored regex that is literals, with at most one group of literal alternatives: the prefixes it means. */
function literalPrefixes(pattern: string, flags: string): string[] {
    if (flags) no("a regex with flags");
    if (!pattern.startsWith("^")) no("an unanchored regex");
    let i = 1;
    const lit = (stop: string): string => {
        let out = "";
        while (i < pattern.length && !stop.includes(pattern[i])) {
            const ch = pattern[i];
            if (ch === "\\") {
                const nx = pattern[i + 1];
                if (nx === undefined || /[A-Za-z0-9]/.test(nx)) no("a regex class or escape (\\d, \\w, …)");
                out += nx; i += 2; continue;
            }
            if (".*+?[]{}^$".includes(ch)) no("a regex that is not literal text");
            out += ch; i++;
        }
        return out;
    };
    const head = lit("(|)");
    let alts = [""];
    if (pattern[i] === "(") {
        i++;
        if (pattern.startsWith("?:", i)) i += 2;
        alts = [lit("|)(")];
        while (pattern[i] === "|") { i++; alts.push(lit("|)(")); }
        if (pattern[i] !== ")") no("a regex group that is not literal alternatives");
        i++;
    }
    const tail = lit("(|)");
    if (i !== pattern.length) no("a regex with more than one group, or an alternation outside one");
    return alts.map((a) => head + a + tail);
}

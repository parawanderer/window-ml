// policy-literals.ts — the constants a policy's source names, read from its tree: what a measure adds to the values it tries.

// A syntactic walk over the dialect's own AST, like the lifter (policy-lift.ts), and like it never evaluates anything.
// It decides nothing about what a policy covers: the measure does (docs/spec/MODEL_SETTINGS.md, "Proposing a `setting`
// policy"). It only names values worth trying, so a rule that matches one value it names is tried at that value, and the
// `c.key` names and key-bound comparisons a check-time refusal reads.

import { tokenize } from "./tokenizer";
import { Parser, type Node } from "./parser";

/** A comparison of `c.from` or `c.to` with a constant, in an `&&` chain that also says `c.key === key`. */
export interface KeyedLiteral { key: string; field: "from" | "to"; op: string; value: string | number | boolean | null }

/** What a policy's source names. */
export interface PolicyLiterals {
    /** Every string constant, a template's fixed parts included. */
    strings: string[];
    /** Every number constant, negated ones and arithmetic over constants folded. */
    numbers: number[];
    /** The strings `c.key` is compared with (`===`, `!==`, or a constant list's `includes`). */
    keyNames: string[];
    /** The comparisons of `c.from`/`c.to` with a constant bound to one key by an `&&` chain. */
    keyed: KeyedLiteral[];
}

const ARITH = new Set(["+", "-", "*", "/", "%"]);
const COMPARE = new Set(["===", "!==", "<", "<=", ">", ">="]);

/** Every node of the tree, depth first. */
function* nodes(n: unknown): Generator<Node> {
    if (n === null || typeof n !== "object") return;
    if (Array.isArray(n)) { for (const x of n) yield* nodes(x); return; }
    if (typeof (n as Node).type === "string") yield n as Node;
    for (const v of Object.values(n)) yield* nodes(v);
}

/** The constant a node folds to: a literal, a negated number, or arithmetic over constants; undefined otherwise. */
function fold(n: Node): unknown {
    if (!n || typeof n !== "object") return undefined;
    if (n.type === "Lit") return n.value;
    if (n.type === "Unary" && n.op === "-") { const v = fold(n.arg); return typeof v === "number" ? -v : undefined; }
    if (n.type === "Binary" && ARITH.has(n.op)) {
        const a = fold(n.left), b = fold(n.right);
        if (n.op === "+" && (typeof a === "string" || typeof b === "string") && a !== undefined && b !== undefined) return String(a) + String(b);
        if (typeof a !== "number" || typeof b !== "number") return undefined;
        const v = n.op === "+" ? a + b : n.op === "-" ? a - b : n.op === "*" ? a * b : n.op === "/" ? a / b : a % b;
        return Number.isFinite(v) ? v : undefined;
    }
    return undefined;
}

/** The field `n` reads of the parameter `c`, when it is `c.<field>` exactly. */
const fieldOf = (n: Node, c: string): string | undefined =>
    n?.type === "Member" && !n.computed && n.obj?.type === "Ident" && n.obj.name === c && typeof n.prop === "string" ? n.prop : undefined;

/** The operands of an `&&` chain, flattened. */
function conjuncts(n: Node): Node[] {
    return n?.type === "Logical" && n.op === "&&" ? [...conjuncts(n.left), ...conjuncts(n.right)] : [n];
}

/** `c.<field> op constant` in either order, as field, op (the field on the left) and value. */
function comparison(n: Node, c: string): { field: string; op: string; value: unknown } | undefined {
    if (n?.type !== "Binary" || !COMPARE.has(n.op)) return undefined;
    const flip: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "===": "===", "!==": "!==" };
    const l = fieldOf(n.left, c), r = fieldOf(n.right, c);
    if (l && !r) { const v = fold(n.right); return v === undefined ? undefined : { field: l, op: n.op, value: v }; }
    if (r && !l) { const v = fold(n.left); return v === undefined ? undefined : { field: r, op: flip[n.op], value: v }; }
    return undefined;
}

/**
 * The constants a policy's source names, or null when it does not parse (the evaluator says why).
 * @param source the policy, `(c) => …`
 */
export function policyLiterals(source: string): PolicyLiterals | null {
    let ast: Node;
    try { ast = new Parser(tokenize(source)).parseProgram(); } catch { return null; }
    const strings = new Set<string>(), numbers = new Set<number>(), keyNames = new Set<string>();
    const keyed: KeyedLiteral[] = [];
    const params = new Set<string>();
    for (const n of nodes(ast)) if (n.type === "Arrow" && typeof n.params?.[0] === "string") params.add(n.params[0]);
    for (const n of nodes(ast)) {
        const v = fold(n);
        if (typeof v === "string") strings.add(v);
        else if (typeof v === "number") numbers.add(v);
        if (n.type === "Template") for (const q of n.quasis ?? []) if (typeof q === "string" && q) strings.add(q);
        for (const c of params) {
            const cmp = comparison(n, c);
            if (cmp?.field === "key" && typeof cmp.value === "string" && (cmp.op === "===" || cmp.op === "!==")) keyNames.add(cmp.value);
            // ["a", "b"].includes(c.key)
            if (n.type === "Call" && n.callee?.type === "Member" && n.callee.prop === "includes" && n.callee.obj?.type === "Array"
                && n.args?.length === 1 && fieldOf(n.args[0], c) === "key")
                for (const e of n.callee.obj.elements ?? []) { const s = fold(e); if (typeof s === "string") keyNames.add(s); }
            if (n.type === "Logical" && n.op === "&&") {
                const parts = conjuncts(n).map((x) => comparison(x, c)).filter((x) => x !== undefined);
                const keys = parts.filter((x) => x.field === "key" && x.op === "===" && typeof x.value === "string");
                if (keys.length === 1) for (const x of parts)
                    if ((x.field === "from" || x.field === "to") && (x.value === null || ["string", "number", "boolean"].includes(typeof x.value)))
                        keyed.push({ key: keys[0].value as string, field: x.field, op: x.op, value: x.value as KeyedLiteral["value"] });
            }
        }
    }
    // A nested `&&` is a chain of its own too, so the same comparison can be met twice.
    const seen = new Set<string>();
    return { strings: [...strings], numbers: [...numbers], keyNames: [...keyNames], keyed: keyed.filter((k) => { const j = JSON.stringify(k); return seen.has(j) ? false : (seen.add(j), true); }) };
}

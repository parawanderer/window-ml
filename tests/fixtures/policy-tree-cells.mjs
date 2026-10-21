// policy-tree-cells.mjs — TEST-ONLY: evaluate a lifted policy tree over facts, and build one fact per cell its constants induce.
//
// Ruled 2026-10-21 (#927): the lifter's agreement test may use these, nothing in src/ imports them, and the oracle is the
// ORIGINAL source run through the real policy realm, never this evaluator. They move to src/ only with the tree itself.

const { effectSet } = await import("../../src/effects.ts");
const { CONSUMER_FIELDS, PAIR } = await import("../../src/readonly-exec/policy-lift.ts");

// --- the field types, by path ---

const EFFECT_FIELDS = { unknown: { t: "bool" }, pairs: { t: "list", elem: PAIR }, reads: { t: "list", elem: PAIR.fields.res }, writes: { t: "list", elem: PAIR.fields.res } };

/** The type at a field path under `t` (a number after argv is an argv element; "@" is the list element `elem`). A
 *  nullable field is its base type unless `nullable` asks for the wrapper, which the cells need to build its null. */
function typeAt(t, path, elem, nullable = false) {
    let cur = t;
    for (const seg of path) {
        if (seg === "@") { cur = elem; continue; }
        if (typeof seg === "number") { cur = { t: "str" }; continue; }
        if (cur.t === "nullable") cur = cur.of;
        cur = cur.t === "effects" ? EFFECT_FIELDS[seg] : cur.fields[seg];
    }
    return cur.t === "nullable" && !nullable ? cur.of : cur;
}

/** The value at a field path, `undefined` where it is missing. */
function valueAt(c, path, elem) {
    let cur = c;
    for (const seg of path) {
        if (seg === "@") { cur = elem; continue; }
        if (cur === null || cur === undefined) return undefined;
        cur = cur[seg];
    }
    return cur;
}

// --- the evaluator ---

/**
 * A tree's value over facts as the policy realm gives them (`effects` already the effect set's view). `root` is the
 * consumer's type, `elem`/`elemType` the current list element inside `some`/`every`.
 */
export function evalTree(tree, c, root, elem, elemType) {
    const ev = (t) => evalTree(t, c, root, elem, elemType);
    const at = (f) => { const v = valueAt(c, f, elem); if (v === null) nullSeen = true; return v; };
    switch (tree.op) {
        case "all": return tree.of.every(ev);
        case "any": return tree.of.some(ev);
        case "not": return !ev(tree.of);
        case "is": return at(tree.field) === tree.value;
        case "oneOf": { const v = at(tree.field); return tree.values.some((x) => x === v); }
        case "startsWith": { const v = at(tree.field); return typeof v === "string" && tree.values.some((p) => v.startsWith(p)); }
        case "under": {
            const v = at(tree.field);
            if (typeof v !== "string") return false;
            const t = typeAt(root, tree.field, elemType).t;
            return t === "host" ? v.endsWith("." + tree.value) : v.startsWith(tree.value + "/");
        }
        case "argCount": return tree.values.includes(c.argv.length);
        case "some": case "every": {
            const list = at(tree.list);
            const et = typeAt(root, tree.list, elemType);
            const inner = et.t === "argv" ? { t: "str" } : et.elem;
            const f = (x) => { if (x === null) nullSeen = true; return evalTree(tree.test, c, root, x, inner); };
            return tree.op === "some" ? list.some(f) : list.every(f);
        }
        case "has": return c.effects.has(tree.effect, tree.kind);
        case "uses": return c.effects.uses(tree.name);
        case "unknown": return c.effects.unknown;
        default: throw new Error(`unknown node ${tree.op}`);
    }
}

/**
 * Whether a tree FIRES over facts with this effect: its value, except that an ALLOW whose evaluation read a fact that
 * is `null` (unknown) does not fire, the realm's rule (POLICIES.md, the tree's ruling of 2026-10-21). The reads are the
 * ones `evalTree` makes, in its order: `all`/`any` short-circuit as `&&`/`||` do, so a null the source never reached
 * is not read here either.
 */
export function treeVerdict(tree, c, root, effect) {
    nullSeen = false;
    const v = evalTree(tree, c, root);
    return v && !(effect === "allow" && nullSeen);
}
// state: test — whether the current treeVerdict's evaluation read a null; reset by each call.
let nullSeen = false;

// --- the cells ---

/** The facts every generated call starts from, per consumer; the cells then override what the tree reads. */
const BASE = {
    fetch: { kind: "fetch", url: "https://base.example/", host: "base.example", method: "GET", credentials: false, rendered: false, effects: [] },
    sh: {
        argv: ["prog"], program: { path: "/bin/prog", inRoot: false, version: null }, cwd: { path: "/r", inRoot: true },
        env: { set: [], free: true }, secrets: [], paths: [], repo: null, repoConfigRunsCode: false, effects: [], described: true,
        why: [], runner: false, mode: "host", sandboxed: false, placement: "host-plain",
    },
};
BASE.other = { ...BASE.sh, ...BASE.fetch };

/** Every atom in a tree with the field it reads, as an absolute path (an element's path after its list's, at "@"). */
function atoms(tree, list = [], out = []) {
    const abs = (f) => (f[0] === "@" ? [...list, "@", ...f.slice(1)] : f);
    switch (tree.op) {
        case "all": case "any": tree.of.forEach((t) => atoms(t, list, out)); break;
        case "not": atoms(tree.of, list, out); break;
        case "some": case "every": out.push({ op: "list", field: abs(tree.list) }); atoms(tree.test, abs(tree.list), out); break;
        default: out.push({ ...tree, field: tree.field ? abs(tree.field) : undefined });
    }
    return out;
}

/** One representative per cell of a scalar field, from the constants the atoms on it name. */
function reps(type, onField) {
    const t = type.t === "nullable" ? type.of.t : type.t;
    const out = [];
    for (const a of onField) {
        if (a.op === "is") out.push(a.value, ...(typeof a.value === "string" ? [a.value + "x"] : []));
        if (a.op === "oneOf") for (const v of a.values) out.push(v, ...(typeof v === "string" ? [v + "x"] : []));
        if (a.op === "startsWith") for (const p of a.values) out.push(p, p + "x", p.slice(0, -1));
        if (a.op === "under") {
            if (t === "host") out.push(a.value, "x." + a.value, "x" + a.value);
            else out.push(a.value, a.value + "/", a.value + "/x", a.value + "x");
        }
    }
    if (t === "bool") out.push(true, false);
    else if (t === "num") out.push(0, 1);
    else if (t === "enum") out.push(...type.values, "zz");
    else out.push(t === "host" ? "other.example" : t === "url" ? "https://other.example/" : t === "path" ? "/elsewhere" : "zz");
    if (type.t === "nullable") out.push(null);
    return [...new Map(out.map((v) => [JSON.stringify(v), v])).values()];
}

/** Every combination of the choices, as objects (a cartesian product), refusing past `cap`. */
function product(choices, cap) {
    const keys = Object.keys(choices);
    const size = keys.reduce((n, k) => n * choices[k].length, 1);
    if (size > cap) throw new Error(`the cells number ${size}, past the test's cap of ${cap}`);
    let out = [{}];
    for (const k of keys) out = out.flatMap((o) => choices[k].map((v) => ({ ...o, [k]: v })));
    return out;
}

/** Lists of 0, 1 or 2 elements drawn from `elems` (ordered, with repeats). */
const lists = (elems) => [[], ...elems.map((e) => [e]), ...elems.flatMap((a) => elems.map((b) => [a, b]))];

/** Set a value at a path in a deep copy's own objects (creating none: the base holds every object the tree reads). */
function setAt(o, path, v) {
    let cur = o;
    for (const seg of path.slice(0, -1)) { cur[seg] = Array.isArray(cur[seg]) ? [...cur[seg]] : { ...cur[seg] }; cur = cur[seg]; }
    cur[path.at(-1)] = v;
}

/**
 * One fact per combination of the cells a tree's constants induce, for `consumer`. Each field the tree reads takes one
 * representative per cell; a list (argv, a list fact, the effect set) takes every list of up to two elements built
 * from its element's representatives. Throws past `cap`, so a tree too big to enumerate fails loudly, never sampled.
 */
export function cells(tree, consumer, cap = 400_000) {
    const root = CONSUMER_FIELDS[consumer];
    const all = atoms(tree);
    const key = (f) => JSON.stringify(f);
    const choices = {};
    const listPaths = new Map();
    let argv = null, effects = false;
    for (const a of all) {
        if (["has", "uses", "unknown"].includes(a.op)) { effects = true; continue; }
        if (a.op === "argCount" || (a.field && a.field[0] === "argv")) { argv ??= []; argv.push(a); continue; }
        if (a.field && a.field[0] === "effects") { effects = true; continue; }
        const at = a.field.indexOf("@");
        if (a.op === "list" || at >= 0) {
            const lp = at >= 0 ? a.field.slice(0, at) : a.field;
            if (!listPaths.has(key(lp))) listPaths.set(key(lp), { path: lp, atoms: [] });
            if (at >= 0) listPaths.get(key(lp)).atoms.push({ ...a, sub: a.field.slice(at + 1) });
            continue;
        }
        (choices[key(a.field)] ??= { path: a.field, atoms: [] }).atoms.push(a);
    }
    const dims = {};
    for (const [k, { path, atoms: on }] of Object.entries(choices)) dims[k] = reps(typeAt(root, path, undefined, true), on).map((v) => [[path, v]]);
    for (const [k, { path, atoms: on }] of listPaths) {
        const elemType = typeAt(root, path).elem;
        dims[k] = lists(elementReps(elemType, on)).map((l) => [[path, l]]);
    }
    if (argv) dims.argv = argvReps(argv).map((l) => [["argv"], l]).map((x) => [x]);
    if (effects) dims.effects = effectReps(all).map((e) => [[["effects"], e]]);
    return product(dims, cap).map((pick) => {
        const f = structuredClone(BASE[consumer]);
        for (const sets of Object.values(pick)) for (const [path, v] of sets) setAt(f, path, v);
        return f;
    });
}

/** Representatives of a list's element: every combination of its read fields' cells. */
function elementReps(elemType, on) {
    if (elemType.t !== "obj") return reps(elemType, on.filter((a) => a.sub.length === 0));
    const bySub = {};
    for (const a of on) if (a.sub.length) (bySub[a.sub.join(".")] ??= []).push(a);
    const dims = Object.fromEntries(Object.entries(bySub).map(([s, as]) => [s, reps(typeAt(elemType, s.split("."), undefined, true), as)]));
    const base = Object.fromEntries(Object.keys(elemType.fields).map((f) => [f, defaultFor(elemType.fields[f])]));
    return product(dims, 10_000).map((pick) => {
        const e = structuredClone(base);
        for (const [s, v] of Object.entries(pick)) setAt(e, s.split("."), v);
        return e;
    });
}

/** A plain value of a type, for the fields a tree does not read. */
function defaultFor(t) {
    switch (t.t) {
        case "bool": return false;
        case "num": return 0;
        case "enum": return t.values[0];
        case "nullable": return null;
        case "obj": return Object.fromEntries(Object.entries(t.fields).map(([k, v]) => [k, defaultFor(v)]));
        case "list": return [];
        case "path": return "/base";
        default: return "base";
    }
}

/** argv: every length up to two past the highest position or count named, each position from its own cells. */
function argvReps(on) {
    const strs = [];
    let maxPos = -1, maxCount = 0;
    for (const a of on) {
        if (a.op === "argCount") { maxCount = Math.max(maxCount, ...a.values); continue; }
        if (typeof a.field[1] === "number") maxPos = Math.max(maxPos, a.field[1]);
        strs.push(...reps({ t: "str" }, [a]));
    }
    const elems = [...new Set([...strs, "zz"])];
    // Every position up to one past the highest named takes every cell; further positions only pad to a count.
    const free = Math.max(maxPos + 2, 2), maxLen = Math.max(free, maxCount + 1);
    let out = [[]];
    const all = [[]];
    for (let len = 1; len <= maxLen; len++) {
        out = out.flatMap((l) => (len <= free ? elems : ["zz"]).map((e) => [...l, e]));
        all.push(...out);
    }
    return all;
}

/** The effect set: unknown, or every list of up to two pairs built from the operations, kinds and resource fields named. */
function effectReps(all) {
    const ops = new Set(["read", "write"]), kinds = new Set(["fs", "net"]);
    const resAtoms = [];
    for (const a of all) {
        if (a.op === "has") { ops.add(a.effect); if (a.kind) kinds.add(a.kind); }
        if (a.op === "uses") { ops.add("use"); kinds.add("secret"); resAtoms.push({ op: "is", value: a.name, sub: ["name"] }); }
        if (a.field && a.field[0] === "effects" && a.field.includes("@")) {
            const sub = a.field.slice(a.field.indexOf("@") + 1);
            if (sub[0] === "op") a.op === "is" ? ops.add(a.value) : a.values?.forEach((v) => ops.add(v));
            else if (sub[0] === "res" && sub[1] === "kind" || sub[0] === "kind") a.op === "is" ? kinds.add(a.value) : a.values?.forEach((v) => kinds.add(v));
            else resAtoms.push({ ...a, sub: sub[0] === "res" ? sub.slice(1) : sub });
        }
    }
    const bySub = {};
    for (const a of resAtoms) (bySub[a.sub.join(".")] ??= []).push(a);
    const resDims = Object.fromEntries(Object.entries(bySub).map(([s, as]) => [s, [...reps(typeAt(PAIR.fields.res, [s]), as), undefined]]));
    // Each kind's own field is always set (the algebra requires it), unless a cell names its value.
    const OWN = { net: ["host", "base.example"], fs: ["path", "/base"], secret: ["name", "base"], heap: ["of", "owned"] };
    const resources = product({ kind: [...kinds], ...resDims }, 10_000).map((r) => {
        const own = OWN[r.kind];
        return own && r[own[0]] === undefined ? { ...r, [own[0]]: own[1] } : r;
    });
    const pairs = [...ops].flatMap((op) => resources.map((res) => ({ op, res })));
    return ["unknown", ...lists(pairs)];
}

/** The facts as the tree evaluator reads them: the effect data as the policy realm's view of it. */
export const asView = (facts) => ({ ...facts, effects: effectSet(facts.effects) });

// state-watch.ts — WATCHES over a run's state (docs/spec/STATE_INSPECTOR.md, "Watches"): an expression you pin in the
// Run state panel, re-read with it. Pure, so the worker evaluates it beside the snapshot it reads and a test enumerates it.
//
// A watch is the same expression the panel names a member by, and that "Copy path" copies: `inspector.run.init.task`,
// `ml.current.messages[0].text`. Under it is RFC 9535 JSONPath over one tree built from the snapshot (`{ ml: { current },
// inspector }`), so a watch may also be any JSONPath (`$.inspector.run.pointers[?@.rows > 1000].label`). No evaluator of
// its own and no `eval`: the JSONPath module is the one the read-only dialect hands a model, with the same two bounds,
// every node visited charged to a budget, and a regex that could backtrack for hours refused before it is compiled.

import { mlJsonPath, type JsonPathNode } from "./json-path";
import { riskyRegex } from "./readonly-exec/limits";
import type { StateEntry, StateMember } from "./state-registry";
import type { UserWatch } from "./agent/current-context";

/** How many watches a panel may ask for at once: a list a person keeps, not a script. */
export const MAX_WATCHES = 32;
/** The longest watch expression accepted: a path or a query, never a program. */
export const MAX_WATCH_CHARS = 1024;
/** Nodes one watch may visit before it is stopped. A path visits a handful; `$..*` over a big context visits them all. */
export const WATCH_NODE_BUDGET = 200_000;

/** One watch's answer. A JSONPath watch has `nodes` (each with its normalized path); a JS watch has `value`, and `at`
 *  when the expression is a plain path (so its rows copy and watch in turn); either may instead have an `error`. */
export interface WatchResult {
    expr: string;
    nodes?: JsonPathNode[];
    value?: unknown;
    /** The expression itself, when it is a plain path to the value: what the value's rows extend. */
    at?: string;
    error?: string;
}

/** Evaluates a JS watch: the read-only dialect, with `inspector` bound and `ml.current` the live snapshot. Injected, so
 *  this module stays pure and the worker supplies the evaluator. */
export type WatchJs = (code: string, inspector: unknown) => Promise<unknown>;

/** A plain path from a watch root: dots, indexes and quoted keys only. Its value's rows can be named by extending it. */
const PLAIN_PATH = /^(?:ml\.current|inspector)(?:\.[A-Za-z_$][\w$]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\])*$/;

/** The roots a watch may start from. Anything else is a typo, said as one rather than evaluated as "no match". */
const ROOTS = /^(?:ml\.current|inspector)(?:$|[.[])/;

/**
 * The query a watch expression stands for: a panel path gets `$.` in front, a JSONPath is itself.
 * @param expr what was typed or copied
 * @returns the JSONPath, or an error sentence
 */
export function watchQuery(expr: string): { query: string } | { error: string } {
    const e = expr.trim();
    if (!e) return { error: "an empty watch" };
    if (e.length > MAX_WATCH_CHARS) return { error: `longer than ${MAX_WATCH_CHARS} characters` };
    if (e.startsWith("$")) return { query: e };
    if (ROOTS.test(e)) return { query: `$.${e}` };
    return { error: "a watch starts at inspector. or ml.current. (as the panel names its members), or is a JSONPath starting at $" };
}

/**
 * The one tree every watch reads. `inspector` holds each member the model does not read, at its id (dotted, so it nests:
 * `inspector.run.init`). `ml.current` is the LIVE SNAPSHOT the model reads, exactly, and is absent between turns, when
 * the model has none: a watch is about what is true now, so it never reads the panel's previews in its place.
 * @param members the members to place
 * @param entries what they hold
 * @param current the live turn's `ml.current`, when a turn is running
 */
export function stateTree(members: readonly StateMember[], entries: readonly StateEntry[], current?: unknown): Record<string, unknown> {
    const tree: Record<string, unknown> = { ...(current !== undefined ? { ml: { current } } : {}), inspector: {} };
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const m of members) {
        const e = byId.get(m.id);
        if (!e || e.error || m.exposedAs) continue;
        const keys = `inspector.${m.id}`.split(".");
        let at = tree;
        for (const k of keys.slice(0, -1)) at = (at[k] ??= {}) as Record<string, unknown>;
        at[keys[keys.length - 1]] = e.value;
    }
    // JSON, as a watch reads it: a member's `undefined` fields are left out (the evaluator takes JSON only), exactly
    // as copying the member would leave them out.
    return JSON.parse(JSON.stringify(tree)) as Record<string, unknown>;
}

/** The SHAPE of a watch tree: its keys and kinds without its values, which is what completing a watch needs and all a
 *  panel is sent of the live `ml.current`. An array is described by its first element. */
export type WatchShape =
    | { t: "object"; keys: Record<string, WatchShape>; more?: number }
    | { t: "array"; n: number; item?: WatchShape }
    | { t: "string" | "number" | "boolean" | "null" };

/** Keys described per object; the rest are counted in `more`. */
const SHAPE_KEYS = 100;
/** Nodes described in all: past it an object or array is cut to its kind. A context of hundreds of messages is
 *  described by its first one, so this is a guard, not a number a real tree reaches. */
const SHAPE_NODES = 4000;
/** How deep a shape goes. */
const SHAPE_DEPTH = 10;

/**
 * The shape of a tree from {@link stateTree}, bounded in keys, nodes and depth.
 * @param v the tree, or any JSON value in it
 */
export function treeShape(v: unknown): WatchShape {
    let budget = SHAPE_NODES;
    const walk = (x: unknown, depth: number): WatchShape => {
        budget--;
        if (x === null || x === undefined) return { t: "null" };
        if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") return { t: typeof x as "string" | "number" | "boolean" };
        const deeper = depth < SHAPE_DEPTH && budget > 0;
        if (Array.isArray(x)) return { t: "array", n: x.length, ...(deeper && x.length ? { item: walk(x[0], depth + 1) } : {}) };
        const keys: Record<string, WatchShape> = {};
        const all = Object.keys(x as object);
        if (deeper) for (const k of all.slice(0, SHAPE_KEYS)) { if (budget <= 0) break; keys[k] = walk((x as Record<string, unknown>)[k], depth + 1); }
        const more = all.length - Object.keys(keys).length;
        return { t: "object", keys, ...(more ? { more } : {}) };
    };
    return walk(v, 0);
}

/**
 * Evaluate one watch. `$…` is JSONPath over the tree, bounded as the dialect bounds a model's `ml.jsonPath`; anything
 * else is a JS expression through `js` (the read-only dialect). With no `js`, a panel path is read as JSONPath, which
 * answers the same for a path.
 * @param tree from {@link stateTree}
 * @param expr the watch
 * @param js the JS evaluator, in the worker
 */
export async function evalWatch(tree: Record<string, unknown>, expr: string, js?: WatchJs): Promise<WatchResult> {
    const e = expr.trim();
    if (!e) return { expr, error: "an empty watch" };
    if (e.length > MAX_WATCH_CHARS) return { expr, error: `longer than ${MAX_WATCH_CHARS} characters` };
    if (js && !e.startsWith("$")) {
        try {
            const value = await js(e, tree.inspector);
            return { expr, value, ...(PLAIN_PATH.test(e) ? { at: e } : {}) };
        } catch (err) {
            return { expr, error: err instanceof Error ? err.message : String(err) };
        }
    }
    const q = watchQuery(e);
    if ("error" in q) return { expr, error: q.error };
    let spent = 0;
    try {
        const nodes = mlJsonPath(tree, q.query, { paths: true }, {
            charge: (n) => { if ((spent += n) > WATCH_NODE_BUDGET) throw new Error(`stopped after visiting ${WATCH_NODE_BUDGET.toLocaleString("en")} values: narrow it`); },
            onPattern: (src) => { const why = riskyRegex(src); if (why) throw new Error(`the pattern ${JSON.stringify(src)} has ${why}, which can run for hours`); },
        }) as JsonPathNode[];
        return { expr, nodes };
    } catch (err) {
        return { expr, error: err instanceof Error ? err.message : String(err) };
    }
}

/** Where the panel keeps the expressions it shares with the model, a subset of its watches; read by the worker
 *  (sw-shared-watches.ts). Written only by an extension page. */
export const SHARED_WATCHES_KEY = "ml_runstate_shared";
/** How many watches may be shared with the model at once. Each is evaluated for every survey that reads `ml.current`. */
export const MAX_SHARED_WATCHES = 8;
/** The largest shared value, as JSON characters. A watch on `ml.current.messages` would otherwise hand the model its
 *  whole context a second time. */
export const SHARED_VALUE_CHARS = 4000;

/**
 * May this watch be shared with the model? Only one that reads nothing but `ml.current`: `inspector` is the person's
 * half of the state, which the audience rule keeps from the model. A string that merely contains the word is refused too,
 * which is the safe way to be wrong. The worker does not rely on this: a shared watch is evaluated over a tree that has
 * no `inspector` in it at all ({@link evalShared}).
 * @param expr the watch
 */
export function shareable(expr: string): boolean {
    return !/\binspector\b/.test(expr);
}

/**
 * The shared watches, as the model is given them: each over the MODEL's half of the state alone (`{ ml: { current } }`),
 * so a watch cannot carry a member the model may not read into its context, whatever it says.
 * @param current the snapshot the model reads, without `debug`
 * @param exprs the shared expressions
 * @param js the JS evaluator, binding nothing but `ml.current`
 */
export async function evalShared(current: unknown, exprs: readonly string[], js: WatchJs | undefined): Promise<UserWatch[]> {
    const tree = JSON.parse(JSON.stringify({ ml: { current } })) as Record<string, unknown>;
    const out: UserWatch[] = [];
    for (const expression of exprs.slice(0, MAX_SHARED_WATCHES)) {
        if (!shareable(expression)) { out.push({ expression, error: "reads inspector., which the model does not have" }); continue; }
        const r = await evalWatch(tree, expression, js);
        if (r.error) { out.push({ expression, error: r.error }); continue; }
        const value = r.nodes ? r.nodes.map((n) => n.value) : r.value;
        const chars = value === undefined ? 0 : JSON.stringify(value)?.length ?? 0;
        out.push(chars > SHARED_VALUE_CHARS
            ? { expression, error: `its value is ${chars} characters, over the ${SHARED_VALUE_CHARS} a shared watch may carry` }
            : { expression, ...(value === undefined ? {} : { value }) });
    }
    return out;
}

/**
 * The watches a panel sent, made safe to evaluate: strings only, at most {@link MAX_WATCHES}, duplicates dropped.
 * @param raw the payload's `watches`
 */
export function watchList(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const w of raw) if (typeof w === "string" && !out.includes(w) && out.length < MAX_WATCHES) out.push(w);
    return out;
}

/**
 * A normalized path (`$['ml']['current']['messages'][0]`) written the way the panel names things
 * (`ml.current.messages[0]`), so a row inside a watch copies and watches like any other row.
 * @param normalized an RFC 9535 normalized path, as a match reports it
 */
export function panelPath(normalized: string): string {
    let out = "";
    for (const m of normalized.slice(1).matchAll(/\['((?:[^'\\]|\\.)*)'\]|\[(\d+)\]/g)) {
        if (m[2] != null) { out += `[${m[2]}]`; continue; }
        const key = m[1].replace(/\\(.)/g, "$1");
        out += /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${out ? "." : ""}${key}` : `[${JSON.stringify(key)}]`;
    }
    return out;
}

/** Steps one JS watch may take: a fraction of a survey's, since a panel re-reads every watch every two seconds. */
export const WATCH_STEPS = 20_000;
